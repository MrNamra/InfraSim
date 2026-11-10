<?php

namespace App\Services\Pricing;

use Illuminate\Support\Facades\Http;
use JsonException;

/**
 * Fetches and normalizes AWS Price List Bulk API offer JSONs.
 *
 * Verified live against https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json
 * (OnDemand terms, priceDimensions progressivity via beginRange/endRange, and attribute casing).
 */
class AwsPricingFetcher implements PriceFetcherInterface
{
    private const UNIT_BASE_SINGULAR = [
        'request',
        'requests',
        'readrequestunits',
        'writerequestunits',
        'replicatedwriterequestunits',
        'transition',
        'transitions',
        'statetransition',
        'statetransitions',
        'message',
        'messages',
        'email',
        'emails',
        'query',
        'queries',
    ];

    public function provider(): string
    {
        return 'aws';
    }

    /**
     * {@inheritDoc}
     */
    public function fetch(array $regions, array $mappings, ?string $fixturePath = null): FetchedPriceBatch
    {
        $warnings = [];
        $allowedRegions = array_values(array_filter(array_map('trim', $regions), static fn (string $r): bool => $r !== ''));

        if ($fixturePath !== null) {
            return $this->fetchFromFixture($fixturePath, $allowedRegions, $mappings);
        }

        return $this->fetchLive($allowedRegions, $mappings, $warnings);
    }

    /**
     * @param  list<string>  $allowedRegions
     * @param  list<array<string, mixed>>  $mappings
     */
    private function fetchFromFixture(string $fixturePath, array $allowedRegions, array $mappings): FetchedPriceBatch
    {
        if (! is_file($fixturePath)) {
            throw new PriceSyncException("AWS fixture file not found: {$fixturePath}");
        }

        $rawContent = file_get_contents($fixturePath);
        if ($rawContent === false) {
            throw new PriceSyncException("Unable to read AWS fixture file: {$fixturePath}");
        }

        $decoded = $this->decodeJson($rawContent, $fixturePath);

        /** @var array<string, array<string, mixed>> $offersByCode */
        $offersByCode = [];
        if (isset($decoded['offers']) && is_array($decoded['offers'])) {
            foreach ($decoded['offers'] as $code => $offerPayload) {
                if (! is_array($offerPayload)) {
                    throw new PriceSyncException("AWS fixture offer payload for '{$code}' is invalid.");
                }
                $offersByCode[(string) $code] = $offerPayload;
            }
        } elseif (isset($decoded['products'], $decoded['terms'])) {
            $code = (string) ($decoded['offerCode'] ?? 'SingleOffer');
            $offersByCode[$code] = $decoded;
        } else {
            throw new PriceSyncException('Invalid AWS pricing schema: expected products+terms or offers map.');
        }

        $prices = [];
        foreach ($offersByCode as $offerCode => $offerPayload) {
            $this->validateOfferStructure($offerPayload, (string) $offerCode);
            $matchedMappings = $offerCode === 'SingleOffer'
                ? $mappings
                : array_values(array_filter(
                    $mappings,
                    static fn (array $m): bool => ($m['filter']['serviceCode'] ?? '') === $offerCode,
                ));

            foreach ($this->normalizeOffer($offerPayload, $matchedMappings, $allowedRegions) as $row) {
                $prices[] = $row;
            }
        }

        $deduped = $this->deduplicateAndSort($prices);
        if ($deduped === []) {
            throw new PriceSyncException('AWS price normalization produced 0 valid rows from fixture.');
        }

        return new FetchedPriceBatch(
            provider: $this->provider(),
            sourceUrl: 'fixture://'.basename($fixturePath),
            rawHash: hash('sha256', $rawContent),
            prices: $deduped,
        );
    }

