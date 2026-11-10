<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Immutable pricing snapshot published per provider after atomic validation.
 */
class PriceSnapshot extends Model
{
    public const STATUS_STAGING = 'staging';

    public const STATUS_PUBLISHED = 'published';

    public const STATUS_ARCHIVED = 'archived';

    public const STATUS_FAILED = 'failed';

    public $timestamps = false;

    protected $table = 'price_snapshots';

    /** @var list<string> */
    protected $fillable = [
        'provider',
        'fetched_at',
        'source_url',
        'raw_hash',
        'status',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'fetched_at' => 'datetime',
        ];
    }

    /** @return HasMany<Price, $this> */
    public function prices(): HasMany
    {
        return $this->hasMany(Price::class, 'snapshot_id');
    }
}
