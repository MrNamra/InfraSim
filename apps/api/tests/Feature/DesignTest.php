<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DesignTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return array<string, mixed>
     */
    private function sampleDoc(string $label = 'API Gateway'): array
    {
        return [
            'schemaVersion' => 1,
            'id' => 'local-design',
            'name' => 'Checkout Core',
            'nodes' => [
                [
                    'id' => 'api',
                    'serviceId' => 'aws.ec2',
                    'label' => $label,
                    'position' => ['x' => 100, 'y' => 120],
                    'config' => [
                        'instances' => 2,
                        'mockEnv' => ['DB_PASS' => 'CANARY_SECRET_999'],
                        'operations' => new \stdClass,
                    ],
                ],
            ],
            'edges' => [],
            'groups' => [],
            'network' => new \stdClass,
            'scenarios' => [],
            'scripts' => [
                [
                    'id' => 's1',
                    'name' => 'handler.js',
                    'kind' => 'handler',
                    'language' => 'javascript',
                    'source' => 'export default async function () { return { status: 200 }; }',
                    'entry' => 'default',
                    'memoryMb' => 128,
                    'timeoutMs' => 500,
                    'env' => ['API_TOKEN' => 'SECRET_SCRIPT_ENV'],
                ],
            ],
            'fixtures' => [],
            'settings' => ['seed' => 42, 'currency' => 'USD', 'includeFreeTier' => true],
        ];
    }

    public function test_unauthenticated_design_crud_is_rejected(): void
    {
        $this->getJson('/api/designs')->assertUnauthorized();
        $this->postJson('/api/designs', ['name' => 'Test', 'doc' => $this->sampleDoc()])->assertUnauthorized();
    }

    public function test_design_crud_optimistic_locking_versions_and_read_only_sharing(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $ownerToken = $owner->createToken('owner')->plainTextToken;
        $otherToken = $other->createToken('other')->plainTextToken;

        // 1. Create design -> v1 + DesignVersion row
        $createRes = $this->withToken($ownerToken)
            ->postJson('/api/designs', [
                'name' => 'Checkout Core',
                'doc' => $this->sampleDoc(),
            ])
            ->assertCreated()
            ->assertJsonPath('design.version', 1);

        $designId = $createRes->json('design.id');

        // 2. Other user forbidden
        $this->app['auth']->forgetGuards();
        $this->withToken($otherToken)->getJson("/api/designs/{$designId}")->assertForbidden();
        $this->app['auth']->forgetGuards();

        // 3. Valid update increments version to 2 and records DesignVersion
        $this->withToken($ownerToken)
            ->putJson("/api/designs/{$designId}", [
                'name' => 'Checkout Core v2',
                'base_version' => 1,
                'doc' => $this->sampleDoc('Updated API'),
            ])
            ->assertOk()
            ->assertJsonPath('design.version', 2);

        // 4. Stale base_version returns 409 Conflict
        $this->withToken($ownerToken)
            ->putJson("/api/designs/{$designId}", [
                'name' => 'Stale Edit',
                'base_version' => 1,
                'doc' => $this->sampleDoc('Stale'),
            ])
            ->assertStatus(409)
            ->assertJsonPath('currentVersion', 2);

        // 5. Version history lists both v2 and v1
        $versionsRes = $this->withToken($ownerToken)
            ->getJson("/api/designs/{$designId}/versions")
            ->assertOk()
            ->assertJsonCount(2, 'versions');
        $this->assertEquals(2, $versionsRes->json('versions.0.version'));
        $this->assertEquals(1, $versionsRes->json('versions.1.version'));

        // 6. Share design and verify public unauthenticated endpoint redacts secrets
        $shareRes = $this->withToken($ownerToken)
            ->postJson("/api/designs/{$designId}/share")
            ->assertOk()
            ->assertJsonPath('visibility', 'unlisted');
        $shareToken = $shareRes->json('shareToken');
        $this->assertNotEmpty($shareToken);

        $publicRes = $this->getJson("/api/shared/{$shareToken}")
            ->assertOk()
            ->assertJsonPath('design.name', 'Checkout Core v2');

        $publicJson = json_encode($publicRes->json(), JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString('CANARY_SECRET_999', $publicJson);
        $this->assertStringNotContainsString('SECRET_SCRIPT_ENV', $publicJson);

        // 7. Revoke share -> 404 on shared route
        $this->withToken($ownerToken)
            ->postJson("/api/designs/{$designId}/share", ['revoke' => true])
            ->assertOk()
            ->assertJsonPath('visibility', 'private');

        $this->getJson("/api/shared/{$shareToken}")->assertNotFound();

        // 8. Soft delete removes from active list
        $this->withToken($ownerToken)
            ->deleteJson("/api/designs/{$designId}")
            ->assertOk()
            ->assertJson(['deleted' => true]);

        $this->withToken($ownerToken)
            ->getJson('/api/designs')
            ->assertOk()
            ->assertJsonCount(0, 'designs');
    }
}
