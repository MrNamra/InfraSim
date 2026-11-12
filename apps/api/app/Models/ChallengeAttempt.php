<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Server-verified user attempt against a published challenge.
 */
class ChallengeAttempt extends Model
{
    public const UPDATED_AT = null;

    protected $fillable = [
        'user_id',
        'challenge_id',
        'design_doc',
        'seed',
        'score',
        'passed',
        'result_summary',
    ];

    protected $casts = [
        'design_doc' => 'array',
        'seed' => 'integer',
        'score' => 'float',
        'passed' => 'boolean',
        'result_summary' => 'array',
    ];

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<Challenge, $this> */
    public function challenge(): BelongsTo
    {
        return $this->belongsTo(Challenge::class);
    }
}
