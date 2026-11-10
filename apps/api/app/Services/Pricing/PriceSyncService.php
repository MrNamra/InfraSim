<?php

namespace App\Services\Pricing;

use App\Models\Price;
use App\Models\PriceSnapshot;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/**
 * Orchestrates idempotent provider price fetching, validation, anomaly detection,
 * and atomic staging -> published snapshot swaps.
 */
class PriceSyncService
{
    public const CACHE_VERSION_KEY = 'pricing:snapshot:version';

    /** @var array<string, PriceFetcherInterface> */
    private array $fetchers = [];

    public function __construct(
        private readonly PriceSkuMapRepository $skuMapRepository,
        AwsPricingFetcher $awsFetcher,
        AzurePricingFetcher $azureFetcher,
        GcpPricingFetcher $gcpFetcher,
        OciPricingFetcher $ociFetcher,
    ) {
        $this->fetchers = [
            $awsFetcher->provider() => $awsFetcher,
            $azureFetcher->provider() => $azureFetcher,
            $gcpFetcher->provider() => $gcpFetcher,
            $ociFetcher->provider() => $ociFetcher,
        ];
    }

    /**
     * Register an additional provider fetcher (used by GCP/OCI in T2.7 or tests).
     */
    public function registerFetcher(PriceFetcherInterface $fetcher): void
    {
        $this->fetchers[$fetcher->provider()] = $fetcher;
    }

    /**
     * Return all supported provider keys currently wired in this service.
     *
     * @return list<string>
     */
    public function supportedProviders(): array
    {
        return array_keys($this->fetchers);
    }

    /**
     * Sync pricing for one provider atomically. Keeps any prior published snapshot
     * untouched if fetching, parsing, or database persistence fails.
     *
     * @param  list<string>  $regions
     * @return array<string, mixed>
     */
    public function syncProvider(
        string $provider,
        array $regions = [],
        ?string $fixturePath = null,
        bool $force = false,
    ): array {
        $fetcher = $this->fetchers[$provider] ?? null;
        if ($fetcher === null) {
            throw new PriceSyncException("Unsupported pricing provider: '{$provider}'.");
        }

        $this->skuMapRepository->syncDatabase();
        $mappings = $this->skuMapRepository->mappingsForProvider($provider);

        $batch = $fetcher->fetch($regions, $mappings, $fixturePath);

        $previousPublished = PriceSnapshot::query()
            ->where('provider', $provider)
            ->where('status', PriceSnapshot::STATUS_PUBLISHED)
            ->orderByDesc('fetched_at')
            ->first();

        if (! $force && $previousPublished !== null && $previousPublished->raw_hash === $batch->rawHash) {
            return [
                'provider' => $provider,
                'status' => 'skipped_unchanged',
                'snapshotId' => $previousPublished->id,
                'rawHash' => $batch->rawHash,
                'rowsWritten' => 0,
                'alerts' => [],
                'warnings' => $batch->warnings,
            ];
        }

        $alerts = $this->detectAnomalies($previousPublished, $batch->prices);
        if ($alerts !== []) {
            $this->emitAlerts($provider, $alerts);
        }

        $snapshot = DB::transaction(static function () use ($batch, $provider): PriceSnapshot {
            $staging = PriceSnapshot::query()->create([
                'provider' => $provider,
                'fetched_at' => CarbonImmutable::now('UTC'),
                'source_url' => $batch->sourceUrl,
                'raw_hash' => $batch->rawHash,
                'status' => PriceSnapshot::STATUS_STAGING,
            ]);

            $insertRows = [];
            foreach ($batch->prices as $row) {
                $insertRows[] = [
                    'snapshot_id' => $staging->id,
                    'provider' => $row['provider'],
                    'service_id' => $row['service_id'],
                    'sku_key' => $row['sku_key'],
                    'region' => $row['region'],
                    'unit' => $row['unit'],
                    'unit_price' => $row['unit_price'],
                    'currency' => $row['currency'] ?? 'USD',
                    'tier_min' => $row['tier_min'],
                    'tier_max' => $row['tier_max'],
                    'attrs' => json_encode($row['attrs'] ?? [], JSON_THROW_ON_ERROR),
                ];
            }

            foreach (array_chunk($insertRows, 500) as $chunk) {
                Price::query()->insert($chunk);
            }

            PriceSnapshot::query()
                ->where('provider', $provider)
                ->where('status', PriceSnapshot::STATUS_PUBLISHED)
                ->where('id', '!=', $staging->id)
                ->update(['status' => PriceSnapshot::STATUS_ARCHIVED]);

            $staging->status = PriceSnapshot::STATUS_PUBLISHED;
            $staging->save();

            return $staging;
        });

        $this->bumpSnapshotCacheVersion();

        return [
            'provider' => $provider,
            'status' => 'published',
            'snapshotId' => $snapshot->id,
            'rawHash' => $batch->rawHash,
            'rowsWritten' => count($batch->prices),
            'alerts' => $alerts,
            'warnings' => $batch->warnings,
        ];
    }

