<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Stored challenge specification containing server-owned scenario, constraints,
 * pinned price snapshot reference, hints, and hidden reference solution.
 */
class Challenge extends Model
{
    public $timestamps = false;

    protected $fillable = [
        'slug',
        'title',
        'difficulty',
        'definition',
        'published',
    ];

    protected $casts = [
        'definition' => 'array',
        'published' => 'boolean',
    ];

    /** @return HasMany<ChallengeAttempt, $this> */
    public function attempts(): HasMany
    {
        return $this->hasMany(ChallengeAttempt::class, 'challenge_id');
    }
}
