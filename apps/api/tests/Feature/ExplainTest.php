<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

class ExplainTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string, mixed> */
    private function validSummary(): array
    {
        return [
            'designName' => 'Checkout API',
            'focusNodeId' => 'db',
            'nodes' => [
                [
                    'id' => 'api',
                    'serviceId' => 'aws.ec2',
                    'kind' => 'compute',
                    'label' => 'API Server',
                    'instances' => 2,
                    'region' => 'us-east-1',
                ],
                [
                    'id' => 'db',
                    'serviceId' => 'aws.rds_postgres',
                    'kind' => 'sql',
                    'label' => 'Primary DB',
                    'instances' => 1,
                    'region' => 'us-east-1',
                ],
            ],
            'kpis' => [
                'p50Ms' => 38,
                'p95Ms' => 340,
                'p99Ms' => 620,
                'errorRate' => 0.04,
                'throughputRps' => 240.5,
                'monthlyCostUsd' => 132.4,
            ],
            'insights' => [
                [
                    'ruleId' => 'db-pool-exhausted',
                    'title' => 'Database connection pool exhausted',
                    'severity' => 'critical',
                    'isRootCause' => true,
                    'nodeIds' => ['db'],
                    'evidence' => ['peakUtilPct' => 98],
                    'short' => 'Primary DB connection pool reached 98% saturation.',
                    'suggestedFixes' => [
                        ['label' => 'Add RDS Proxy', 'tradeOff' => 'Adds minor proxy latency'],
                    ],
                ],
            ],
        ];
    }

    public function test_explain_is_disabled_by_default_and_requires_auth(): void
    {
        $this->postJson('/api/explain', $this->validSummary())->assertStatus(401);

        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/explain', $this->validSummary())
            ->assertStatus(503)
            ->assertJsonPath('enabled', false);
    }

    public function test_explain_rejects_code_or_env_canary_and_caches_valid_summaries(): void
    {
        Cache::flush();
        config(['services.explain.enabled' => true]);

        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        $dirty = $this->validSummary();
        $dirty['scripts'] = [['source' => 'CANARY_JS_CODE']];
        $this->withToken($token)->postJson('/api/explain', $dirty)->assertStatus(422);

        $dirtyMockEnv = $this->validSummary();
        $dirtyMockEnv['nodes'][0]['mockEnv'] = ['API_KEY' => 'CANARY_SECRET'];
        $this->withToken($token)->postJson('/api/explain', $dirtyMockEnv)->assertStatus(422);

        $first = $this->withToken($token)
            ->postJson('/api/explain', $this->validSummary())
            ->assertOk()
            ->assertJsonPath('enabled', true)
            ->assertJsonPath('cached', false)
            ->assertJsonPath('label', 'AI-written explanation — rules above are the source of truth');

        $this->assertNotEmpty($first->json('explanation'));
        $this->assertNotEmpty($first->json('nextSteps'));

        $second = $this->withToken($token)
            ->postJson('/api/explain', $this->validSummary())
            ->assertOk()
            ->assertJsonPath('cached', true);

        $this->assertSame($first->json('explanation'), $second->json('explanation'));
    }

    public function test_explain_rate_limits_per_user(): void
    {
        Cache::flush();
        config(['services.explain.enabled' => true]);

        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        for ($i = 0; $i < 10; $i++) {
            $summary = $this->validSummary();
            $summary['designName'] = "Run {$i}";
            $this->withToken($token)->postJson('/api/explain', $summary)->assertOk();
        }

        $summary = $this->validSummary();
        $summary['designName'] = 'Run 11';
        $this->withToken($token)->postJson('/api/explain', $summary)->assertStatus(429);
    }
}