    /**
     * @param  list<string>  $allowedRegions
     * @param  list<array<string, mixed>>  $mappings
     * @param  list<string>  $warnings
     */
    private function fetchLive(array $allowedRegions, array $mappings, array $warnings): FetchedPriceBatch
    {
        $indexUrl = (string) config('pricing.sources.aws.index_url');
        $baseUrl = rtrim((string) config('pricing.sources.aws.base_url'), '/');
        $maxRuntime = max(10, (int) config('pricing.max_runtime_seconds', 240));
        $startedAt = microtime(true);

        $indexResp = Http::retry(3, 500)->timeout(30)->acceptJson()->get($indexUrl);
        if ($indexResp->failed()) {
            throw new PriceSyncException("Failed fetching AWS pricing index HTTP {$indexResp->status()} from {$indexUrl}");
        }

        $indexData = $this->decodeJson($indexResp->body(), $indexUrl);
        if (! isset($indexData['offers']) || ! is_array($indexData['offers'])) {
            throw new PriceSyncException('Unexpected AWS Bulk index.json schema: missing offers map.');
        }

        /** @var array<string, list<array<string, mixed>>> $byService */
        $byService = [];
        foreach ($mappings as $mapping) {
            $code = (string) ($mapping['filter']['serviceCode'] ?? '');
            if ($code !== '') {
                $byService[$code][] = $mapping;
            }
        }

        $targetRegions = $allowedRegions !== [] ? $allowedRegions : ['us-east-1'];
        $hashContext = hash_init('sha256');
        $prices = [];

        foreach ($byService as $serviceCode => $serviceMappings) {
            if ((microtime(true) - $startedAt) > $maxRuntime) {
                throw new PriceSyncException("AWS price sync aborted: exceeded max_runtime_seconds ({$maxRuntime}s).");
            }

            $offerMeta = $indexData['offers'][$serviceCode] ?? null;
            if (! is_array($offerMeta)) {
                $warnings[] = "AWS offer '{$serviceCode}' missing in index.json.";

                continue;
            }

            $fetchedAnyForService = false;
            foreach ($targetRegions as $region) {
                $offerUrl = "{$baseUrl}/offers/v1.0/aws/{$serviceCode}/current/{$region}/index.json";
                $resp = Http::retry(2, 400)->timeout(60)->acceptJson()->get($offerUrl);

                if ($resp->status() === 404 && isset($offerMeta['currentVersionUrl'])) {
                    $globalUrl = $baseUrl.(string) $offerMeta['currentVersionUrl'];
                    $resp = Http::retry(2, 400)->timeout(60)->acceptJson()->get($globalUrl);
                }

                if ($resp->failed()) {
                    $warnings[] = "Failed AWS offer fetch for {$serviceCode} ({$region}): HTTP {$resp->status()}.";

                    continue;
                }

                $body = $resp->body();
                hash_update($hashContext, "{$serviceCode}:{$region}:".hash('sha256', $body));
                $offerData = $this->decodeJson($body, $offerUrl);
                $this->validateOfferStructure($offerData, $serviceCode);

                foreach ($this->normalizeOffer($offerData, $serviceMappings, $allowedRegions, $region) as $row) {
                    $prices[] = $row;
                }
                $fetchedAnyForService = true;
            }

            if (! $fetchedAnyForService) {
                $warnings[] = "No AWS pricing payload fetched for offer '{$serviceCode}'.";
            }
        }

        $deduped = $this->deduplicateAndSort($prices);
        if ($deduped === []) {
            throw new PriceSyncException('AWS live price sync produced 0 valid rows across requested offers.');
        }

        return new FetchedPriceBatch(
            provider: $this->provider(),
            sourceUrl: $indexUrl,
            rawHash: hash_final($hashContext),
            prices: $deduped,
            warnings: $warnings,
        );
    }

    /**
     * Validate core structure of an AWS Bulk offer JSON document.
     *
     * @param  array<string, mixed>  $offer
     */
    private function validateOfferStructure(array $offer, string $offerCode): void
    {
        if (! isset($offer['products']) || ! is_array($offer['products'])) {
            throw new PriceSyncException("Malformed AWS offer '{$offerCode}': missing products map.");
        }

        if (! isset($offer['terms']) || ! is_array($offer['terms']) || ! isset($offer['terms']['OnDemand']) || ! is_array($offer['terms']['OnDemand'])) {
            throw new PriceSyncException("Malformed AWS offer '{$offerCode}': missing terms.OnDemand map.");
        }
    }

