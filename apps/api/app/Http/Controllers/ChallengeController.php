<?php

namespace App\Http\Controllers;

use App\Models\Challenge;
use App\Models\ChallengeAttempt;
use App\Services\Challenges\ChallengeVerifierService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use InvalidArgumentException;

class ChallengeController extends Controller
{
    public function __construct(
        private readonly ChallengeVerifierService $verifier,
    ) {}

    /**
     * List published challenges with optional authenticated user progress
     * and reference solutions omitted.
     */
    public function index(Request $request): JsonResponse
    {
        $user = Auth::guard('sanctum')->user();

        $challenges = Challenge::query()
            ->where('published', true)
            ->orderBy('id')
            ->get();

        $attemptsByChallenge = [];
        if ($user !== null) {
            $attempts = ChallengeAttempt::query()
                ->where('user_id', $user->id)
                ->orderByDesc('score')
                ->get();

            foreach ($attempts as $attempt) {
                $cid = $attempt->challenge_id;
                if (! isset($attemptsByChallenge[$cid])) {
                    $attemptsByChallenge[$cid] = [
                        'attempts' => 0,
                        'bestScore' => null,
                        'passed' => false,
                    ];
                }
                $attemptsByChallenge[$cid]['attempts']++;
                if (
                    $attemptsByChallenge[$cid]['bestScore'] === null ||
                    (float) $attempt->score > $attemptsByChallenge[$cid]['bestScore']
                ) {
                    $attemptsByChallenge[$cid]['bestScore'] = (float) $attempt->score;
                }
                if ($attempt->passed) {
                    $attemptsByChallenge[$cid]['passed'] = true;
                }
            }
        }

        return response()->json([
            'challenges' => $challenges->map(function (Challenge $row) use ($attemptsByChallenge): array {
                $progress = $attemptsByChallenge[$row->id] ?? null;

                return [
                    'slug' => $row->slug,
                    'title' => $row->title,
                    'difficulty' => $row->difficulty,
                    'definition' => $this->publicDefinition($row, false),
                    'myProgress' => $progress,
                ];
            })->values(),
        ]);
    }

    /**
     * Return a single published challenge; includes referenceSolutionDesign only
     * if the signed-in user already passed it.
     */
    public function show(string $slug): JsonResponse
    {
        $challenge = Challenge::query()
            ->where('slug', $slug)
            ->where('published', true)
            ->first();

        if (! $challenge) {
            return response()->json(['message' => 'Challenge not found.'], 404);
        }

        $user = Auth::guard('sanctum')->user();
        $progress = null;
        $hasPassed = false;

        if ($user !== null) {
            $attempts = ChallengeAttempt::query()
                ->where('user_id', $user->id)
                ->where('challenge_id', $challenge->id)
                ->get();

            if ($attempts->isNotEmpty()) {
                $hasPassed = $attempts->contains(fn (ChallengeAttempt $a): bool => (bool) $a->passed);
                $bestScore = $attempts->max(fn (ChallengeAttempt $a): float => (float) $a->score);
                $progress = [
                    'attempts' => $attempts->count(),
                    'bestScore' => (float) $bestScore,
                    'passed' => $hasPassed,
                ];
            }
        }

        return response()->json([
            'challenge' => [
                'slug' => $challenge->slug,
                'title' => $challenge->title,
                'difficulty' => $challenge->difficulty,
                'definition' => $this->publicDefinition($challenge, $hasPassed),
                'myProgress' => $progress,
            ],
        ]);
    }

    /**
     * Evaluate and persist a user's challenge design attempt server-side via Node CLI.
     */
    public function attempt(Request $request, string $slug): JsonResponse
    {
        $challenge = Challenge::query()
            ->where('slug', $slug)
            ->where('published', true)
            ->first();

        if (! $challenge) {
            return response()->json(['message' => 'Challenge not found.'], 404);
        }

        $validated = $request->validate([
            'design' => ['required', 'array'],
            'design.nodes' => ['required', 'array', 'max:80'],
            'design.edges' => ['present', 'array', 'max:160'],
            'callPlans' => ['nullable', 'array'],
        ]);

        $design = $validated['design'];
        $callPlans = $validated['callPlans'] ?? null;
        $priceSnapshot = $this->verifier->resolvePriceSnapshotForChallenge($challenge);

        try {
            $result = $this->verifier->verify($challenge, $design, $callPlans, $priceSnapshot);
        } catch (InvalidArgumentException $e) {
            return response()->json([
                'message' => $e->getMessage(),
            ], 422);
        }

        $attempt = ChallengeAttempt::create([
            'user_id' => $request->user()->id,
            'challenge_id' => $challenge->id,
            'design_doc' => $design,
            'seed' => (int) ($result['seed'] ?? 1),
            'score' => (float) ($result['score'] ?? 0),
            'passed' => (bool) ($result['passed'] ?? false),
            'result_summary' => $result,
        ]);

        $attemptsCount = ChallengeAttempt::query()
            ->where('user_id', $request->user()->id)
            ->where('challenge_id', $challenge->id)
            ->count();

        $payload = [
            'attempt' => [
                'id' => $attempt->id,
                'score' => (float) $attempt->score,
                'passed' => (bool) $attempt->passed,
                'seed' => (int) $attempt->seed,
                'createdAt' => $attempt->created_at?->toISOString(),
            ],
            'result' => $result,
            'attemptsCount' => $attemptsCount,
        ];

        if ($attempt->passed) {
            $def = is_array($challenge->definition) ? $challenge->definition : [];
            if (isset($def['referenceSolutionDesign'])) {
                $payload['referenceSolutionDesign'] = $def['referenceSolutionDesign'];
            }
            if (isset($def['whatThisTeaches'])) {
                $payload['whatThisTeaches'] = $def['whatThisTeaches'];
            }
        }

        return response()->json($payload, 201);
    }

