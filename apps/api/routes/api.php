<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\ChallengeController;
use App\Http\Controllers\CustomServiceController;
use App\Http\Controllers\FixtureController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\PriceController;
use Illuminate\Support\Facades\Route;

Route::get('/health', HealthController::class);

Route::middleware('throttle:api')->group(function (): void {
    Route::prefix('prices')->group(function (): void {
        Route::get('/snapshot', [PriceController::class, 'snapshot']);
        Route::get('/coverage', [PriceController::class, 'coverage']);
        Route::post('/sync', [PriceController::class, 'sync'])->middleware('auth:sanctum');
    });

    Route::prefix('challenges')->group(function (): void {
        Route::get('/', [ChallengeController::class, 'index']);
        Route::get('/{slug}', [ChallengeController::class, 'show']);
        Route::get('/{slug}/leaderboard', [ChallengeController::class, 'leaderboard']);

        Route::middleware('auth:sanctum')->group(function (): void {
            Route::post('/{slug}/attempts', [ChallengeController::class, 'attempt']);
            Route::post('/{slug}/reveal', [ChallengeController::class, 'reveal']);
        });
    });

    Route::prefix('auth')->group(function (): void {
        Route::post('/register', [AuthController::class, 'register']);
        Route::post('/login', [AuthController::class, 'login']);

        Route::middleware('auth:sanctum')->group(function (): void {
            Route::post('/logout', [AuthController::class, 'logout']);
            Route::get('/me', [AuthController::class, 'me']);
        });
    });

    Route::middleware('auth:sanctum')->group(function (): void {
        Route::get('/custom-services', [CustomServiceController::class, 'index']);
        Route::post('/custom-services', [CustomServiceController::class, 'store']);
        Route::put('/custom-services/{customService}', [CustomServiceController::class, 'update']);
        Route::delete('/custom-services/{customService}', [CustomServiceController::class, 'destroy']);

        Route::get('/fixtures', [FixtureController::class, 'index']);
        Route::post('/fixtures', [FixtureController::class, 'store']);
        Route::put('/fixtures/{fixture}', [FixtureController::class, 'update']);
        Route::delete('/fixtures/{fixture}', [FixtureController::class, 'destroy']);
    });
});
