<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CustomServiceTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string, mixed> */
    private function validDefinition(string $id = 'custom.stripe_api', string $name = 'Stripe API'): array
    {
        return [
            'id' => $id,
            'provider' => 'custom',
            'name' => $name,
            'category' => 'Custom & SaaS',
            'kind' => 'compute',
            'description' => 'Third-party payment gateway mock service.',
            'scope' => 'regional',
            'latency' => [
                'distribution' => 'lognormal',
                'p50' => 65,
                'p95' => 210,
            ],
            'capacity' => [
                'type' => 'rps',
                'limit' => 250,
                'burst' => 50,
            ],
            'failure' => [
                'errorRate' => 0.002,
                'kinds' => [],
            ],
            'operations' => [
                [
                    'name' => 'ChargeCard',
                    'summary' => 'Create payment charge',
                    'defaultResponse' => [
                        'statusCode' => 200,
                        'bodyTemplate' => '{"chargeId":"{{faker.uuid}}","status":"succeeded"}',
                        'sizeBytes' => 256,
                    ],
                    'errors' => [],
                ],
            ],
            'pricing' => [
                'model' => 'req',
            ],
            'ports' => [
                ['protocol' => 'https', 'port' => 443],
            ],
            'icon' => 'generic',
            'color' => '#3b82f6',
            'manualUnitPrice' => 0.30,
            'manualUnit' => '1M req',
        ];
    }

    public function test_unauthenticated_requests_are_rejected(): void
    {
        $this->getJson('/api/custom-services')->assertUnauthorized();
        $this->postJson('/api/custom-services', ['definition' => $this->validDefinition()])->assertUnauthorized();
    }

    public function test_authenticated_user_can_create_list_update_and_delete_custom_service(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        $createRes = $this->withToken($token)
            ->postJson('/api/custom-services', ['definition' => $this->validDefinition()])
            ->assertCreated()
            ->assertJsonPath('customService.serviceId', 'custom.stripe_api')
            ->assertJsonPath('customService.definition.name', 'Stripe API');

        $recordId = $createRes->json('customService.id');

        $this->withToken($token)
            ->getJson('/api/custom-services')
            ->assertOk()
            ->assertJsonCount(1, 'customServices')
            ->assertJsonPath('customServices.0.serviceId', 'custom.stripe_api');

        $updated = $this->validDefinition('custom.stripe_api', 'Stripe Billing API');
        $updated['latency']['p50'] = 80;

        $this->withToken($token)
            ->putJson("/api/custom-services/{$recordId}", ['definition' => $updated])
            ->assertOk()
            ->assertJsonPath('customService.definition.name', 'Stripe Billing API')
            ->assertJsonPath('customService.definition.latency.p50', 80);

        $this->withToken($token)
            ->putJson('/api/custom-services/custom.stripe_api', ['definition' => $updated])
            ->assertOk()
            ->assertJsonPath('customService.serviceId', 'custom.stripe_api');

        $this->withToken($token)
            ->deleteJson("/api/custom-services/{$recordId}")
            ->assertOk()
            ->assertJson(['deleted' => true]);

        $this->assertDatabaseCount('custom_services', 0);
    }

    public function test_invalid_custom_service_payload_returns_validation_errors(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        $bad = $this->validDefinition('aws.invalid_prefix');
        $bad['latency']['p95'] = 10; // less than p50 (65)
        $bad['kind'] = 'unknown_kind';

        $this->withToken($token)
            ->postJson('/api/custom-services', ['definition' => $bad])
            ->assertStatus(422)
            ->assertJsonValidationErrors([
                'definition.id',
                'definition.latency.p95',
                'definition.kind',
            ]);
    }

    public function test_other_user_cannot_modify_or_delete_custom_service(): void
    {
        $owner = User::factory()->create();
        $intruder = User::factory()->create();

        $ownerToken = $owner->createToken('owner')->plainTextToken;
        $intruderToken = $intruder->createToken('intruder')->plainTextToken;

        $createRes = $this->withToken($ownerToken)
            ->postJson('/api/custom-services', ['definition' => $this->validDefinition('custom.twilio_sms', 'Twilio SMS')])
            ->assertCreated();

        $recordId = $createRes->json('customService.id');

        $this->app['auth']->forgetGuards();

        $this->withToken($intruderToken)
            ->putJson("/api/custom-services/{$recordId}", ['definition' => $this->validDefinition('custom.twilio_sms', 'Hacked')])
            ->assertForbidden();

        $this->app['auth']->forgetGuards();

        $this->withToken($intruderToken)
            ->deleteJson("/api/custom-services/{$recordId}")
            ->assertForbidden();
    }
}
