<?php

namespace App\Services\Pricing;

use Illuminate\Support\Facades\Http;
use JsonException;

/**
 * Fetches and normalizes OCI public Cost Estimator products JSON.
 *
 * OCI list pricing via apexapps.oracle.com is globally uniform across regions;
 * rows are stored under region='global' with PAY_AS_YOU_GO USD rates.
 */
class OciPricingFetcher implements PriceFetcherInterface
{
    public function provider(): string
    {
        return 'oci';
    }

    /**
     * {@inheritDoc}
     */
    public function fetch(array $regions, array $mappings, ?string $fixturePath = null): FetchedPriceBatch
    {
        unset($regions);

        if ($fixturePath !== null) {
            if (! is_file($fixturePath)) {
                throw new PriceSyncException("OCI fixture file not found: {$fixturePath}");
            }

            $raw = file_get_contents($fixturePath);
            if ($raw === false) {
                throw new PriceSyncException("Unable to read OCI fixture file: {$fixturePath}");
            }

            $sourceUrl = 'fixture://'.basename($fixturePath);
        } else {
            $sourceUrl = (string) config('pricing.sources.oci.products_url');
            $resp = Http::retry(3, 600)->timeout(45)->acceptJson()->get($sourceUrl);
            if ($resp->failed()) {
                throw new PriceSyncException("Failed fetching OCI products API: HTTP {$resp->status()} from {$sourceUrl}");
            }
            $raw = $resp->body();
        }

        $decoded = $this->decodeJson($raw, $sourceUrl);
        if (! isset($decoded['items']) || ! is_array($decoded['items'])) {
            throw new PriceSyncException('Invalid OCI products schema: expected items array.');
        }

        $rows = $this->normalizeItems($decoded['items'], $mappings);
        if ($rows === []) {
            throw new PriceSyncException('OCI price normalization produced 0 valid rows.');
        }

        return new FetchedPriceBatch(
            provider: $this->provider(),
            sourceUrl: $sourceUrl,
            rawHash: hash('sha256', $raw),
            prices: $rows,
        );
    }

    /**
     * @param  list<array<string, mixed>>  $items
     * @param  list<array<string, mixed>>  $mappings
     * @return list<array<string, mixed>>
     */
    private function normalizeItems(array $items, array $mappings): array
    {
        $rows = [];

        foreach ($items as $item) {
            if (! is_array($item)) {
                continue;
            }

            $usdPrices = $this->extractUsdPayAsYouGoPrices($item);
            if ($usdPrices === []) {
                continue;
            }

            foreach ($mappings as $mapping) {
                if (! $this->matchesMapping($item, $mapping)) {
                    continue;
                }

                $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];
                $priceScale = isset($filter['priceScale']) && is_numeric($filter['priceScale'])
                    ? (float) $filter['priceScale']
                    : 1.0;

                usort($usdPrices, static function (array $a, array $b): int {
                    return ((float) ($a['rangeMin'] ?? 0)) <=> ((float) ($b['rangeMin'] ?? 0));
                });

                $skuKey = $this->resolveSkuKey($item, $filter);
                $rawMetric = trim((string) ($item['metricName'] ?? 'Units'));
                $unit = (string) ($mapping['unit'] ?? $rawMetric);

                foreach ($usdPrices as $priceObj) {
                    if (! isset($priceObj['value']) || ! is_numeric($priceObj['value'])) {
                        continue;
                    }

                    $rawPrice = (float) $priceObj['value'];
                    $tierMin = isset($priceObj['rangeMin']) && is_numeric($priceObj['rangeMin'])
                        ? (float) $priceObj['rangeMin']
                        : 0.0;

                    $rawMax = $priceObj['rangeMax'] ?? null;
                    $tierMax = is_numeric($rawMax) && (float) $rawMax < 900_000_000.0
                        ? (float) $rawMax
                        : null;

                    $unitPrice = $rawPrice * $priceScale;
                    if ($priceScale > 0.0 && abs($priceScale - 1.0) > 1e-12) {
                        $tierMin = $tierMin / $priceScale;
                        $tierMax = $tierMax !== null ? ($tierMax / $priceScale) : null;
                    }

                    $rows[] = [
                        'provider' => 'oci',
                        'service_id' => (string) $mapping['serviceId'],
                        'sku_key' => $skuKey,
                        'region' => 'global',
                        'unit' => $unit,
                        'unit_price' => $unitPrice,
                        'currency' => 'USD',
                        'tier_min' => $tierMin,
                        'tier_max' => $tierMax,
                        'attrs' => array_filter([
                            'unitRole' => (string) ($mapping['unitRole'] ?? ''),
                            'partNumber' => $item['partNumber'] ?? null,
                            'displayName' => $item['displayName'] ?? null,
                            'serviceCategory' => $item['serviceCategory'] ?? null,
                            'metricName' => $rawMetric,
                        ], static fn (mixed $v): bool => $v !== null && $v !== ''),
                    ];
                }
            }
        }

