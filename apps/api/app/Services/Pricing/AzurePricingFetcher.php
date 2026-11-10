<?php

namespace App\Services\Pricing;

use Illuminate\Support\Facades\Http;
use JsonException;

/**
 * Fetches and normalizes Azure Retail Prices API JSON pages.
 *
 * Enforces Consumption + USD filtering and excludes Spot / Low Priority / Windows SKUs
 * across productName, skuName, and meterName per verified API behavior.
 */
class AzurePricingFetcher implements PriceFetcherInterface
{
    private const GLOBAL_EXCLUDES = ['spot', 'low priority', 'windows'];

    public function provider(): string
    {
        return 'azure';
    }

    /**
     * {@inheritDoc}
     */
    public function fetch(array $regions, array $mappings, ?string $fixturePath = null): FetchedPriceBatch
    {
        $allowedRegions = array_values(array_filter(array_map('trim', $regions), static fn (string $r): bool => $r !== ''));

        if ($fixturePath !== null) {
            return $this->fetchFromFixture($fixturePath, $allowedRegions, $mappings);
        }

        return $this->fetchLive($allowedRegions, $mappings);
    }

    /**
     * @param  list<string>  $allowedRegions
     * @param  list<array<string, mixed>>  $mappings
     */
    private function fetchFromFixture(string $fixturePath, array $allowedRegions, array $mappings): FetchedPriceBatch
    {
        if (! is_file($fixturePath)) {
            throw new PriceSyncException("Azure fixture file not found: {$fixturePath}");
        }

        $maxPages = max(1, (int) config('pricing.max_pages', 100));
        $dir = dirname($fixturePath);
        $visited = [];
        $allItems = [];
        $hashContext = hash_init('sha256');
        $currentPath = $fixturePath;
        $pageCount = 0;

        while ($currentPath !== null) {
            $pageCount++;
            if ($pageCount > $maxPages) {
                throw new PriceSyncException("Azure fixture pagination exceeded max_pages ({$maxPages}).");
            }

            if (isset($visited[$currentPath])) {
                throw new PriceSyncException("Azure fixture NextPageLink cycle detected at: {$currentPath}");
            }
            $visited[$currentPath] = true;

            if (! is_file($currentPath)) {
                throw new PriceSyncException("Azure linked fixture page not found: {$currentPath}");
            }

            $raw = (string) file_get_contents($currentPath);
            hash_update($hashContext, $raw);
            $decoded = $this->decodeJson($raw, $currentPath);

            if (isset($decoded['pages']) && is_array($decoded['pages'])) {
                foreach ($decoded['pages'] as $idx => $pagePayload) {
                    if (! is_array($pagePayload) || ! isset($pagePayload['Items']) || ! is_array($pagePayload['Items'])) {
                        throw new PriceSyncException("Malformed Azure page #{$idx} in fixture.");
                    }
                    foreach ($pagePayload['Items'] as $item) {
                        if (is_array($item)) {
                            $allItems[] = $item;
                        }
                    }
                }
                $currentPath = null;

                continue;
            }

            if (! isset($decoded['Items']) || ! is_array($decoded['Items'])) {
                throw new PriceSyncException("Malformed Azure pricing schema in {$currentPath}: missing Items array.");
            }

            foreach ($decoded['Items'] as $item) {
                if (is_array($item)) {
                    $allItems[] = $item;
                }
            }

            $nextLink = $decoded['NextPageLink'] ?? null;
            if (is_string($nextLink) && $nextLink !== '') {
                $currentPath = str_starts_with($nextLink, '/') ? $nextLink : $dir.'/'.$nextLink;
            } else {
                $currentPath = null;
            }
        }

        $rows = $this->normalizeItems($allItems, $mappings, $allowedRegions);
        if ($rows === []) {
            throw new PriceSyncException('Azure price normalization produced 0 valid rows from fixture.');
        }

        return new FetchedPriceBatch(
            provider: $this->provider(),
            sourceUrl: 'fixture://'.basename($fixturePath),
            rawHash: hash_final($hashContext),
            prices: $rows,
        );
    }

