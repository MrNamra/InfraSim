<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('price_snapshots', function (Blueprint $table): void {
            $table->id();
            $table->string('provider');
            $table->timestampTz('fetched_at');
            $table->text('source_url');
            $table->string('raw_hash');
            $table->string('status');

            $table->index(['provider', 'status', 'fetched_at']);
        });

        Schema::create('prices', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('snapshot_id')->constrained('price_snapshots')->cascadeOnDelete();
            $table->string('provider');
            $table->string('service_id');
            $table->string('sku_key');
            $table->string('region');
            $table->string('unit');
            $table->decimal('unit_price', 20, 10);
            $table->string('currency', 8)->default('USD');
            $table->decimal('tier_min', 20, 4)->nullable();
            $table->decimal('tier_max', 20, 4)->nullable();
            $table->jsonb('attrs')->nullable();

            $table->index(['provider', 'service_id', 'region']);
            $table->index('sku_key');
        });

        Schema::create('price_sku_map', function (Blueprint $table): void {
            $table->id();
            $table->string('service_id');
            $table->string('provider');
            $table->jsonb('filter');
            $table->string('unit_role');

            $table->index(['provider', 'service_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('price_sku_map');
        Schema::dropIfExists('prices');
        Schema::dropIfExists('price_snapshots');
    }
};