        return $this->deduplicateAndSort($rows);
    }

    /**
     * @param  array<string, mixed>  $item
     * @return list<array<string, mixed>>
     */
    private function extractUsdPayAsYouGoPrices(array $item): array
    {
        $locs = is_array($item['currencyCodeLocalizations'] ?? null) ? $item['currencyCodeLocalizations'] : [];
        foreach ($locs as $loc) {
            if (! is_array($loc) || strtoupper((string) ($loc['currencyCode'] ?? '')) !== 'USD') {
                continue;
            }
            $prices = is_array($loc['prices'] ?? null) ? $loc['prices'] : [];

            return array_values(array_filter(
                $prices,
                static fn (mixed $p): bool => is_array($p) && strtoupper((string) ($p['model'] ?? '')) === 'PAY_AS_YOU_GO',
            ));
        }

        return [];
    }

    /**
     * @param  array<string, mixed>  $item
     * @param  array<string, mixed>  $mapping
     */
    private function matchesMapping(array $item, array $mapping): bool
    {
        $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];

        $serviceCat = (string) ($item['serviceCategory'] ?? '');
        if (isset($filter['serviceCategory']) && $filter['serviceCategory'] !== '') {
            if (strcasecmp($serviceCat, (string) $filter['serviceCategory']) !== 0) {
                return false;
            }
        }

        if (isset($filter['serviceCategoryContains']) && $filter['serviceCategoryContains'] !== '') {
            if (stripos($serviceCat, (string) $filter['serviceCategoryContains']) === false) {
                return false;
            }
        }

        if (isset($filter['partNumber']) && $filter['partNumber'] !== '') {
            if ((string) ($item['partNumber'] ?? '') !== (string) $filter['partNumber']) {
                return false;
            }
        }

        $displayName = (string) ($item['displayName'] ?? '');
        if (isset($filter['displayNameContains']) && $filter['displayNameContains'] !== '') {
            if (stripos($displayName, (string) $filter['displayNameContains']) === false) {
                return false;
            }
        }

        $metricName = (string) ($item['metricName'] ?? '');
        if (isset($filter['metricContains']) && $filter['metricContains'] !== '') {
            if (stripos($metricName, (string) $filter['metricContains']) === false) {
                return false;
            }
        }

        $searchable = strtolower($displayName.' '.$metricName.' '.$serviceCat);
        foreach (['byol', 'monthly commit', '1 year commit', '3 year commit'] as $globalExclude) {
            if (str_contains($searchable, $globalExclude)) {
                return false;
            }
        }

        if (isset($filter['exclude']) && is_array($filter['exclude'])) {
            foreach ($filter['exclude'] as $term) {
                $needle = strtolower((string) $term);
                if ($needle !== '' && str_contains($searchable, $needle)) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * @param  array<string, mixed>  $item
     * @param  array<string, mixed>  $filter
     */
    private function resolveSkuKey(array $item, array $filter): string
    {
        $keyBy = (string) ($filter['keyBy'] ?? 'displayName');
        $candidate = trim((string) ($item[$keyBy] ?? ''));
        if ($candidate !== '') {
            return $candidate;
        }

        $fallback = trim((string) ($item['displayName'] ?? $item['partNumber'] ?? 'unknown'));

        return $fallback !== '' ? $fallback : 'unknown';
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    private function deduplicateAndSort(array $rows): array
    {
        $unique = [];
        foreach ($rows as $row) {
            $unitRole = (string) ($row['attrs']['unitRole'] ?? '');
            $tierKey = $row['tier_min'] !== null ? number_format((float) $row['tier_min'], 4, '.', '') : 'none';
            $key = implode('|', [
                (string) $row['service_id'],
                (string) $row['sku_key'],
                (string) $row['region'],
                $unitRole,
                $tierKey,
            ]);
            if (! isset($unique[$key])) {
                $unique[$key] = $row;
            }
        }

        ksort($unique);

        return array_values($unique);
    }

    /** @return array<string, mixed> */
    private function decodeJson(string $raw, string $source): array
    {
        try {
            $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $e) {
            throw new PriceSyncException("Invalid JSON from {$source}: {$e->getMessage()}", 0, $e);
        }

        if (! is_array($decoded)) {
            throw new PriceSyncException("Unexpected non-object JSON payload from {$source}.");
        }

        return $decoded;
    }
}
