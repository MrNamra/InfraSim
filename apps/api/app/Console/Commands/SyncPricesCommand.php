<?php

namespace App\Console\Commands;

use App\Services\Pricing\PriceSyncException;
use App\Services\Pricing\PriceSyncService;
use Illuminate\Console\Command;

/**
 * Fetch and atomically publish public cloud pricing snapshots.
 */
class SyncPricesCommand extends Command
{
    protected $signature = 'prices:sync
        {--provider=all : Provider to sync (aws, azure, or all)}
        {--regions=us-east-1,eastus : Comma-separated regions to filter}
        {--file= : Optional local JSON fixture path (requires a single --provider)}
        {--force : Re-publish snapshot even when raw_hash matches}';

    protected $description = 'Sync public cloud list prices from provider APIs or recorded offline fixtures';

    public function handle(PriceSyncService $syncService): int
    {
        $providerOpt = strtolower(trim((string) $this->option('provider')));
        $regionsOpt = trim((string) $this->option('regions'));
        $fixturePath = $this->option('file');
        $force = (bool) $this->option('force');

        $regions = $regionsOpt === ''
            ? []
            : array_values(array_filter(array_map('trim', explode(',', $regionsOpt)), static fn (string $r): bool => $r !== ''));

        $supported = $syncService->supportedProviders();
        if ($providerOpt === 'all') {
            $providers = $supported;
        } elseif (in_array($providerOpt, $supported, true)) {
            $providers = [$providerOpt];
        } else {
            $this->error("Unsupported --provider '{$providerOpt}'. Supported: ".implode(', ', $supported));

            return self::FAILURE;
        }

        if (is_string($fixturePath) && $fixturePath !== '' && count($providers) > 1) {
            $this->error('Using --file= requires specifying a single --provider.');

            return self::FAILURE;
        }

        $failed = false;

        foreach ($providers as $provider) {
            $providerRegions = $this->regionsForProvider($provider, $regions);

            try {
                $result = $syncService->syncProvider(
                    provider: $provider,
                    regions: $providerRegions,
                    fixturePath: is_string($fixturePath) && $fixturePath !== '' ? $fixturePath : null,
                    force: $force,
                );

                $this->info(sprintf(
                    '[%s] status=%s snapshot=%s rows=%d hash=%s',
                    $provider,
                    $result['status'],
                    (string) ($result['snapshotId'] ?? '-'),
                    (int) ($result['rowsWritten'] ?? 0),
                    substr((string) ($result['rawHash'] ?? ''), 0, 12),
                ));

                foreach ($result['alerts'] as $alert) {
                    $this->warn("[{$provider}] ALERT: {$alert['message']}");
                }
                foreach ($result['warnings'] as $warning) {
                    $this->warn("[{$provider}] {$warning}");
                }
            } catch (PriceSyncException $e) {
                $this->error("[{$provider}] Sync failed (previous snapshot preserved): {$e->getMessage()}");
                $failed = true;
            }
        }

        return $failed ? self::FAILURE : self::SUCCESS;
    }

    /**
     * Filter CLI comma-separated regions appropriately per provider naming conventions.
     *
     * @param  list<string>  $regions
     * @return list<string>
     */
    private function regionsForProvider(string $provider, array $regions): array
    {
        if ($regions === []) {
            return [];
        }

        if ($provider === 'aws') {
            $aws = array_values(array_filter($regions, static fn (string $r): bool => str_contains($r, '-') && substr_count($r, '-') >= 2));

            return $aws !== [] ? $aws : ['us-east-1'];
        }

        if ($provider === 'azure') {
            $azure = array_values(array_filter($regions, static fn (string $r): bool => ! str_contains($r, '-')));

            return $azure !== [] ? $azure : ['eastus'];
        }

        return $regions;
    }
}
