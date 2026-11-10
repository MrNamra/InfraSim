<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Normalized public price row belonging to a provider snapshot.
 */
class Price extends Model
{
    public $timestamps = false;

    protected $table = 'prices';

    /** @var list<string> */
    protected $fillable = [
        'snapshot_id',
        'provider',
        'service_id',
        'sku_key',
        'region',
        'unit',
        'unit_price',
        'currency',
        'tier_min',
        'tier_max',
        'attrs',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'unit_price' => 'float',
            'tier_min' => 'float',
            'tier_max' => 'float',
            'attrs' => 'array',
        ];
    }

    /** @return BelongsTo<PriceSnapshot, $this> */
    public function snapshot(): BelongsTo
    {
        return $this->belongsTo(PriceSnapshot::class, 'snapshot_id');
    }
}
