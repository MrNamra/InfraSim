<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FixtureTest extends TestCase
{
    use RefreshDatabase;

    public function test_unauthenticated_fixture_requests_are_rejected(): void
    {
        $this->getJson('/api/fixtures')->assertUnauthorized();
        $this->postJson('/api/fixtures', [
            'name' => 'Order POST',
            'template' => 'aws.apigw.proxy.v1',
            'event' => ['httpMethod' => 'POST'],
        ])->assertUnauthorized();
    }

    public function test_authenticated_user_can_create_list_update_and_delete_fixtures(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        $createRes = $this->withToken($token)
            ->postJson('/api/fixtures', [
                'name' => 'Order API v1',
                'template' => 'aws.apigw.proxy.v1',
                'event' => [
                    'httpMethod' => 'POST',
                    'path' => '/orders',
                    'body' => '{"sku":"abc"}',
                ],
                'schema' => [
                    'type' => 'object',
                    'required' => ['httpMethod', 'path'],
                ],
            ])
            ->assertCreated()
            ->assertJsonPath('fixture.name', 'Order API v1')
            ->assertJsonPath('fixture.template', 'aws.apigw.proxy.v1')
            ->assertJsonPath('fixture.event.httpMethod', 'POST');

        $fixtureId = $createRes->json('fixture.id');

        $this->withToken($token)
            ->getJson('/api/fixtures')
            ->assertOk()
            ->assertJsonCount(1, 'fixtures')
            ->assertJsonPath('fixtures.0.id', $fixtureId);

        $this->withToken($token)
            ->putJson("/api/fixtures/{$fixtureId}", [
                'name' => 'Order API v2',
                'template' => 'aws.apigw.proxy.v2',
                'event' => ['version' => '2.0', 'rawPath' => '/orders'],
                'schema' => ['type' => 'object', 'required' => ['version']],
            ])
            ->assertOk()
            ->assertJsonPath('fixture.name', 'Order API v2')
            ->assertJsonPath('fixture.event.version', '2.0');

        $this->withToken($token)
            ->deleteJson("/api/fixtures/{$fixtureId}")
            ->assertOk()
            ->assertJson(['deleted' => true]);

        $this->assertDatabaseCount('fixtures', 0);
    }

    public function test_invalid_fixture_payload_returns_validation_errors(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/fixtures', [
                'name' => '',
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['name', 'event']);
    }

    public function test_other_user_cannot_modify_or_delete_fixture(): void
    {
        $owner = User::factory()->create();
        $intruder = User::factory()->create();

        $ownerToken = $owner->createToken('owner')->plainTextToken;
        $intruderToken = $intruder->createToken('intruder')->plainTextToken;

        $createRes = $this->withToken($ownerToken)
            ->postJson('/api/fixtures', [
                'name' => 'Private SQS',
                'event' => ['Records' => []],
            ])
            ->assertCreated();

        $fixtureId = $createRes->json('fixture.id');

        $this->app['auth']->forgetGuards();

        $this->withToken($intruderToken)
            ->putJson("/api/fixtures/{$fixtureId}", [
                'name' => 'Tampered',
                'event' => ['Records' => []],
            ])
            ->assertForbidden();

        $this->app['auth']->forgetGuards();

        $this->withToken($intruderToken)
            ->deleteJson("/api/fixtures/{$fixtureId}")
            ->assertForbidden();
    }
}
