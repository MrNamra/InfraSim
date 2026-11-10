<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * User-defined custom service entry stored as JSONB in custom_services.
 */
class CustomService extends Model
{
    use HasUuids;

    protected $table = 'custom_services';

    public $incrementing = false;

    protected $keyType = 'string';

    /** @var list<string> */
    protected $fillable = [
        'user_id',
        'service_id',
        'definition',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'definition' => 'array',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