    /**
     * @param  list<string>  $allowedRegions
     * @param  list<array<string, mixed>>  $mappings
     */
    private function fetchLive(array $allowedRegions, array $mappings): FetchedPriceBatch
    {
        $apiUrl = (string) config('pricing.sources.azure.api_url');
        $apiVersion = (string) config('pricing.sources.azure.api_version', '2023-01-01-preview');
        $maxPages = max(1, (int) config('pricing.max_pages', 100));
        $maxRuntime = max(10, (int) config('pricing.max_runtime_seconds', 240));
        $startedAt = microtime(true);

        $serviceNames = [];
        foreach ($mappings as $mapping) {
            $svcName = (string) ($mapping['filter']['serviceName'] ?? '');
            if ($svcName !== '') {
                $serviceNames[$svcName] = true;
            }
        }

        $targetRegions = $allowedRegions !== [] ? $allowedRegions : ['eastus'];
        $regionClause = implode(' or ', array_map(
            static fn (string $r): string => "armRegionName eq '{$r}'",
            $targetRegions,
        ));

        $allItems = [];
        $warnings = [];
        $hashContext = hash_init('sha256');

        foreach (array_keys($serviceNames) as $serviceName) {
            $escapedName = str_replace("'", "''", $serviceName);
            $filterExpr = "serviceName eq '{$escapedName}' and priceType eq 'Consumption' and ({$regionClause} or armRegionName eq '')";
            $nextUrl = $apiUrl.'?'.http_build_query([
                'api-version' => $apiVersion,
                '$filter' => $filterExpr,
            ]);

            $pageCount = 0;
            while ($nextUrl !== null) {
                if ((microtime(true) - $startedAt) > $maxRuntime) {
                    throw new PriceSyncException("Azure price sync aborted: exceeded max_runtime_seconds ({$maxRuntime}s).");
                }

                $pageCount++;
                if ($pageCount > $maxPages) {
                    $warnings[] = "Azure pagination capped at {$maxPages} pages for {$serviceName}.";

                    break;
                }

                $resp = Http::retry(3, 600)->timeout(30)->acceptJson()->get($nextUrl);
                if ($resp->failed()) {
                    throw new PriceSyncException("Failed fetching Azure prices HTTP {$resp->status()} for {$serviceName}.");
                }

                $body = $resp->body();
                hash_update($hashContext, $body);
                $decoded = $this->decodeJson($body, $nextUrl);

                if (! isset($decoded['Items']) || ! is_array($decoded['Items'])) {
                    throw new PriceSyncException("Unexpected Azure Retail API schema for {$serviceName}: missing Items.");
                }

                foreach ($decoded['Items'] as $item) {
                    if (is_array($item)) {
                        $allItems[] = $item;
                    }
                }

                $nextLink = $decoded['NextPageLink'] ?? null;
                $nextUrl = is_string($nextLink) && $nextLink !== '' ? $nextLink : null;
            }
        }

        $rows = $this->normalizeItems($allItems, $mappings, $allowedRegions);
        if ($rows === []) {
            throw new PriceSyncException('Azure live price sync produced 0 valid rows.');
        }

        return new FetchedPriceBatch(
            provider: $this->provider(),
            sourceUrl: $apiUrl,
            rawHash: hash_final($hashContext),
            prices: $rows,
            warnings: $warnings,
        );
    }

    /**
     * @param  list<array<string, mixed>>  $items
     * @param  list<array<string, mixed>>  $mappings
     * @param  list<string>  $allowedRegions
     * @return list<array<string, mixed>>
     */
    private function normalizeItems(array $items, array $mappings, array $allowedRegions): array
    {
        $matched = [];

        foreach ($items as $item) {
            $type = strtolower((string) ($item['type'] ?? $item['priceType'] ?? ''));
            $currency = strtoupper((string) ($item['currencyCode'] ?? ''));
            if ($type !== 'consumption' || $currency !== 'USD') {
                continue;
            }

            if (! isset($item['retailPrice']) || ! is_numeric($item['retailPrice'])) {
                continue;
            }

            $rawRegion = trim((string) ($item['armRegionName'] ?? ''));
            $region = $rawRegion === '' || strcasecmp($rawRegion, 'Global') === 0 ? 'global' : $rawRegion;
            if ($allowedRegions !== [] && $region !== 'global' && ! in_array($region, $allowedRegions, true)) {
                continue;
            }

            if ($this->isGloballyExcluded($item)) {
                continue;
            }

            foreach ($mappings as $mapping) {
                if (! $this->matchesMapping($item, $mapping)) {
                    continue;
                }

                $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];
                $skuKey = $this->resolveSkuKey($item, $filter);
                $tierMin = isset($item['tierMinimumUnits']) && is_numeric($item['tierMinimumUnits'])
                    ? (float) $item['tierMinimumUnits']
                    : 0.0;

                $rawUnit = trim((string) ($item['unitOfMeasure'] ?? 'Units'));
                $unit = $this->normalizeUnit($rawUnit, (string) ($mapping['unit'] ?? $rawUnit));

                $matched[] = [
                    'provider' => 'azure',
                    'service_id' => (string) $mapping['serviceId'],
                    'sku_key' => $skuKey,
                    'region' => $region,
                    'unit' => $unit,
                    'unit_price' => (float) $item['retailPrice'],
                    'currency' => 'USD',
                    'tier_min' => $tierMin,
                    'tier_max' => null,
                    'attrs' => array_filter([
                        'unitRole' => (string) ($mapping['unitRole'] ?? ''),
                        'serviceName' => $item['serviceName'] ?? null,
                        'productName' => $item['productName'] ?? null,
                        'skuName' => $item['skuName'] ?? null,
                        'meterName' => $item['meterName'] ?? null,
                        'armSkuName' => $item['armSkuName'] ?? null,
                        'meterId' => $item['meterId'] ?? null,
                        'rawUnit' => $rawUnit,
                    ], static fn (mixed $v): bool => $v !== null && $v !== ''),
                ];
            }
        }