    /**
     * Normalize all products inside one AWS offer payload matching given mappings.
     *
     * @param  array<string, mixed>  $offer
     * @param  list<array<string, mixed>>  $mappings
     * @param  list<string>  $allowedRegions
     * @return list<array<string, mixed>>
     */
    private function normalizeOffer(
        array $offer,
        array $mappings,
        array $allowedRegions,
        string $fallbackRegion = 'us-east-1',
    ): array {
        $products = $offer['products'];
        $onDemandTerms = $offer['terms']['OnDemand'];
        $rows = [];

        foreach ($products as $sku => $product) {
            if (! is_array($product)) {
                continue;
            }

            $attrs = is_array($product['attributes'] ?? null) ? $product['attributes'] : [];
            $region = $this->resolveRegion($attrs, $fallbackRegion);
            if ($allowedRegions !== [] && $region !== 'global' && ! in_array($region, $allowedRegions, true)) {
                continue;
            }

            $skuTerms = $onDemandTerms[$sku] ?? null;
            if (! is_array($skuTerms)) {
                continue;
            }

            foreach ($mappings as $mapping) {
                if (! $this->matchesProduct($product, $attrs, $mapping)) {
                    continue;
                }

                $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];
                $skuKey = $this->resolveSkuKey($attrs, $filter, (string) $sku);
                $priceScale = isset($filter['priceScale']) && is_numeric($filter['priceScale'])
                    ? (float) $filter['priceScale']
                    : null;

                foreach ($skuTerms as $termData) {
                    $dimensions = is_array($termData['priceDimensions'] ?? null) ? $termData['priceDimensions'] : [];
                    foreach ($dimensions as $dimension) {
                        if (! is_array($dimension)) {
                            continue;
                        }
                        $usd = $dimension['pricePerUnit']['USD'] ?? null;
                        if ($usd === null || ! is_numeric($usd)) {
                            continue;
                        }

                        $rawPrice = (float) $usd;
                        $rawUnit = trim((string) ($dimension['unit'] ?? $mapping['unit'] ?? 'Units'));
                        $tierMin = isset($dimension['beginRange']) && is_numeric($dimension['beginRange'])
                            ? (float) $dimension['beginRange']
                            : 0.0;
                        $endRaw = $dimension['endRange'] ?? 'Inf';
                        $tierMax = is_numeric($endRaw) ? (float) $endRaw : null;

                        $unitPrice = $rawPrice;
                        $unit = $this->normalizeUnitLabel($rawUnit);

                        if ($priceScale !== null && $priceScale > 1.0 && in_array(strtolower($rawUnit), self::UNIT_BASE_SINGULAR, true)) {
                            $unitPrice = $rawPrice * $priceScale;
                            $unit = (string) ($mapping['unit'] ?? $unit);
                            $tierMin = $tierMin / $priceScale;
                            $tierMax = $tierMax !== null ? ($tierMax / $priceScale) : null;
                        }

                        $rows[] = [
                            'provider' => 'aws',
                            'service_id' => (string) $mapping['serviceId'],
                            'sku_key' => $skuKey,
                            'region' => $region,
                            'unit' => $unit,
                            'unit_price' => $unitPrice,
                            'currency' => 'USD',
                            'tier_min' => $tierMin,
                            'tier_max' => $tierMax,
                            'attrs' => $this->extractNormalizedAttrs($attrs, $mapping, $dimension, $rawUnit),
                        ];
                    }
                }
            }
        }