    /**
     * Reveal the hidden reference solution design and teaching notes after confirmation.
     */
    public function reveal(string $slug): JsonResponse
    {
        $challenge = Challenge::query()
            ->where('slug', $slug)
            ->where('published', true)
            ->first();

        if (! $challenge) {
            return response()->json(['message' => 'Challenge not found.'], 404);
        }

        $def = is_array($challenge->definition) ? $challenge->definition : [];
        if (! isset($def['referenceSolutionDesign'])) {
            return response()->json(['message' => 'Reference solution unavailable.'], 404);
        }

        return response()->json([
            'referenceSolutionDesign' => $def['referenceSolutionDesign'],
            'whatThisTeaches' => $def['whatThisTeaches'] ?? '',
        ]);
    }

    /**
     * Return per-user best verified leaderboard entries sorted by score and monthly cost.
     */
    public function leaderboard(Request $request, string $slug): JsonResponse
    {
        $challenge = Challenge::query()
            ->where('slug', $slug)
            ->where('published', true)
            ->first();

        if (! $challenge) {
            return response()->json(['message' => 'Challenge not found.'], 404);
        }

        $sortBy = $request->query('sort', 'score') === 'cost' ? 'cost' : 'score';

        $attempts = ChallengeAttempt::query()
            ->with('user:id,name')
            ->where('challenge_id', $challenge->id)
            ->where('passed', true)
            ->orderByDesc('score')
            ->orderBy('created_at')
            ->limit(200)
            ->get();

        $bestByUser = [];
        foreach ($attempts as $row) {
            $uid = (int) $row->user_id;
            $summary = is_array($row->result_summary) ? $row->result_summary : [];
            $metrics = is_array($summary['metrics'] ?? null) ? $summary['metrics'] : [];
            $cost = isset($metrics['monthlyCostUsd']) ? (float) $metrics['monthlyCostUsd'] : null;

            $entry = [
                'displayName' => (string) ($row->user?->name ?? 'Learner'),
                'score' => (float) $row->score,
                'monthlyCostUsd' => $cost,
                'p95Ms' => isset($metrics['p95Ms']) ? (float) $metrics['p95Ms'] : null,
                'createdAt' => $row->created_at?->toISOString(),
            ];

            if (! isset($bestByUser[$uid])) {
                $bestByUser[$uid] = $entry;
                continue;
            }

            if ($sortBy === 'cost') {
                $prevCost = $bestByUser[$uid]['monthlyCostUsd'] ?? PHP_FLOAT_MAX;
                $nextCost = $cost ?? PHP_FLOAT_MAX;
                if ($nextCost < $prevCost || ($nextCost === $prevCost && $entry['score'] > $bestByUser[$uid]['score'])) {
                    $bestByUser[$uid] = $entry;
                }
            } elseif ($entry['score'] > $bestByUser[$uid]['score']) {
                $bestByUser[$uid] = $entry;
            }
        }

        $entries = array_values($bestByUser);
        usort($entries, function (array $a, array $b) use ($sortBy): int {
            if ($sortBy === 'cost') {
                $cmp = ($a['monthlyCostUsd'] ?? PHP_FLOAT_MAX) <=> ($b['monthlyCostUsd'] ?? PHP_FLOAT_MAX);
                if ($cmp !== 0) {
                    return $cmp;
                }

                return $b['score'] <=> $a['score'];
            }

            $cmp = $b['score'] <=> $a['score'];
            if ($cmp !== 0) {
                return $cmp;
            }

            return ($a['monthlyCostUsd'] ?? PHP_FLOAT_MAX) <=> ($b['monthlyCostUsd'] ?? PHP_FLOAT_MAX);
        });

        return response()->json([
            'sort' => $sortBy,
            'entries' => array_slice($entries, 0, 25),
        ]);
    }

    /**
     * Strip hidden reference solution unless explicitly authorized to include it.
     *
     * @return array<string, mixed>
     */
    private function publicDefinition(Challenge $challenge, bool $includeReferenceSolution): array
    {
        $def = is_array($challenge->definition) ? $challenge->definition : [];
        if (! $includeReferenceSolution) {
            unset($def['referenceSolutionDesign']);
        }

        return $def;
    }
}