        return $this->deriveProgressiveTiersAndSort($matched);
    }

    /**
     * Exclude Spot, Low Priority, and Windows meters across productName, skuName, and meterName.
     *
     * @param  array<string, mixed>  $item
     */
    private function isGloballyExcluded(array $item): bool
    {
        $haystack = strtolower(implode(' ', [
            (string) ($item['productName'] ?? ''),
            (string) ($item['skuName'] ?? ''),
            (string) ($item['meterName'] ?? ''),
        ]));

        foreach (self::GLOBAL_EXCLUDES as $term) {
            if (str_contains($haystack, $term)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<string, mixed>  $item
     * @param  array<string, mixed>  $mapping
     */
    private function matchesMapping(array $item, array $mapping): bool
    {
        $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];
        $serviceName = (string) ($filter['serviceName'] ?? '');
        if ($serviceName !== '' && strcasecmp((string) ($item['serviceName'] ?? ''), $serviceName) !== 0) {
            return false;
        }

        $productName = (string) ($item['productName'] ?? '');
        $skuName = (string) ($item['skuName'] ?? '');
        $meterName = (string) ($item['meterName'] ?? '');

        if (isset($filter['productContains']) && $filter['productContains'] !== '') {
            if (stripos($productName, (string) $filter['productContains']) === false) {
                return false;
            }
        }

        if (isset($filter['meterContains']) && $filter['meterContains'] !== '') {
            if (stripos($meterName, (string) $filter['meterContains']) === false) {
                return false;
            }
        }

        $combined = strtolower($productName.' '.$skuName.' '.$meterName);
        if (isset($filter['exclude']) && is_array($filter['exclude'])) {
            foreach ($filter['exclude'] as $term) {
                $needle = strtolower((string) $term);
                if ($needle !== '' && str_contains($combined, $needle)) {
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
        $keyBy = (string) ($filter['keyBy'] ?? 'meterName');
        $candidate = trim((string) ($item[$keyBy] ?? ''));
        if ($candidate !== '') {
            return $candidate;
        }

        $fallback = trim((string) ($item['meterName'] ?? $item['skuName'] ?? $item['armSkuName'] ?? ''));

        return $fallback !== '' ? $fallback : 'unknown';
    }

    private function normalizeUnit(string $rawUnit, string $mappingUnit): string
    {
        return match ($rawUnit) {
            '1 Hour', '1/Hour' => 'Hours',
            '1 GB/Month' => 'GB-Mo',
            '1 GB' => 'GB',
            '1/Day' => 'Day',
            '1/Month' => 'Month',
            default => $mappingUnit !== '' ? $mappingUnit : $rawUnit,
        };
    }

    /**
     * Sort progressive tiers ascending per (service_id, sku_key, region, unitRole)
     * and populate tier_max from each subsequent tierMinimumUnits boundary.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    private function deriveProgressiveTiersAndSort(array $rows): array
    {
        /** @var array<string, array<string, array<string, mixed>>> $grouped */
        $grouped = [];

        foreach ($rows as $row) {
            $unitRole = (string) ($row['attrs']['unitRole'] ?? '');
            $groupKey = implode('|', [
                (string) $row['service_id'],
                (string) $row['sku_key'],
                (string) $row['region'],
                $unitRole,
            ]);
            $tierKey = number_format((float) ($row['tier_min'] ?? 0.0), 4, '.', '');
            if (! isset($grouped[$groupKey][$tierKey])) {
                $grouped[$groupKey][$tierKey] = $row;
            }
        }

        ksort($grouped);
        $result = [];

        foreach ($grouped as $tiersByMin) {
            $tiers = array_values($tiersByMin);
            usort($tiers, static fn (array $a, array $b): int => ($a['tier_min'] <=> $b['tier_min']));

            $count = count($tiers);
            for ($i = 0; $i < $count; $i++) {
                $tiers[$i]['tier_max'] = ($i + 1 < $count) ? $tiers[$i + 1]['tier_min'] : null;
                $result[] = $tiers[$i];
            }
        }

        return $result;
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
