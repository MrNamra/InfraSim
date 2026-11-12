<?php

namespace App\Services\Challenges;

use App\Models\Challenge;
use App\Models\Price;
use App\Models\PriceSnapshot;
use Carbon\CarbonImmutable;
use InvalidArgumentException;
use RuntimeException;
use Symfony\Component\Process\Process;

/**
 * Verifies submitted challenge designs server-side by invoking the pure-TypeScript
 * `@infrasim/diagnosis` challenge evaluator in an isolated Node CLI subprocess
 * with server-owned constraints, fixed seed, and pinned/published price snapshots.
 */
class ChallengeVerifierService
{
    /**
     * Load either the pinned price snapshot (when integer snapshot ID exists) or the
     * latest published provider snapshots from PostgreSQL.
     *
     * @return array<string, mixed>|null
     */
    public function resolvePriceSnapshotForChallenge(Challenge $challenge): ?array
    {
        $def = $challenge->definition;
        $pinnedId = is_array($def) ? ($def['pinnedPriceSnapshotId'] ?? null) : null;

        $snapshotIds = [];
        $generatedAt = CarbonImmutable::now('UTC')->toISOString();

        if (is_numeric($pinnedId)) {
            $snap = PriceSnapshot::query()->where('id', (int) $pinnedId)->first();
            if ($snap !== null) {
                $snapshotIds[] = $snap->id;
                $generatedAt = CarbonImmutable::parse($snap->fetched_at, 'UTC')->toISOString();
            }
        }

        if ($snapshotIds === []) {
            foreach (['aws', 'azure', 'gcp', 'oci'] as $provider) {
                $snap = PriceSnapshot::query()
                    ->where('provider', $provider)
                    ->where('status', PriceSnapshot::STATUS_PUBLISHED)
                    ->orderByDesc('fetched_at')
                    ->first();
                if ($snap !== null) {
                    $snapshotIds[] = $snap->id;
                    $generatedAt = CarbonImmutable::parse($snap->fetched_at, 'UTC')->toISOString();
                }
            }
        }

        if ($snapshotIds === []) {
            return null;
        }

        $rows = [];
        $prices = Price::query()
            ->whereIn('snapshot_id', $snapshotIds)
            ->orderBy('provider')
            ->orderBy('service_id')
            ->orderBy('region')
            ->orderBy('sku_key')
            ->get();

        foreach ($prices as $row) {
            $attrs = is_array($row->attrs) ? $row->attrs : [];
            $rows[] = [
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

        if ($rows === []) {
            return null;
        }

        return [
            'generatedAt' => $generatedAt,
            'prices' => $rows,
        ];
    }

    /**
     * Evaluate a submitted design cleanly via the Node verification CLI.
     *
     * @param  array<string, mixed>  $design
     * @param  array<string, mixed>|null  $callPlans
     * @param  array<string, mixed>|null  $priceSnapshot
     * @return array<string, mixed>
     */
    public function verify(
        Challenge $challenge,
        array $design,
        ?array $callPlans = null,
        ?array $priceSnapshot = null,
    ): array {
        $repoRoot = dirname(base_path(), 2);
        $cliScript = $repoRoot . '/packages/diagnosis/dist/challenges/verifyCli.js';

        if (!is_file($cliScript)) {
            throw new RuntimeException(
                'Challenge verifier CLI build missing at packages/diagnosis/dist/challenges/verifyCli.js',
            );
        }

        $payload = [
            'challenge' => $challenge->definition,
            'design' => $design,
            'priceSnapshot' => $priceSnapshot,
            ...($callPlans !== null ? ['callPlans' => $callPlans] : []),
        ];

        $encoded = json_encode($payload, JSON_THROW_ON_ERROR);
        $process = new Process(['node', $cliScript], $repoRoot);
        $process->setTimeout(25);
        $process->setInput($encoded);
        $process->run();

        if (!$process->isSuccessful()) {
            $errMsg = trim($process->getErrorOutput()) ?: 'Challenge verification failed.';
            if (
                str_contains($errMsg, 'CallPlan') ||
                str_contains($errMsg, 'not allowed') ||
                str_contains($errMsg, 'exceeds max')
            ) {
                throw new InvalidArgumentException($errMsg);
            }
            throw new RuntimeException($errMsg);
        }

        $decoded = json_decode($process->getOutput(), true);
        if (!is_array($decoded)) {
            throw new RuntimeException('Challenge verifier returned malformed JSON output.');
        }

        return $decoded;
    }
}
