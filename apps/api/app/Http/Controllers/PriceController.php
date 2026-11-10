<?php

namespace App\Http\Controllers;

use App\Models\Price;
use App\Models\PriceSnapshot;
use App\Services\Pricing\PriceSkuMapRepository;
use App\Services\Pricing\PriceSyncException;
use App\Services\Pricing\PriceSyncService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\Rule;

/**
 * Serves normalized pricing snapshots (with Redis/cache & ETag), SKU coverage stats,
 * and authenticated manual sync triggers.
 */
class PriceController extends Controller
{
    private const VALID_PROVIDERS = ['aws', 'azure', 'gcp', 'oci'];

    /**
     * Serve compact published price snapshot filtered by providers and regions.
     */
    public function snapshot(
        Request $request,
        PriceSyncService $syncService,
        PriceSkuMapRepository $skuMapRepository,
    ): Response|JsonResponse {
        $providersParam = trim((string) $request->query('providers', ''));
        $providers = $providersParam === ''
            ? self::VALID_PROVIDERS
            : array_values(array_intersect(
                self::VALID_PROVIDERS,
                array_unique(array_filter(array_map('trim', explode(',', strtolower($providersParam))))),
            ));

        if ($providers === []) {
            return response()->json(['message' => 'No valid providers requested.'], 422);
        }
        sort($providers);

        $regionsParam = trim((string) $request->query('regions', ''));
        $regions = $regionsParam === ''
            ? []
            : array_values(array_unique(array_filter(array_map('trim', explode(',', $regionsParam)))));
        sort($regions);

        $version = $syncService->snapshotCacheVersion();
        $staleAfterDays = max(1, (int) config('pricing.stale_after_days', 7));
        $cacheKey = sprintf(
            'pricing:snapshot:v%d:p=%s:r=%s:s=%d',
            $version,
            implode(',', $providers),
            implode(',', $regions),
            $staleAfterDays,
        );

        /** @var array<string, mixed> $payload */
        $payload = Cache::remember($cacheKey, 300, function () use ($providers, $regions, $version, $staleAfterDays, $skuMapRepository): array {
            $now = CarbonImmutable::now('UTC');
            $providerMeta = [];
            $snapshotIds = [];

            foreach ($providers as $provider) {
                $snapshot = PriceSnapshot::query()
                    ->where('provider', $provider)
                    ->where('status', PriceSnapshot::STATUS_PUBLISHED)
                    ->orderByDesc('fetched_at')
                    ->first();

                if ($snapshot === null) {
                    continue;
                }

                $snapshotIds[] = $snapshot->id;
                $fetchedAt = CarbonImmutable::parse($snapshot->fetched_at, 'UTC');
                $stale = $fetchedAt->diffInDays($now, absolute: true) > $staleAfterDays;

                $providerMeta[$provider] = [
                    'snapshotId' => $snapshot->id,
                    'fetchedAt' => $fetchedAt->toISOString(),
                    'sourceUrl' => $snapshot->source_url,
                    'rawHash' => $snapshot->raw_hash,
                    'stale' => $stale,
                ];
            }

            $priceRows = [];
            if ($snapshotIds !== []) {
                $query = Price::query()
                    ->whereIn('snapshot_id', $snapshotIds)
                    ->orderBy('provider')
                    ->orderBy('service_id')
                    ->orderBy('region')
                    ->orderBy('sku_key')
                    ->orderBy('tier_min');

                if ($regions !== []) {
                    $query->whereIn('region', array_values(array_unique([...$regions, 'global'])));
                }

                foreach ($query->get() as $row) {
                    $attrs = is_array($row->attrs) ? $row->attrs : [];
                    $priceRows[] = [
                        'provider' => $row->provider,
                        'serviceId' => $row->service_id,
                        'skuKey' => $row->sku_key,
                        'region' => $row->region,
                        'unit' => $row->unit,
                        'unitRole' => (string) ($attrs['unitRole'] ?? ''),
                        'unitPrice' => (float) $row->unit_price,
                        'currency' => $row->currency,
                        'tierMin' => $row->tier_min !== null ? (float) $row->tier_min : null,
                        'tierMax' => $row->tier_max !== null ? (float) $row->tier_max : null,
                        'attrs' => $attrs,
                    ];
                }
            }

            return [
                'version' => $version,
                'generatedAt' => $now->toISOString(),
                'staleAfterDays' => $staleAfterDays,
                'providers' => $providerMeta,
                'prices' => $priceRows,
                'knownUnavailable' => array_values(array_filter(
                    $skuMapRepository->knownUnavailable(),
                    static fn (array $entry): bool => in_array($entry['provider'] ?? '', $providers, true),
                )),
            ];
        });

        $json = json_encode($payload, JSON_THROW_ON_ERROR);
        $etag = '"'.sha1($json).'"';

        $ifNoneMatch = trim((string) $request->header('If-None-Match', ''));
        if ($ifNoneMatch === $etag || $ifNoneMatch === 'W/'.$etag) {
            return response('', 304, [
                'ETag' => $etag,
                'Cache-Control' => 'public, max-age=300',
            ]);
        }

        return response($json, 200, [
            'Content-Type' => 'application/json',
            'ETag' => $etag,
            'Cache-Control' => 'public, max-age=300',
        ]);
    }

    /**
     * Report catalog-to-SKU coverage per cloud provider.
     */
    public function coverage(PriceSkuMapRepository $skuMapRepository): JsonResponse
    {
        return response()->json([
            'providers' => $skuMapRepository->coverageReport(),
        ]);
    }

    /**
     * Trigger an authenticated manual price sync when enabled by configuration.
     */
    public function sync(Request $request, PriceSyncService $syncService): JsonResponse
    {
        if (! (bool) config('pricing.sync_enabled', false)) {
            return response()->json([
                'message' => 'On-demand price sync is disabled. Use php artisan prices:sync or enable PRICE_SYNC_ENABLED.',
            ], 403);
        }

        $validated = $request->validate([
            'provider' => ['nullable', 'string', Rule::in([...self::VALID_PROVIDERS, 'all'])],
            'regions' => ['nullable', 'array'],
            'regions.*' => ['string', 'max:64'],
            'force' => ['nullable', 'boolean'],
        ]);

        $providerOpt = (string) ($validated['provider'] ?? 'all');
        $providers = $providerOpt === 'all' ? $syncService->supportedProviders() : [$providerOpt];
        $regions = array_values(is_array($validated['regions'] ?? null) ? $validated['regions'] : []);
        $force = (bool) ($validated['force'] ?? false);

        $results = [];
        foreach ($providers as $provider) {
            try {
                $results[] = $syncService->syncProvider($provider, $regions, null, $force);
            } catch (PriceSyncException $e) {
                return response()->json([
                    'message' => "Price sync failed for {$provider}: {$e->getMessage()}",
                    'results' => $results,
                ], 502);
            }
        }

        return response()->json(['results' => $results]);
    }
}
