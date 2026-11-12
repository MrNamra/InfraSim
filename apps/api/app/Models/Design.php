<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * Saved user architecture design document with optimistic version tracking
 * and unlisted read-only share token support.
 */
class Design extends Model
{
    use HasUuids, SoftDeletes;

    public const VISIBILITY_PRIVATE = 'private';

    public const VISIBILITY_UNLISTED = 'unlisted';

    public $incrementing = false;

    protected $keyType = 'string';

    /** @var list<string> */
    protected $fillable = [
        'id',
        'user_id',
        'name',
        'doc',
        'schema_version',
        'version',
        'visibility',
        'share_token',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'doc' => 'array',
            'schema_version' => 'integer',
            'version' => 'integer',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return HasMany<DesignVersion, $this> */
    public function versions(): HasMany
    {
        return $this->hasMany(DesignVersion::class, 'design_id');
    }
}
