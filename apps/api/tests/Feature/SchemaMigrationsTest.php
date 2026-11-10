<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class SchemaMigrationsTest extends TestCase
{
    use RefreshDatabase;

    public function test_all_core_tables_exist(): void
    {
        $expectedTables = [
            'users',
            'personal_access_tokens',
            'designs',
            'design_versions',
            'custom_services',
            'fixtures',
            'price_snapshots',
            'prices',
            'price_sku_map',
            'challenges',
            'challenge_attempts',
        ];

        foreach ($expectedTables as $table) {
            $this->assertTrue(Schema::hasTable($table), "Missing expected table: {$table}");
        }
    }
}
