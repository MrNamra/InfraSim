<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    public function test_health_endpoint_returns_ok(): void
    {
        $this->getJson('/api/health')
            ->assertOk()
            ->assertJson([
                'status' => 'ok',
                'service' => 'infrasim-api',
            ]);
    }

    public function test_user_can_register_and_fetch_profile(): void
    {
        $response = $this->postJson('/api/auth/register', [
            'name' => 'Ada Lovelace',
            'email' => 'ada@example.com',
            'password' => 'correct-horse-battery',
        ]);

        $response->assertCreated()
            ->assertJsonPath('user.email', 'ada@example.com')
            ->assertJsonStructure(['user' => ['id', 'name', 'email'], 'token']);

        $token = $response->json('token');

        $this->withToken($token)
            ->getJson('/api/auth/me')
            ->assertOk()
            ->assertJsonPath('user.name', 'Ada Lovelace');
    }

    public function test_duplicate_email_is_rejected(): void
    {
        User::factory()->create(['email' => 'ada@example.com']);

        $this->postJson('/api/auth/register', [
            'name' => 'Another Ada',
            'email' => 'ada@example.com',
            'password' => 'correct-horse-battery',
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['email']);
    }

    public function test_user_can_login_and_logout(): void
    {
        User::factory()->create([
            'email' => 'grace@example.com',
            'password' => 'super-secret-pass',
        ]);

        $login = $this->postJson('/api/auth/login', [
            'email' => 'grace@example.com',
            'password' => 'super-secret-pass',
        ])->assertOk()
            ->assertJsonStructure(['user' => ['id', 'name', 'email'], 'token']);

        $token = $login->json('token');

        $this->withToken($token)
            ->postJson('/api/auth/logout')
            ->assertOk()
            ->assertJson(['ok' => true]);

        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_invalid_credentials_return_validation_error(): void
    {
        User::factory()->create([
            'email' => 'grace@example.com',
            'password' => 'super-secret-pass',
        ]);

        $this->postJson('/api/auth/login', [
            'email' => 'grace@example.com',
            'password' => 'wrong-password',
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['email']);
    }

    public function test_unauthenticated_me_request_is_rejected(): void
    {
        $this->getJson('/api/auth/me')->assertUnauthorized();
    }

    public function test_spa_origin_can_register_without_csrf_cookie(): void
    {
        $this->withHeaders([
            'Origin' => 'http://127.0.0.1:3000',
            'Referer' => 'http://127.0.0.1:3000/',
        ])->postJson('/api/auth/register', [
            'name' => 'CORS Ada',
            'email' => 'cors-ada@example.com',
            'password' => 'correct-horse-battery',
        ])->assertCreated()
            ->assertJsonStructure(['user' => ['id', 'name', 'email'], 'token']);
    }
}
