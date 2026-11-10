<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Mapping between a catalog service ID + unit role and a provider SKU filter.
 */
class PriceSkuMap extends Model
{
    public $timestamps = false;

    protected $table = 'price_sku_map';

    /** @var list<string> */
    protected $fillable = [
        'service_id',
        'provider',
        'filter',
        'unit_role',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'filter' => 'array',
        ];
    }
}
