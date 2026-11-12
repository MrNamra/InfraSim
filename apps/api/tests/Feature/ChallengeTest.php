<?php

namespace Tests\Feature;

use App\Models\Challenge;
use App\Models\Price;
use App\Models\PriceSnapshot;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ChallengeTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return array{challenge: Challenge, starterDesign: array<string, mixed>, passingDesign: array<string, mixed>}
     */
    private function seedChallengeWithPrices(): array
    {
        $snapshot = PriceSnapshot::create([
            'provider' => 'aws',
            'fetched_at' => now(),
            'source_url' => 'https://example.test/prices',
            'raw_hash' => hash('sha256', 'aws-test'),
            'status' => PriceSnapshot::STATUS_PUBLISHED,
        ]);

        Price::create([
            'snapshot_id' => $snapshot->id,
            'provider' => 'aws',
            'service_id' => 'aws.ec2',
            'sku_key' => 't3.micro',
            'region' => 'us-east-1',
            'unit' => 'hour',
            'unit_price' => 0.0104,
            'currency' => 'USD',
            'tier_min' => null,
            'tier_max' => null,
            'attrs' => ['unitRole' => 'instance-hour', 'vcpu' => 2, 'memoryGb' => 1],
        ]);

        $starterDesign = [
            'schemaVersion' => 1,
            'id' => 'ch-first-blood',
            'name' => 'Starter',
            'version' => 1,
            'groups' => [],
            'network' => new \stdClass(),
            'settings' => ['region' => 'us-east-1', 'seed' => 101, 'includeFreeTier' => true],
            'nodes' => [
                [
                    'id' => 'client',
                    'serviceId' => 'generic.client',
                    'label' => 'Client',
                    'position' => ['x' => 0, 'y' => 0],
                    'config' => ['instances' => 1, 'operations' => new \stdClass()],
                ],
                [
                    'id' => 'api',
                    'serviceId' => 'aws.ec2',
                    'label' => 'API',
                    'position' => ['x' => 240, 'y' => 0],
                    'config' => [
                        'instances' => 1,
                        'instanceType' => 't3.micro',
                        'vcpu' => 1,
                        'maxInFlightPerInstance' => 10,
                        'cpuMsPerRequest' => 15,
                        'queue' => ['maxLength' => 20, 'policy' => 'reject'],
                        'latency' => ['distribution' => 'fixed', 'p50' => 25, 'p95' => 35],
                        'operations' => new \stdClass(),
                    ],
                ],
            ],
            'edges' => [
                [
                    'id' => 'e1',
                    'from' => 'client',
                    'to' => 'api',
                    'protocol' => 'https',
                    'callType' => 'sync',
                    'weight' => 1,
                ],
            ],
            'scenarios' => [],
            'scripts' => [],
            'fixtures' => [],
        ];

        $passingDesign = $starterDesign;
        $passingDesign['nodes'][1]['az'] = 'multi-az';
        $passingDesign['nodes'][1]['config']['instances'] = 4;
        $passingDesign['nodes'][1]['config']['maxInFlightPerInstance'] = 40;
        $passingDesign['nodes'][1]['config']['vcpu'] = 2;
        $passingDesign['nodes'][1]['config']['cluster'] = true;

        $fixedScenario = [
            'id' => 'ch-scen',
            'name' => '200 RPS Spike',
            'durationS' => 6,
            'entryNodeId' => 'client',
            'profile' => ['kind' => 'constant', 'rps' => 200],
            'flows' => [
                [
                    'id' => 'f1',
                    'name' => 'GET',
                    'weight' => 1,
                    'steps' => [['method' => 'GET', 'path' => '/items']],
                ],
            ],
            'chaos' => [],
        ];

        $challenge = Challenge::create([
            'slug' => 'first-blood',
            'title' => 'First Blood',
            'difficulty' => 'beginner',
            'published' => true,
            'definition' => [
                'slug' => 'first-blood',
                'title' => 'First Blood',
                'difficulty' => 'beginner',
                'story' => 'A single small server falls over at 200 RPS.',
                'learningGoals' => ['Horizontal scaling', 'Multi-AZ resilience'],
                'starterDesign' => $starterDesign,
                'allowedServices' => ['aws.*'],
                'fixedScenario' => $fixedScenario,
                'fixedSeed' => 101,
                'pinnedPriceSnapshotId' => (string) $snapshot->id,
                'constraints' => [
                    'maxMonthlyCostUsd' => 100,
                    'p95MsMax' => 300,
                    'errorRateMax' => 0.02,
                    'requiredCapabilities' => ['multi-az'],
                ],
                'scoring' => [
                    'weights' => [
                        'latency' => 0.3,
                        'cost' => 0.25,
                        'resilience' => 0.25,
                        'security' => 0.1,
                        'simplicity' => 0.1,
                    ],
                ],
                'hints' => [
                    ['afterAttempts' => 1, 'text' => 'Add more instances across multiple AZs.'],
                ],
                'whatThisTeaches' => 'Scaling horizontally removes single-instance queuing delays.',
                'referenceSolutionDesign' => $passingDesign,
                'published' => true,
            ],
        ]);

        return compact('challenge', 'starterDesign', 'passingDesign');
    }

    public function test_unauthenticated_attempts_and_reveal_are_rejected(): void
    {
        $seeded = $this->seedChallengeWithPrices();

        $this->postJson('/api/challenges/first-blood/attempts', [
            'design' => $seeded['starterDesign'],
        ])->assertUnauthorized();

        $this->postJson('/api/challenges/first-blood/reveal')->assertUnauthorized();
    }

    public function test_public_endpoints_omit_reference_solution_until_solved_or_revealed(): void
    {
        $this->seedChallengeWithPrices();

        $listRes = $this->getJson('/api/challenges')->assertOk()->assertJsonCount(1, 'challenges');
        $this->assertArrayNotHasKey('referenceSolutionDesign', $listRes->json('challenges.0.definition'));

        $showRes = $this->getJson('/api/challenges/first-blood')->assertOk();
        $this->assertArrayNotHasKey('referenceSolutionDesign', $showRes->json('challenge.definition'));
    }

    public function test_server_verifies_failed_and_passing_attempts_records_leaderboard_and_enforces_bounds(): void
    {
        $seeded = $this->seedChallengeWithPrices();
        $user = User::factory()->create(['name' => 'Alex Rivera']);
        $token = $user->createToken('test')->plainTextToken;

        // 1. Broken starter fails on server Node CLI
        $failRes = $this->withToken($token)
            ->postJson('/api/challenges/first-blood/attempts', [
                'design' => $seeded['starterDesign'],
            ])
            ->assertCreated();

        $this->assertFalse($failRes->json('attempt.passed'));
        $this->assertArrayNotHasKey('referenceSolutionDesign', $failRes->json());

        // 2. Passing solution passes on server Node CLI, even if client tampered with scenarios/seed
        $tamperedPassing = $seeded['passingDesign'];
        $tamperedPassing['settings']['seed'] = 9999;
        $tamperedPassing['scenarios'] = [
            [
                'id' => 'fake',
                'name' => 'Fake Easy',
                'durationS' => 1,
                'entryNodeId' => 'client',
                'profile' => ['kind' => 'constant', 'rps' => 1],
                'flows' => [],
                'chaos' => [],
            ],
        ];

        $passRes = $this->withToken($token)
            ->postJson('/api/challenges/first-blood/attempts', [
                'design' => $tamperedPassing,
            ])
            ->assertCreated();

        $this->assertTrue($passRes->json('attempt.passed'));
        $this->assertEquals(101, $passRes->json('attempt.seed'));
        $this->assertGreaterThan(60, $passRes->json('attempt.score'));
        $this->assertLessThanOrEqual(100, $passRes->json('result.metrics.monthlyCostUsd'));
        $this->assertArrayHasKey('referenceSolutionDesign', $passRes->json());
        $this->assertEquals(2, $passRes->json('attemptsCount'));

        // 3. Leaderboard lists display name and passing score
        $lbRes = $this->getJson('/api/challenges/first-blood/leaderboard')->assertOk();
        $this->assertCount(1, $lbRes->json('entries'));
        $this->assertEquals('Alex Rivera', $lbRes->json('entries.0.displayName'));

        // 4. Reveal endpoint returns reference solution
        $this->withToken($token)
            ->postJson('/api/challenges/first-blood/reveal')
            ->assertOk()
            ->assertJsonStructure(['referenceSolutionDesign', 'whatThisTeaches']);

        // 5. Out-of-bounds CallPlan returns 422
        $this->withToken($token)
            ->postJson('/api/challenges/first-blood/attempts', [
                'design' => $seeded['starterDesign'],
                'callPlans' => [
                    's1' => [
                        'scriptId' => 's1',
                        'cpuMs' => ['distribution' => 'fixed', 'p50' => -1, 'p95' => 5],
                        'throwProbability' => 0,
                        'steps' => [],
                    ],
                ],
            ])
            ->assertStatus(422);
    }
}
