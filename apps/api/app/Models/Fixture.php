<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Saved user test payload fixture stored in the fixtures table.
 */
class Fixture extends Model
{
    use HasUuids;

    protected $table = 'fixtures';

    public $incrementing = false;

    protected $keyType = 'string';

    /** @var list<string> */
    protected $fillable = [
        'user_id',
        'name',
        'template',
        'event',
        'schema',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'schema' => 'array',
        ];
    }

    /**
     * Store arbitrary valid JSON roots (object, array, scalar) safely in jsonb.
     *
     * @return Attribute<mixed, mixed>
     */
    protected function event(): Attribute
    {
        return Attribute::make(
            get: fn (?string $value): mixed => $value === null ? null : json_decode($value, true),
            set: fn (mixed $value): string => json_encode($value, JSON_THROW_ON_ERROR),
        );
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