    /**
     * Evaluate anomaly rules (file 14 §8):
     * - > 20% of common SKUs changing by > 30%
     * - Any previously synced mapped service_id disappearing
     * - Distinct service coverage dropping
     *
     * @param  list<array<string, mixed>>  $newPrices
     * @return list<array<string, mixed>>
     */
    private function detectAnomalies(?PriceSnapshot $previousSnapshot, array $newPrices): array
    {
        if ($previousSnapshot === null) {
            return [];
        }

        $previousRows = Price::query()
            ->where('snapshot_id', $previousSnapshot->id)
            ->get();

        if ($previousRows->isEmpty()) {
            return [];
        }

        /** @var array<string, float> $prevByKey */
        $prevByKey = [];
        /** @var array<string, bool> $prevServices */
        $prevServices = [];

        foreach ($previousRows as $row) {
            $unitRole = (string) ($row->attrs['unitRole'] ?? '');
            $tierKey = $row->tier_min !== null ? number_format((float) $row->tier_min, 4, '.', '') : 'none';
            $key = "{$row->service_id}|{$row->sku_key}|{$row->region}|{$unitRole}|{$tierKey}";
            $prevByKey[$key] = (float) $row->unit_price;
            $prevServices[(string) $row->service_id] = true;
        }

        /** @var array<string, float> $newByKey */
        $newByKey = [];
        /** @var array<string, bool> $newServices */
        $newServices = [];

        foreach ($newPrices as $row) {
            $unitRole = (string) ($row['attrs']['unitRole'] ?? '');
            $tierKey = $row['tier_min'] !== null ? number_format((float) $row['tier_min'], 4, '.', '') : 'none';
            $key = "{$row['service_id']}|{$row['sku_key']}|{$row['region']}|{$unitRole}|{$tierKey}";
            $newByKey[$key] = (float) $row['unit_price'];
            $newServices[(string) $row['service_id']] = true;
        }

        $alerts = [];
        $pctThreshold = (float) config('pricing.alert_pct_delta', 0.30);
        $fractionThreshold = (float) config('pricing.alert_change_fraction', 0.20);

        $comparableCount = 0;
        $changedCount = 0;

        foreach ($prevByKey as $key => $oldPrice) {
            if (! array_key_exists($key, $newByKey)) {
                continue;
            }
            $comparableCount++;
            $newPrice = $newByKey[$key];
            if ($oldPrice > 0.0) {
                $delta = abs($newPrice - $oldPrice) / $oldPrice;
                if ($delta > $pctThreshold) {
                    $changedCount++;
                }
            } elseif ($newPrice > 0.0) {
                $changedCount++;
            }
        }

        if ($comparableCount > 0) {
            $fraction = $changedCount / $comparableCount;
            if ($fraction > $fractionThreshold) {
                $alerts[] = [
                    'kind' => 'price_spike_fraction',
                    'message' => sprintf(
                        '%.1f%% of compared SKUs (%d/%d) shifted by more than %.0f%%.',
                        $fraction * 100,
                        $changedCount,
                        $comparableCount,
                        $pctThreshold * 100,
                    ),
                    'changedCount' => $changedCount,
                    'comparableCount' => $comparableCount,
                ];
            }
        }

        $disappeared = array_values(array_diff(array_keys($prevServices), array_keys($newServices)));
        if ($disappeared !== []) {
            $alerts[] = [
                'kind' => 'mapped_service_disappeared',
                'message' => 'Previously synced service_ids disappeared from new snapshot: '.implode(', ', $disappeared),
                'serviceIds' => $disappeared,
            ];
        }

        $prevCount = count($prevServices);
        $newCount = count($newServices);
        if ($newCount < $prevCount) {
            $alerts[] = [
                'kind' => 'coverage_drop',
                'message' => "Synced service coverage dropped from {$prevCount} to {$newCount}.",
                'previousCount' => $prevCount,
                'newCount' => $newCount,
            ];
        }

        return $alerts;
    }

    /** @param list<array<string, mixed>> $alerts */
    private function emitAlerts(string $provider, array $alerts): void
    {
        Log::warning('Pricing sync anomaly detected', [
            'provider' => $provider,
            'alerts' => $alerts,
        ]);

        $adminEmail = config('pricing.admin_email');
        if (is_string($adminEmail) && $adminEmail !== '') {
            try {
                $lines = array_map(static fn (array $a): string => '- '.$a['message'], $alerts);
                Mail::raw(
                    "InfraSim price sync anomaly alert for provider {$provider}:\n\n".implode("\n", $lines),
                    static function ($message) use ($adminEmail, $provider): void {
                        $message->to($adminEmail)->subject("[InfraSim] Price sync anomaly: {$provider}");
                    },
                );
            } catch (\Throwable $e) {
                Log::warning('Failed to send price alert email', ['error' => $e->getMessage()]);
            }
        }
    }

    public function snapshotCacheVersion(): int
    {
        return (int) Cache::get(self::CACHE_VERSION_KEY, 1);
    }

    private function bumpSnapshotCacheVersion(): void
    {
        $next = $this->snapshotCacheVersion() + 1;
        Cache::forever(self::CACHE_VERSION_KEY, $next);
    }
}
