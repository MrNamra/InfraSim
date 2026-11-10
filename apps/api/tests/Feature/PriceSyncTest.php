<?php

namespace Tests\Feature;

use App\Models\Price;
use App\Models\PriceSnapshot;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Tests\TestCase;

class PriceSyncTest extends TestCase
{
    use RefreshDatabase;

    public function test_aws_fixture_sync_normalizes_prices_tiers_attributes_and_exclusions(): void
    {
        $fixture = base_path('tests/Fixtures/pricing/aws_offer_sample.json');

        $this->artisan('prices:sync', [
            '--provider' => 'aws',
            '--regions' => 'us-east-1',
            '--file' => $fixture,
        ])->assertExitCode(0);

        $snapshot = PriceSnapshot::query()->where('provider', 'aws')->firstOrFail();
        $this->assertSame(PriceSnapshot::STATUS_PUBLISHED, $snapshot->status);

        // Windows EC2 excluded, Linux t3.micro included with vCPU & memory attrs.
        $ec2Micro = Price::query()
            ->where('snapshot_id', $snapshot->id)
            ->where('service_id', 'aws.ec2')
            ->where('sku_key', 't3.micro')
            ->get();
        $this->assertCount(1, $ec2Micro);
        $this->assertEqualsWithDelta(0.0104, $ec2Micro->first()->unit_price, 0.00001);
        $this->assertSame(2, $ec2Micro->first()->attrs['vcpu']);
        $this->assertEqualsWithDelta(1.0, $ec2Micro->first()->attrs['memoryGb'], 0.01);

        // Lambda requests scaled from singular "Requests" to "1M Requests".
        $lambdaReq = Price::query()
            ->where('snapshot_id', $snapshot->id)
            ->where('service_id', 'aws.lambda')
            ->where('unit', '1M Requests')
            ->firstOrFail();
        $this->assertEqualsWithDelta(0.20, $lambdaReq->unit_price, 0.0001);
        $this->assertDatabaseMissing('prices', [
            'snapshot_id' => $snapshot->id,
            'sku_key' => 'Lambda-Managed-Instances-c9g.24xlarge-Management-Hours',
        ]);

        // Outposts & ReservedLCU excluded on ALB.
        $this->assertDatabaseMissing('prices', [
            'snapshot_id' => $snapshot->id,
            'sku_key' => 'Outposts-LoadBalancerUsage',
        ]);
        $this->assertDatabaseMissing('prices', [
            'snapshot_id' => $snapshot->id,
            'sku_key' => 'ReservedLCUUsage',
        ]);

        // S3 tiered pricing preserved cleanly.
        $s3Tiers = Price::query()
            ->where('snapshot_id', $snapshot->id)
            ->where('service_id', 'aws.s3')
            ->where('unit', 'GB-Mo')
            ->orderBy('tier_min')
            ->get();
        $this->assertCount(3, $s3Tiers);
        $this->assertEqualsWithDelta(51200.0, $s3Tiers[0]->tier_max, 0.1);
        $this->assertNull($s3Tiers[2]->tier_max);

        // Distinct transfer categories stored cleanly.
        $this->assertDatabaseHas('prices', [
            'snapshot_id' => $snapshot->id,
            'service_id' => 'transfer.inter_az',
            'region' => 'us-east-1',
        ]);
        $this->assertDatabaseHas('prices', [
            'snapshot_id' => $snapshot->id,
            'service_id' => 'transfer.nat_processing',
            'region' => 'us-east-1',
        ]);
    }

