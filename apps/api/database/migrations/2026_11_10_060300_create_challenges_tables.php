<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('challenges', function (Blueprint $table): void {
            $table->id();
            $table->string('slug')->unique();
            $table->string('title');
            $table->string('difficulty');
            $table->jsonb('definition');
            $table->boolean('published')->default(false);
        });

        Schema::create('challenge_attempts', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('challenge_id')->constrained('challenges')->cascadeOnDelete();
            $table->jsonb('design_doc');
            $table->integer('seed');
            $table->decimal('score', 8, 2);
            $table->boolean('passed');
            $table->jsonb('result_summary');
            $table->timestamp('created_at')->nullable();

            $table->index(['user_id', 'challenge_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('challenge_attempts');
        Schema::dropIfExists('challenges');
    }
};
