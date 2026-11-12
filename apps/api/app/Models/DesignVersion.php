<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Immutable historical snapshot of a saved architecture design version.
 */
class DesignVersion extends Model
{
    public const UPDATED_AT = null;

    protected $table = 'design_versions';

    /** @var list<string> */
    protected $fillable = [
        'design_id',
        'version',
        'doc',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'version' => 'integer',
            'doc' => 'array',
        ];
    }

    /** @return BelongsTo<Design, $this> */
    public function design(): BelongsTo
    {
        return $this->belongsTo(Design::class, 'design_id');
    }
}
