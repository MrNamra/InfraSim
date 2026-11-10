<?php

namespace App\Services\Pricing;

/**
 * Contract for provider-specific public pricing fetchers & normalizers.
 */
interface PriceFetcherInterface
{
    /**
     * Provider key ('aws' | 'azure' | 'gcp' | 'oci').
     */
    public function provider(): string;

    /**
     * Fetch public pricing data (or read an offline fixture) and return normalized rows.
     *
     * @param  list<string>  $regions
     * @param  list<array<string, mixed>>  $mappings
     *
     * @throws PriceSyncException
     */
    public function fetch(array $regions, array $mappings, ?string $fixturePath = null): FetchedPriceBatch;
}
