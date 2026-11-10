<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('designs', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->jsonb('doc');
            $table->integer('schema_version')->default(1);
            $table->integer('version')->default(1);
            $table->string('visibility')->default('private');
            $table->string('share_token')->nullable()->unique();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['user_id', 'updated_at']);
        });

        Schema::create('design_versions', function (Blueprint $table): void {
            $table->id();
            $table->foreignUuid('design_id')->constrained('designs')->cascadeOnDelete();
            $table->integer('version');
            $table->jsonb('doc');
            $table->timestamp('created_at')->nullable();

            $table->unique(['design_id', 'version']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('design_versions');
        Schema::dropIfExists('designs');
    }
};
