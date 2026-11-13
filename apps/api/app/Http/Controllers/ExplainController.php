<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

class ExplainController extends Controller
{
    private const SOURCE_OF_TRUTH_LABEL = 'AI-written explanation — rules above are the source of truth';

    /** @var array<int, string> */
    private const FORBIDDEN_KEYS = [
        'scripts',
        'fixtures',
        'mockenv',
        'mock_env',
        'env',
        'source',
        'handler',
        'secret',
        'secrets',
        'password',
        'token',
        'apikey',
        'api_key',
        'event',
        'payload',
        'mockresponse',
    ];

    /** Optionally rephrase rule-engine diagnosis summaries when EXPLAIN_ENABLED=true. */
    public function explain(Request $request): JsonResponse
    {
        if (! config('services.explain.enabled')) {
            return response()->json([
                'enabled' => false,
                'message' => 'AI explainer is disabled on this server (EXPLAIN_ENABLED=false).',
            ], 503);
        }

        $rawInput = $request->all();
        if ($this->containsForbiddenKey($rawInput)) {
            return response()->json([
                'message' => 'Summary payload contains disallowed code, environment variables, secrets, or fixture payloads.',
            ], 422);
        }

        $validated = $request->validate([
            'designName' => ['required', 'string', 'max:160'],
            'focusNodeId' => ['nullable', 'string', 'max:128'],
            'nodes' => ['required', 'array', 'max:200'],
            'nodes.*.id' => ['required', 'string', 'max:128'],
            'nodes.*.serviceId' => ['required', 'string', 'max:128'],
            'nodes.*.kind' => ['required', 'string', 'max:64'],
            'nodes.*.label' => ['required', 'string', 'max:160'],
            'nodes.*.instances' => ['required', 'numeric', 'min:0'],
            'nodes.*.region' => ['nullable', 'string', 'max:64'],
            'kpis' => ['required', 'array'],
            'kpis.p50Ms' => ['required', 'numeric'],
            'kpis.p95Ms' => ['required', 'numeric'],
            'kpis.p99Ms' => ['required', 'numeric'],
            'kpis.errorRate' => ['required', 'numeric', 'min:0', 'max:1'],
            'kpis.throughputRps' => ['required', 'numeric', 'min:0'],
            'kpis.monthlyCostUsd' => ['nullable', 'numeric', 'min:0'],
            'insights' => ['present', 'array', 'max:10'],
            'insights.*.ruleId' => ['required', 'string', 'max:128'],
            'insights.*.title' => ['required', 'string', 'max:240'],
            'insights.*.severity' => ['required', 'in:info,warning,critical'],
            'insights.*.isRootCause' => ['required', 'boolean'],
            'insights.*.nodeIds' => ['required', 'array', 'max:64'],
            'insights.*.evidence' => ['present', 'array'],
            'insights.*.short' => ['required', 'string', 'max:600'],
            'insights.*.suggestedFixes' => ['present', 'array', 'max:5'],
        ]);

        $cacheKey = 'explain:v1:'.hash('sha256', json_encode($validated, JSON_THROW_ON_ERROR));
        $cached = Cache::get($cacheKey);
        if (is_array($cached) && isset($cached['explanation'], $cached['nextSteps'])) {
            return response()->json([
                'enabled' => true,
                'cached' => true,
                'label' => self::SOURCE_OF_TRUTH_LABEL,
                'explanation' => $cached['explanation'],
                'nextSteps' => $cached['nextSteps'],
            ]);
        }

        $generated = $this->generateExplanation($validated);
        Cache::put($cacheKey, $generated, now()->addHours(12));

        return response()->json([
            'enabled' => true,
            'cached' => false,
            'label' => self::SOURCE_OF_TRUTH_LABEL,
            'explanation' => $generated['explanation'],
            'nextSteps' => $generated['nextSteps'],
        ]);
    }

