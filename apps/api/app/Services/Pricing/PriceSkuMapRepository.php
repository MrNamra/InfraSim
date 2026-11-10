<?php

namespace App\Services\Pricing;

use App\Models\Price;
use App\Models\PriceSkuMap;
use App\Models\PriceSnapshot;
use Illuminate\Support\Facades\DB;
use JsonException;

/**
 * Loads canonical SKU mappings from packages/cost-engine/data/price_sku_map.json
 * and computes catalog pricing coverage statistics.
 */
class PriceSkuMapRepository
{
    /** @var array{version: int, updatedAt: string, mappings: list<array<string, mixed>>, knownUnavailable: list<array<string, mixed>>}|null */
    private ?array $cached = null;

    /**
     * Load and validate the canonical price_sku_map.json definition.
     *
     * @return array{version: int, updatedAt: string, mappings: list<array<string, mixed>>, knownUnavailable: list<array<string, mixed>>}
     */
    public function load(): array
    {
        if ($this->cached !== null) {
            return $this->cached;
        }

        $path = (string) config('pricing.sku_map_path');
        if (! is_file($path)) {
            throw new PriceSyncException("SKU map file not found at: {$path}");
        }

        $contents = file_get_contents($path);
        if ($contents === false) {
            throw new PriceSyncException("Unable to read SKU map file: {$path}");
        }

        try {
            $decoded = json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $e) {
            throw new PriceSyncException("Invalid JSON in SKU map file: {$e->getMessage()}", 0, $e);
        }

        if (! is_array($decoded) || ! isset($decoded['mappings']) || ! is_array($decoded['mappings'])) {
            throw new PriceSyncException('Invalid SKU map structure: expected top-level mappings array.');
        }

        $this->cached = [
            'version' => (int) ($decoded['version'] ?? 1),
            'updatedAt' => (string) ($decoded['updatedAt'] ?? ''),
            'mappings' => array_values($decoded['mappings']),
            'knownUnavailable' => array_values(is_array($decoded['knownUnavailable'] ?? null) ? $decoded['knownUnavailable'] : []),
        ];

        return $this->cached;
    }

    /**
     * Return all SKU filter mappings registered for a given provider.
     *
     * @return list<array<string, mixed>>
     */
    public function mappingsForProvider(string $provider): array
    {
        $map = $this->load();

        return array_values(array_filter(
            $map['mappings'],
            static fn (array $entry): bool => ($entry['provider'] ?? '') === $provider,
        ));
    }

    /**
     * Return documented unavailable services (optional filter by provider).
     *
     * @return list<array<string, mixed>>
     */
    public function knownUnavailable(?string $provider = null): array
    {
        $list = $this->load()['knownUnavailable'];
        if ($provider === null) {
            return $list;
        }

        return array_values(array_filter(
            $list,
            static fn (array $entry): bool => ($entry['provider'] ?? '') === $provider,
        ));
    }

    /**
     * Synchronize the database price_sku_map table with price_sku_map.json.
     */
    public function syncDatabase(): void
    {
        $mappings = $this->load()['mappings'];

        DB::transaction(static function () use ($mappings): void {
            PriceSkuMap::query()->delete();

            $rows = [];
            foreach ($mappings as $entry) {
                $rows[] = [
                    'service_id' => (string) ($entry['serviceId'] ?? ''),
                    'provider' => (string) ($entry['provider'] ?? ''),
                    'filter' => json_encode($entry['filter'] ?? [], JSON_THROW_ON_ERROR),
                    'unit_role' => (string) ($entry['unitRole'] ?? ''),
                ];
            }

            foreach (array_chunk($rows, 200) as $chunk) {
                PriceSkuMap::query()->insert($chunk);
            }
        });
    }

    /**
     * Compute per-provider catalog coverage comparing non-free services against
     * mapped and known-unavailable entries plus currently published DB snapshots.
     *
     * @param  list<string>  $providers
     * @return array<string, array<string, mixed>>
     */
    public function coverageReport(array $providers = ['aws', 'azure', 'gcp', 'oci']): array
    {
        $map = $this->load();
        $catalogDir = (string) config('pricing.catalog_dir');
        $report = [];

        foreach ($providers as $provider) {
            $catalogPath = rtrim($catalogDir, '/')."/{$provider}.json";
            $catalog = [];
            if (is_file($catalogPath)) {
                $decoded = json_decode((string) file_get_contents($catalogPath), true);
                if (is_array($decoded)) {
                    $catalog = $decoded;
                }
            }

            $total = count($catalog);
            $freeIds = [];
            $nonFreeIds = [];

            foreach ($catalog as $service) {
                if (! is_array($service) || ! isset($service['id'])) {
                    continue;
                }
                $id = (string) $service['id'];
                $model = (string) ($service['pricing']['model'] ?? 'unknown');
                if ($model === 'free') {
                    $freeIds[] = $id;
                } else {
                    $nonFreeIds[] = $id;
                }
            }

            $mappedIds = [];
            $transferIds = [];
            foreach ($map['mappings'] as $entry) {
                if (($entry['provider'] ?? '') !== $provider) {
                    continue;
                }
                $serviceId = (string) ($entry['serviceId'] ?? '');
                if (str_starts_with($serviceId, 'transfer.')) {
                    $transferIds[$serviceId] = true;
                } else {
                    $mappedIds[$serviceId] = true;
                }
            }

            $unavailableMap = [];
            foreach ($map['knownUnavailable'] as $entry) {
                if (($entry['provider'] ?? '') === $provider && isset($entry['serviceId'])) {
                    $unavailableMap[(string) $entry['serviceId']] = (string) ($entry['reason'] ?? '');
                }
            }

            $missingIds = [];
            foreach ($nonFreeIds as $serviceId) {
                if (! isset($mappedIds[$serviceId]) && ! isset($unavailableMap[$serviceId])) {
                    $missingIds[] = $serviceId;
                }
            }

            $publishedSnapshot = PriceSnapshot::query()
                ->where('provider', $provider)
                ->where('status', PriceSnapshot::STATUS_PUBLISHED)
                ->orderByDesc('fetched_at')
                ->first();

            $syncedServiceCount = 0;
            if ($publishedSnapshot !== null) {
                $syncedServiceCount = (int) Price::query()
                    ->where('snapshot_id', $publishedSnapshot->id)
                    ->where('service_id', 'not like', 'transfer.%')
                    ->distinct()
                    ->count('service_id');
            }

            $report[$provider] = [
                'totalCatalogServices' => $total,
                'freeServices' => count($freeIds),
                'nonFreeServices' => count($nonFreeIds),
                'mappedServices' => count($mappedIds),
                'knownUnavailableCount' => count($unavailableMap),
                'knownUnavailable' => array_map(
                    static fn (string $id, string $reason): array => ['serviceId' => $id, 'reason' => $reason],
                    array_keys($unavailableMap),
                    array_values($unavailableMap),
                ),
                'missingServiceIds' => $missingIds,
                'transferCategoriesMapped' => count($transferIds),
                'syncedServicesInSnapshot' => $syncedServiceCount,
                'lastPublishedAt' => $publishedSnapshot?->fetched_at?->toISOString(),
            ];
        }

        return $report;
    }
}
