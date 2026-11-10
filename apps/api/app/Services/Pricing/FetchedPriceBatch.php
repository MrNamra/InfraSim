<?php

namespace App\Services\Pricing;

/**
 * Normalized batch of fetched provider prices prior to persistence.
 */
final class FetchedPriceBatch
{
    /**
     * @param  list<array<string, mixed>>  $prices
     * @param  list<string>  $warnings
     */
    public function __construct(
        public readonly string $provider,
        public readonly string $sourceUrl,
        public readonly string $rawHash,
        public readonly array $prices,
        public readonly array $warnings = [],
    ) {}
}
