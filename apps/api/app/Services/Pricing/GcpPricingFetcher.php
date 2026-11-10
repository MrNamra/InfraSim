<?php

namespace App\Services\Pricing;

use Illuminate\Support\Facades\Http;
use JsonException;

/**
 * Fetches and normalizes Google Cloud Billing Catalog API SKUs.
 *
 * Expects GCP_BILLING_API_KEY for live requests against
 * https://cloudbilling.googleapis.com/v1/services and never logs/persists the key.
 */
class GcpPricingFetcher implements PriceFetcherInterface
{
    public function provider(): string
    {
        return 'gcp';
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
            throw new PriceSyncException("GCP fixture file not found: {$fixturePath}");
        }

        $rawContent = file_get_contents($fixturePath);
        if ($rawContent === false) {
            throw new PriceSyncException("Unable to read GCP fixture file: {$fixturePath}");
        }

        $decoded = $this->decodeJson($rawContent, $fixturePath);

        /** @var list<array<string, mixed>> $skus */
        $skus = [];
        $serviceDisplayById = [];

        if (isset($decoded['services']) && is_array($decoded['services'])) {
            foreach ($decoded['services'] as $svc) {
                if (is_array($svc) && isset($svc['serviceId'], $svc['displayName'])) {
                    $serviceDisplayById[(string) $svc['serviceId']] = (string) $svc['displayName'];
                }
            }
        }

        if (isset($decoded['skusByService']) && is_array($decoded['skusByService'])) {
            foreach ($decoded['skusByService'] as $serviceId => $serviceSkus) {
                if (! is_array($serviceSkus)) {
                    throw new PriceSyncException("Malformed GCP fixture: skusByService['{$serviceId}'] is not a list.");
                }
                $svcName = $serviceDisplayById[(string) $serviceId] ?? (string) $serviceId;
                foreach ($serviceSkus as $sku) {
                    if (is_array($sku)) {
                        $sku['serviceDisplayName'] = $sku['serviceDisplayName'] ?? $svcName;
                        $skus[] = $sku;
                    }
                }
            }
        } elseif (isset($decoded['skus']) && is_array($decoded['skus'])) {
            foreach ($decoded['skus'] as $sku) {
                if (is_array($sku)) {
                    $skus[] = $sku;
                }
            }
        } else {
            throw new PriceSyncException('Invalid GCP pricing schema: expected skus or skusByService array.');
        }

        $rows = $this->normalizeSkus($skus, $mappings, $allowedRegions);
        if ($rows === []) {
            throw new PriceSyncException('GCP price normalization produced 0 valid rows from fixture.');
        }