    public function test_azure_fixture_sync_paginates_derives_tiers_and_excludes_spot_windows_low_priority(): void
    {
        $fixture = base_path('tests/Fixtures/pricing/azure_retail_page1.json');

        $this->artisan('prices:sync', [
            '--provider' => 'azure',
            '--regions' => 'eastus',
            '--file' => $fixture,
        ])->assertExitCode(0);

        $snapshot = PriceSnapshot::query()->where('provider', 'azure')->firstOrFail();
        $this->assertSame(PriceSnapshot::STATUS_PUBLISHED, $snapshot->status);

        // Windows D2s v5 ($0.132) rejected while Linux D2s v5 ($0.096) retained; Spot & Low Priority rejected.
        $d2s = Price::query()
            ->where('snapshot_id', $snapshot->id)
            ->where('service_id', 'azure.vm')
            ->where('sku_key', 'Standard_D2s_v5')
            ->get();
        $this->assertCount(1, $d2s);
        $this->assertEqualsWithDelta(0.0960, $d2s->first()->unit_price, 0.0001);

        $b2s = Price::query()
            ->where('snapshot_id', $snapshot->id)
            ->where('service_id', 'azure.vm')
            ->where('sku_key', 'Standard_B2s')
            ->get();
        $this->assertCount(1, $b2s);
        $this->assertEqualsWithDelta(0.0416, $b2s->first()->unit_price, 0.0001);

        // Page 2 items (App Gateway, Postgres Flexible, Blob progressive tiers, Bandwidth).
        $blobTiers = Price::query()
            ->where('snapshot_id', $snapshot->id)
            ->where('service_id', 'azure.blob')
            ->where('sku_key', 'Hot LRS')
            ->orderBy('tier_min')
            ->get();
        $this->assertCount(3, $blobTiers);
        $this->assertEqualsWithDelta(0.0, $blobTiers[0]->tier_min, 0.01);
        $this->assertEqualsWithDelta(51200.0, $blobTiers[0]->tier_max, 0.01);
        $this->assertNull($blobTiers[2]->tier_max);

        $this->assertDatabaseHas('prices', [
            'snapshot_id' => $snapshot->id,
            'service_id' => 'azure.postgres_flexible',
            'sku_key' => 'Standard_B1ms',
        ]);
    }

    public function test_sync_is_idempotent_on_identical_hash_and_rolls_back_bad_payload(): void
    {
        $awsFixture = base_path('tests/Fixtures/pricing/aws_offer_sample.json');

        $this->artisan('prices:sync', ['--provider' => 'aws', '--regions' => 'us-east-1', '--file' => $awsFixture])
            ->assertExitCode(0);

        $firstCount = PriceSnapshot::query()->where('provider', 'aws')->count();
        $firstSnapshot = PriceSnapshot::query()->where('provider', 'aws')->where('status', 'published')->firstOrFail();

        // Identical hash skips creating a new snapshot.
        $this->artisan('prices:sync', ['--provider' => 'aws', '--regions' => 'us-east-1', '--file' => $awsFixture])
            ->expectsOutputToContain('status=skipped_unchanged')
            ->assertExitCode(0);

        $this->assertSame($firstCount, PriceSnapshot::query()->where('provider', 'aws')->count());

        // Malformed payload fails loudly (exit 1) and preserves previous published snapshot untouched.
        $badPath = sys_get_temp_dir().'/infrasim_bad_aws_'.uniqid().'.json';
        file_put_contents($badPath, '{"unexpected":"shape"}');

        try {
            $this->artisan('prices:sync', ['--provider' => 'aws', '--regions' => 'us-east-1', '--file' => $badPath])
                ->assertExitCode(1);
        } finally {
            @unlink($badPath);
        }

        $stillPublished = PriceSnapshot::query()
            ->where('provider', 'aws')
            ->where('status', PriceSnapshot::STATUS_PUBLISHED)
            ->firstOrFail();

        $this->assertSame($firstSnapshot->id, $stillPublished->id);
        $this->assertGreaterThan(0, Price::query()->where('snapshot_id', $stillPublished->id)->count());
    }

