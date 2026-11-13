<?php

namespace Tests\Feature;

use App\Models\Design;
use App\Models\DesignVersion;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Tests\TestCase;

class ObservabilityAndLimitsTest extends TestCase
{
    use RefreshDatabase;

    private function sampleDoc(): array
    {
        return [
            'schemaVersion' => 1,
            'id' => 'obs-design',
            'name' => 'Observability Test',
            'nodes' => [
                [
                    'id' => 'client',
                    'serviceId' => 'generic.client',
                    'label' => 'Client',
                    'position' => ['x' => 10, 'y' => 10],
                    'config' => ['instances' => 1],
                ],
            ],
            'edges' => [],
            'groups' => [],
            'network' => new \stdClass,
            'scenarios' => [],
            'scripts' => [],
            'fixtures' => [],
            'settings' => ['seed' => 42, 'currency' => 'USD'],
        ];
    }

    public function test_every_api_response_includes_request_id_header(): void
    {
        // Auto-generated UUID
        $res1 = $this->getJson('/api/health');
        $res1->assertOk();
        $this->assertTrue($res1->headers->has('X-Request-Id'));
        $this->assertNotEmpty($res1->headers->get('X-Request-Id'));

        // Client-supplied request ID propagated
        $customId = 'req-trace-canary-12345';
        $res2 = $this->withHeaders(['X-Request-Id' => $customId])->getJson('/api/health');
        $res2->assertOk();
        $this->assertSame($customId, $res2->headers->get('X-Request-Id'));
    }

    public function test_structured_http_request_is_logged_without_secrets(): void
    {
        Log::spy();

        $this->getJson('/api/health');

        Log::shouldHaveReceived('info')->withArgs(function (string $message, array $context): bool {
            return $message === 'http_request'
                && isset($context['request_id'])
                && isset($context['method'])
                && isset($context['status'])
                && isset($context['duration_ms'])
                && ! isset($context['password'])
                && ! isset($context['token']);
        });
    }

    public function test_design_store_rejects_payload_exceeding_2_mb(): void
    {
        $user = User::factory()->create();

        // Construct a synthetic oversized payload > 2 MB
        $hugeString = str_repeat('A', 2_200_000);
        $doc = $this->sampleDoc();
        $doc['heavy'] = $hugeString;

        $res = $this->actingAs($user)
            ->postJson('/api/designs', [
                'name' => 'Too Large Design',
                'doc' => $doc,
            ]);

        $res->assertStatus(413);
        $this->assertStringContainsString('2 MB', $res->json('message'));
    }

    public function test_prune_design_versions_command_retains_latest_n_snapshots(): void
    {
        $user = User::factory()->create();
        $design = Design::create([
            'user_id' => $user->id,
            'name' => 'Pruning Target',
            'doc' => $this->sampleDoc(),
            'version' => 10,
        ]);

        for ($v = 1; $v <= 10; $v++) {
            DesignVersion::create([
                'design_id' => $design->id,
                'version' => $v,
                'doc' => array_merge($this->sampleDoc(), ['v' => $v]),
            ]);
        }

        $this->assertSame(10, DesignVersion::where('design_id', $design->id)->count());

        // Keep only latest 3 versions
        $this->artisan('designs:prune-versions --keep=3')
            ->expectsOutputToContain('Pruned 7 version(s)')
            ->assertSuccessful();

        $remainingVersions = DesignVersion::where('design_id', $design->id)
            ->orderBy('version')
            ->pluck('version')
            ->all();

        $this->assertSame([8, 9, 10], $remainingVersions);
    }
}