        return $rows;
    }

    /**
     * @param  array<string, mixed>  $product
     * @param  array<string, mixed>  $attrs
     * @param  array<string, mixed>  $mapping
     */
    private function matchesProduct(array $product, array $attrs, array $mapping): bool
    {
        $filter = is_array($mapping['filter'] ?? null) ? $mapping['filter'] : [];

        if (isset($filter['serviceCode'], $attrs['servicecode'])) {
            $svcCode = (string) $attrs['servicecode'];
            if ($svcCode !== '' && $svcCode !== (string) $filter['serviceCode']) {
                return false;
            }
        }

        if (isset($filter['productFamily']) && (string) ($product['productFamily'] ?? '') !== (string) $filter['productFamily']) {
            return false;
        }

        if (isset($filter['attributes']) && is_array($filter['attributes'])) {
            foreach ($filter['attributes'] as $attrKey => $expectedValue) {
                if ((string) ($attrs[$attrKey] ?? '') !== (string) $expectedValue) {
                    return false;
                }
            }
        }

        $usagetype = (string) ($attrs['usagetype'] ?? '');
        if (isset($filter['usagetypeContains']) && $filter['usagetypeContains'] !== '') {
            if (! str_contains($usagetype, (string) $filter['usagetypeContains'])) {
                return false;
            }
        }

        $groupDescription = (string) ($attrs['groupDescription'] ?? '');
        $searchableText = strtolower($usagetype.' '.$groupDescription);
        if (isset($filter['exclude']) && is_array($filter['exclude'])) {
            foreach ($filter['exclude'] as $term) {
                $needle = strtolower((string) $term);
                if ($needle !== '' && str_contains($searchableText, $needle)) {
                    return false;
                }
            }
        }

        return true;
    }

    /** @param array<string, mixed> $attrs */
    private function resolveRegion(array $attrs, string $fallbackRegion): string
    {
        $code = trim((string) ($attrs['regionCode'] ?? ''));
        if ($code === '' || strcasecmp($code, 'Any') === 0 || strcasecmp($code, 'Global') === 0) {
            return ($attrs['locationType'] ?? '') === 'AWS Edge Location'
                ? 'global'
                : ($code === '' ? $fallbackRegion : 'global');
        }

        return $code;
    }

    /**
     * @param  array<string, mixed>  $attrs
     * @param  array<string, mixed>  $filter
     */
    private function resolveSkuKey(array $attrs, array $filter, string $fallbackSku): string
    {
        $keyBy = (string) ($filter['keyBy'] ?? 'usagetype');
        $candidate = trim((string) ($attrs[$keyBy] ?? ''));
        if ($candidate !== '') {
            return $candidate;
        }

        $usagetype = trim((string) ($attrs['usagetype'] ?? ''));

        return $usagetype !== '' ? $usagetype : $fallbackSku;
    }

    private function normalizeUnitLabel(string $rawUnit): string
    {
        return match ($rawUnit) {
            'Hrs' => 'Hours',
            'LCU-Hrs' => 'LCU-Hours',
            'GB-Mo' => 'GB-Mo',
            default => $rawUnit,
        };
    }

    /**
     * @param  array<string, mixed>  $attrs
     * @param  array<string, mixed>  $mapping
     * @param  array<string, mixed>  $dimension
     * @return array<string, mixed>
     */
    private function extractNormalizedAttrs(
        array $attrs,
        array $mapping,
        array $dimension,
        string $rawUnit,
    ): array {
        $vcpu = isset($attrs['vcpu']) && is_numeric($attrs['vcpu']) ? (int) $attrs['vcpu'] : null;

        $memoryGb = null;
        if (isset($attrs['memory']) && preg_match('/^([0-9]+(?:\.[0-9]+)?)/', str_replace(',', '', (string) $attrs['memory']), $matches) === 1) {
            $memoryGb = (float) $matches[1];
        }

        return array_filter([
            'unitRole' => (string) ($mapping['unitRole'] ?? ''),
            'serviceCode' => $attrs['servicecode'] ?? ($mapping['filter']['serviceCode'] ?? null),
            'instanceType' => $attrs['instanceType'] ?? null,
            'usagetype' => $attrs['usagetype'] ?? null,
            'vcpu' => $vcpu,
            'memoryGb' => $memoryGb,
            'rawUnit' => $rawUnit,
            'description' => $dimension['description'] ?? null,
        ], static fn (mixed $v): bool => $v !== null && $v !== '');
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
            $compositeKey = implode('|', [
                (string) $row['service_id'],
                (string) $row['sku_key'],
                (string) $row['region'],
                $unitRole,
                $tierKey,
            ]);

            if (! isset($unique[$compositeKey])) {
                $unique[$compositeKey] = $row;
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