    public function test_anomaly_alerts_fire_on_large_price_swing_or_dropped_services(): void
    {
        Log::spy();

        $awsFixture = base_path('tests/Fixtures/pricing/aws_offer_sample.json');
        $this->artisan('prices:sync', ['--provider' => 'aws', '--regions' => 'us-east-1', '--file' => $awsFixture])
            ->assertExitCode(0);

        // Mutate fixture: double EC2 prices (>30% swing across >20% SKUs) AND drop AmazonRDS completely.
        $decoded = json_decode((string) file_get_contents($awsFixture), true, 512, JSON_THROW_ON_ERROR);
        unset($decoded['offers']['AmazonRDS']);
        foreach ($decoded['offers']['AmazonEC2']['terms']['OnDemand'] as $sku => &$terms) {
            foreach ($terms as &$term) {
                foreach ($term['priceDimensions'] as &$dim) {
                    $dim['pricePerUnit']['USD'] = (string) ((float) $dim['pricePerUnit']['USD'] * 2.5);
                }
            }
        }
        unset($terms, $term, $dim);

        $mutatedPath = sys_get_temp_dir().'/infrasim_mutated_aws_'.uniqid().'.json';
        file_put_contents($mutatedPath, json_encode($decoded, JSON_THROW_ON_ERROR));

        try {
            $this->artisan('prices:sync', ['--provider' => 'aws', '--regions' => 'us-east-1', '--file' => $mutatedPath])
                ->expectsOutputToContain('ALERT:')
                ->assertExitCode(0);
        } finally {
            @unlink($mutatedPath);
        }

        // Previous snapshot archived, new snapshot published, anomaly logged.
        $this->assertSame(1, PriceSnapshot::query()->where('provider', 'aws')->where('status', 'archived')->count());
        $this->assertSame(1, PriceSnapshot::query()->where('provider', 'aws')->where('status', 'published')->count());
        Log::shouldHaveReceived('warning')->atLeast()->once();
    }

    public function test_snapshot_endpoint_returns_compact_json_with_etag_304_and_coverage(): void
    {
        $this->artisan('prices:sync', [
            '--provider' => 'aws',
            '--regions' => 'us-east-1',
            '--file' => base_path('tests/Fixtures/pricing/aws_offer_sample.json'),
        ])->assertExitCode(0);

        $this->artisan('prices:sync', [
            '--provider' => 'azure',
            '--regions' => 'eastus',
            '--file' => base_path('tests/Fixtures/pricing/azure_retail_page1.json'),
        ])->assertExitCode(0);

        // Mark AWS snapshot stale (>7 days old) to verify staleness flag.
        PriceSnapshot::query()
            ->where('provider', 'aws')
            ->update(['fetched_at' => CarbonImmutable::now('UTC')->subDays(9)]);

        $res1 = $this->get('/api/prices/snapshot?providers=aws,azure&regions=us-east-1,eastus');
        $res1->assertOk();
        $etag = $res1->headers->get('ETag');
        $this->assertNotEmpty($etag);

        $json = json_decode((string) $res1->getContent(), true, 512, JSON_THROW_ON_ERROR);
        $this->assertTrue($json['providers']['aws']['stale']);
        $this->assertFalse($json['providers']['azure']['stale']);
        $this->assertNotEmpty($json['prices']);
        $this->assertNotEmpty($json['knownUnavailable']);

        // Conditional GET returns 304 Not Modified cleanly.
        $res304 = $this->withHeaders(['If-None-Match' => (string) $etag])
            ->get('/api/prices/snapshot?providers=aws,azure&regions=us-east-1,eastus');
        $res304->assertStatus(304);

        // Coverage endpoint confirms 100% AWS & Azure catalog coverage (0 missing non-free services).
        $covRes = $this->getJson('/api/prices/coverage');
        $covRes->assertOk()
            ->assertJsonPath('providers.aws.nonFreeServices', 74)
            ->assertJsonPath('providers.aws.missingServiceIds', [])
            ->assertJsonPath('providers.azure.nonFreeServices', 61)
            ->assertJsonPath('providers.azure.missingServiceIds', []);

        // Sync endpoint requires Sanctum authentication.
        $this->postJson('/api/prices/sync', ['provider' => 'aws'])->assertUnauthorized();

        // Sync endpoint stays disabled when PRICE_SYNC_ENABLED is false.
        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;
        $this->withToken($token)->postJson('/api/prices/sync', ['provider' => 'aws'])->assertForbidden();
    }
}