        return new FetchedPriceBatch(
            provider: $this->provider(),
            sourceUrl: 'fixture://'.basename($fixturePath),
            rawHash: hash('sha256', $rawContent),
            prices: $rows,
        );
    }

    /**
     * @param  list<string>  $allowedRegions
     * @param  list<array<string, mixed>>  $mappings
     */
    private function fetchLive(array $allowedRegions, array $mappings): FetchedPriceBatch
    {
        $apiKey = trim((string) (config('services.gcp.billing_api_key') ?? config('pricing.sources.gcp.api_key') ?? ''));
        if ($apiKey === '') {
            throw new PriceSyncException('GCP_BILLING_API_KEY is not configured; cannot query live Cloud Billing Catalog API.');
        }

        $baseUrl = rtrim((string) config('pricing.sources.gcp.base_url'), '/');
        $maxPages = max(1, (int) config('pricing.max_pages', 100));
        $maxRuntime = max(10, (int) config('pricing.max_runtime_seconds', 240));
        $startedAt = microtime(true);

        $wantedServiceNames = [];
        foreach ($mappings as $mapping) {
            $name = (string) ($mapping['filter']['serviceDisplayName'] ?? '');
            if ($name !== '') {
                $wantedServiceNames[strtolower($name)] = true;
            }
        }

        $services = [];
        $pageToken = null;
        $page = 0;

        do {
            if ((microtime(true) - $startedAt) > $maxRuntime) {
                throw new PriceSyncException("GCP services fetch aborted: exceeded max_runtime_seconds ({$maxRuntime}s).");
            }
            $page++;
            if ($page > $maxPages) {
                break;
            }

            $query = ['key' => $apiKey, 'pageSize' => 200];
            if ($pageToken !== null) {
                $query['pageToken'] = $pageToken;
            }

            $resp = Http::retry(3, 500)->timeout(30)->acceptJson()->get("{$baseUrl}/services", $query);
            if ($resp->failed()) {
                throw new PriceSyncException("Failed fetching GCP Billing services: HTTP {$resp->status()}.");
            }

            $data = $this->decodeJson($resp->body(), "{$baseUrl}/services");
            if (! isset($data['services']) || ! is_array($data['services'])) {
                throw new PriceSyncException('Malformed GCP /services response: missing services list.');
            }

            foreach ($data['services'] as $svc) {
                if (! is_array($svc) || ! isset($svc['serviceId'], $svc['displayName'])) {
                    continue;
                }
                if ($wantedServiceNames === [] || isset($wantedServiceNames[strtolower((string) $svc['displayName'])])) {
                    $services[] = $svc;
                }
            }

            $pageToken = is_string($data['nextPageToken'] ?? null) && $data['nextPageToken'] !== '' ? $data['nextPageToken'] : null;
        } while ($pageToken !== null);

        $allSkus = [];
        $hashContext = hash_init('sha256');
        $warnings = [];

        foreach ($services as $svc) {
            $svcId = (string) $svc['serviceId'];
            $svcName = (string) $svc['displayName'];
            $skuPageToken = null;
            $skuPage = 0;

            do {
                if ((microtime(true) - $startedAt) > $maxRuntime) {
                    throw new PriceSyncException("GCP SKU fetch aborted: exceeded max_runtime_seconds ({$maxRuntime}s).");
                }
                $skuPage++;
                if ($skuPage > $maxPages) {
                    $warnings[] = "GCP SKU pagination capped at {$maxPages} pages for {$svcName}.";

                    break;
                }

                $query = ['key' => $apiKey, 'currencyCode' => 'USD', 'pageSize' => 500];
                if ($skuPageToken !== null) {
                    $query['pageToken'] = $skuPageToken;
                }

                $resp = Http::retry(3, 500)->timeout(30)->acceptJson()->get("{$baseUrl}/services/{$svcId}/skus", $query);
                if ($resp->failed()) {
                    $warnings[] = "Failed fetching GCP SKUs for {$svcName} ({$svcId}): HTTP {$resp->status()}.";

                    break;
                }

                $body = $resp->body();
                hash_update($hashContext, "{$svcId}:".hash('sha256', $body));
                $data = $this->decodeJson($body, "{$baseUrl}/services/{$svcId}/skus");

                foreach ((is_array($data['skus'] ?? null) ? $data['skus'] : []) as $sku) {
                    if (is_array($sku)) {
                        $sku['serviceDisplayName'] = $sku['serviceDisplayName'] ?? $svcName;
                        $allSkus[] = $sku;
                    }
                }

                $skuPageToken = is_string($data['nextPageToken'] ?? null) && $data['nextPageToken'] !== '' ? $data['nextPageToken'] : null;
            } while ($skuPageToken !== null);
        }

        $rows = $this->normalizeSkus($allSkus, $mappings, $allowedRegions);
        if ($rows === []) {
            throw new PriceSyncException('GCP live price sync produced 0 valid rows.');
        }

        return new FetchedPriceBatch(
            provider: $this->provider(),
            sourceUrl: "{$baseUrl}/services",
            rawHash: hash_final($hashContext),
            prices: $rows,
            warnings: $warnings,
        );
    }

    /**
     * @param  list<array<string, mixed>>  $skus
     * @param  list<array<string, mixed>>  $mappings
     * @param  list<string>  $allowedRegions
     * @return list<array<string, mixed>>
     */
    private function normalizeSkus(array $skus, array $mappings, array $allowedRegions): array
    {
        $rows = [];

        foreach ($skus as $sku) {
            $category = is_array($sku['category'] ?? null) ? $sku['category'] : [];
            $usageType = (string) ($category['usageType'] ?? 'OnDemand');
            if (strcasecmp($usageType, 'OnDemand') !== 0) {
                continue;
            }

            $pricingInfo = is_array($sku['pricingInfo'] ?? null) ? $sku['pricingInfo'] : [];
            if ($pricingInfo === [] || ! is_array($pricingInfo[0]['pricingExpression'] ?? null)) {
                continue;
            }

            $expr = $pricingInfo[0]['pricingExpression'];
            $tieredRates = is_array($expr['tieredRates'] ?? null) ? $expr['tieredRates'] : [];
            if ($tieredRates === []) {
                continue;
            }

            $rawRegions = is_array($sku['serviceRegions'] ?? null) ? array_map('strval', $sku['serviceRegions']) : ['global'];
            $matchedRegions = $this->resolveRegions($rawRegions, $allowedRegions);
            if ($matchedRegions === []) {
                continue;
            }

            foreach ($mappings as $mapping) {
                if (! $this->matchesSku($sku, $category, $mapping)) {
                    continue;
                }

                $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];
                $priceScale = isset($filter['priceScale']) && is_numeric($filter['priceScale'])
                    ? (float) $filter['priceScale']
                    : 1.0;

                usort($tieredRates, static function (array $a, array $b): int {
                    return ((float) ($a['startUsageAmount'] ?? 0)) <=> ((float) ($b['startUsageAmount'] ?? 0));
                });

                $rawUnit = trim((string) ($expr['usageUnitDescription'] ?? $expr['usageUnit'] ?? 'Units'));
                $unit = $this->normalizeUnit($rawUnit, (string) ($mapping['unit'] ?? $rawUnit));
                $skuKey = $this->resolveSkuKey($sku, $category, $filter);

                $rateCount = count($tieredRates);
                for ($i = 0; $i < $rateCount; $i++) {
                    $rate = $tieredRates[$i];
                    $unitPriceObj = is_array($rate['unitPrice'] ?? null) ? $rate['unitPrice'] : [];
                    if (strtoupper((string) ($unitPriceObj['currencyCode'] ?? 'USD')) !== 'USD') {
                        continue;
                    }

                    $units = (float) ($unitPriceObj['units'] ?? 0);
                    $nanos = (float) ($unitPriceObj['nanos'] ?? 0);
                    $rawUsd = $units + ($nanos / 1_000_000_000.0);

                    $scaledPrice = $rawUsd * $priceScale;
                    $tierMin = (float) ($rate['startUsageAmount'] ?? 0.0);
                    $nextMin = ($i + 1 < $rateCount) ? (float) ($tieredRates[$i + 1]['startUsageAmount'] ?? 0.0) : null;

                    if ($priceScale > 0.0 && abs($priceScale - 1.0) > 1e-12) {
                        $tierMin = $tierMin / $priceScale;
                        $nextMin = $nextMin !== null ? ($nextMin / $priceScale) : null;
                    }

                    foreach ($matchedRegions as $region) {
                        $rows[] = [
                            'provider' => 'gcp',
                            'service_id' => (string) $mapping['serviceId'],
                            'sku_key' => $skuKey,
                            'region' => $region,
                            'unit' => $unit,
                            'unit_price' => $scaledPrice,
                            'currency' => 'USD',
                            'tier_min' => $tierMin,
                            'tier_max' => $nextMin,
                            'attrs' => array_filter([
                                'unitRole' => (string) ($mapping['unitRole'] ?? ''),
                                'skuId' => $sku['skuId'] ?? null,
                                'serviceDisplayName' => $category['serviceDisplayName'] ?? ($sku['serviceDisplayName'] ?? null),
                                'resourceFamily' => $category['resourceFamily'] ?? null,
                                'resourceGroup' => $category['resourceGroup'] ?? null,
                                'description' => $sku['description'] ?? null,
                                'rawUnit' => $rawUnit,
                            ], static fn (mixed $v): bool => $v !== null && $v !== ''),
                        ];
                    }
                }
            }
        }

        return $this->deduplicateAndSort($rows);
    }

    /**
     * @param  array<string, mixed>  $sku
     * @param  array<string, mixed>  $category
     * @param  array<string, mixed>  $mapping
     */
    private function matchesSku(array $sku, array $category, array $mapping): bool
    {
        $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];
        $svcName = (string) ($category['serviceDisplayName'] ?? ($sku['serviceDisplayName'] ?? ''));

        if (isset($filter['serviceDisplayName']) && $filter['serviceDisplayName'] !== '') {
            if (stripos($svcName, (string) $filter['serviceDisplayName']) === false) {
                return false;
            }
        }

        if (isset($filter['resourceFamily']) && $filter['resourceFamily'] !== '') {
            if (strcasecmp((string) ($category['resourceFamily'] ?? ''), (string) $filter['resourceFamily']) !== 0) {
                return false;
            }
        }

        if (isset($filter['resourceGroup']) && $filter['resourceGroup'] !== '') {
            if (strcasecmp((string) ($category['resourceGroup'] ?? ''), (string) $filter['resourceGroup']) !== 0) {
                return false;
            }
        }

        $description = (string) ($sku['description'] ?? '');
        if (isset($filter['descriptionContains']) && $filter['descriptionContains'] !== '') {
            if (stripos($description, (string) $filter['descriptionContains']) === false) {
                return false;
            }
        }

        $searchable = strtolower($description.' '.(string) ($category['resourceGroup'] ?? '').' '.$svcName);
        foreach (['preemptible', 'spot', 'commitment', 'commit '] as $globalExclude) {
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
     * @param  list<string>  $rawRegions
     * @param  list<string>  $allowedRegions
     * @return list<string>
     */
    private function resolveRegions(array $rawRegions, array $allowedRegions): array
    {
        $isGlobal = false;
        $regional = [];
        foreach ($rawRegions as $region) {
            $r = trim($region);
            if ($r === '' || strcasecmp($r, 'global') === 0 || strcasecmp($r, 'multi-region') === 0 || $r === 'us' || $r === 'eu' || $r === 'asia') {
                $isGlobal = true;
            } else {
                $regional[] = $r;
            }
        }

        if ($isGlobal && $regional === []) {
            return ['global'];
        }

        if ($allowedRegions === []) {
            return $regional !== [] ? array_values(array_unique($regional)) : ['global'];
        }

        $matched = array_values(array_intersect($regional, $allowedRegions));
        if ($matched === [] && $isGlobal) {
            return ['global'];
        }

        return $matched;
    }

    /**
     * @param  array<string, mixed>  $sku
     * @param  array<string, mixed>  $category
     * @param  array<string, mixed>  $filter
     */
    private function resolveSkuKey(array $sku, array $category, array $filter): string
    {
        $keyBy = (string) ($filter['keyBy'] ?? 'description');
        $candidate = match ($keyBy) {
            'skuId' => (string) ($sku['skuId'] ?? ''),
            'resourceGroup' => (string) ($category['resourceGroup'] ?? ''),
            default => (string) ($sku['description'] ?? ($sku['skuId'] ?? '')),
        };

        $trimmed = trim($candidate);

        return $trimmed !== '' ? $trimmed : (string) ($sku['skuId'] ?? 'unknown');
    }

    private function normalizeUnit(string $rawUnit, string $mappingUnit): string
    {
        if ($mappingUnit !== '') {
            return $mappingUnit;
        }

        return match (strtolower($rawUnit)) {
            'hour', 'h' => 'Hours',
            'gibibyte month', 'giby.mo' => 'GB-Mo',
            'gibibyte', 'giby' => 'GB',
            default => $rawUnit,
        };
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