    /** @param array<string, mixed> $summary */
    private function containsForbiddenKey(mixed $value): bool
    {
        if (! is_array($value)) {
            return false;
        }

        foreach ($value as $key => $child) {
            if (is_string($key) && in_array(strtolower($key), self::FORBIDDEN_KEYS, true)) {
                return true;
            }
            if ($this->containsForbiddenKey($child)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Produces friendlier rephrasing strictly from the summarized metrics and rules.
     *
     * @param  array<string, mixed>  $summary
     * @return array{explanation: string, nextSteps: array<int, string>}
     */
    private function generateExplanation(array $summary): array
    {
        $providerUrl = config('services.explain.url');
        $providerKey = config('services.explain.key');

        if (is_string($providerUrl) && $providerUrl !== '' && is_string($providerKey) && $providerKey !== '') {
            try {
                $response = Http::withToken($providerKey)
                    ->timeout(10)
                    ->post($providerUrl, [
                        'model' => config('services.explain.model', 'gpt-4o-mini'),
                        'messages' => [
                            [
                                'role' => 'system',
                                'content' => 'Rephrase the provided architecture simulation insights in plain language. Never change any numbers or invent fixes.',
                            ],
                            [
                                'role' => 'user',
                                'content' => json_encode($summary, JSON_THROW_ON_ERROR),
                            ],
                        ],
                    ]);

                if ($response->successful()) {
                    $content = data_get($response->json(), 'choices.0.message.content');
                    if (is_string($content) && trim($content) !== '') {
                        return [
                            'explanation' => trim($content),
                            'nextSteps' => $this->buildDeterministicNextSteps($summary),
                        ];
                    }
                }
            } catch (\Throwable) {
                // Fall back to deterministic plain-language synthesis below without inventing metrics
            }
        }

        return [
            'explanation' => $this->buildDeterministicRephrasing($summary),
            'nextSteps' => $this->buildDeterministicNextSteps($summary),
        ];
    }

    /** @param array<string, mixed> $summary */
    private function buildDeterministicRephrasing(array $summary): string
    {
        $kpis = $summary['kpis'];
        $insights = $summary['insights'];
        $errorPct = round(((float) $kpis['errorRate']) * 100, 1);
        $p95 = round((float) $kpis['p95Ms']);
        $rps = round((float) $kpis['throughputRps'], 1);

        if (count($insights) === 0) {
            return sprintf(
                'Across %s (%d services), requests averaged %.1f req/s with %dms p95 latency and %.1f%% errors. No rule violations were triggered.',
                $summary['designName'],
                count($summary['nodes']),
                $rps,
                $p95,
                $errorPct,
            );
        }

        $primary = $insights[0];
        $rootCount = count(array_filter($insights, static fn (array $i): bool => (bool) ($i['isRootCause'] ?? false)));

        return sprintf(
            '%s observed %dms p95 latency and a %.1f%% error rate at %.1f req/s. The highest-impact finding is "%s" (%s): %s%s',
            $summary['designName'],
            $p95,
            $errorPct,
            $rps,
            $primary['title'],
            $primary['severity'],
            $primary['short'],
            $rootCount > 0 ? ' Resolving the root-cause dependency first should clear downstream symptoms.' : '',
        );
    }

    /**
     * @param  array<string, mixed>  $summary
     * @return array<int, string>
     */
    private function buildDeterministicNextSteps(array $summary): array
    {
        $steps = [];
        foreach ($summary['insights'] as $insight) {
            foreach ($insight['suggestedFixes'] ?? [] as $fix) {
                if (! is_array($fix) || empty($fix['label'])) {
                    continue;
                }
                $tradeOff = ! empty($fix['tradeOff']) ? ' ('.$fix['tradeOff'].')' : '';
                $steps[] = sprintf('%s: %s%s', $insight['title'], $fix['label'], $tradeOff);
                if (count($steps) >= 4) {
                    return $steps;
                }
            }
        }

        if (count($steps) === 0) {
            $steps[] = 'Inspect node utilization and p95 latency in Metrics before scaling capacity.';
        }

        return $steps;
    }
}
