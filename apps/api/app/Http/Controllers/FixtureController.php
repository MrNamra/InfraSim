<?php

namespace App\Http\Controllers;

use App\Models\Fixture;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class FixtureController extends Controller
{
    /**
     * List saved test payload fixtures owned by the authenticated user.
     */
    public function index(Request $request): JsonResponse
    {
        $rows = Fixture::query()
            ->where('user_id', $request->user()->id)
            ->orderByDesc('updated_at')
            ->get();

        return response()->json([
            'fixtures' => $rows->map(fn (Fixture $row) => $this->serialize($row))->values(),
        ]);
    }

    /**
     * Create and persist a new fixture in the authenticated user's library.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $this->validateFixturePayload($request);

        $row = Fixture::create([
            'user_id' => $request->user()->id,
            'name' => $validated['name'],
            'template' => $validated['template'] ?? null,
            'event' => $validated['event'],
            'schema' => $validated['schema'] ?? null,
        ]);

        return response()->json([
            'fixture' => $this->serialize($row),
        ], 201);
    }

    /**
     * Update a saved fixture belonging to the authenticated user.
     */
    public function update(Request $request, string $fixture): JsonResponse
    {
        if (! Str::isUuid($fixture)) {
            return response()->json(['message' => 'Fixture not found.'], 404);
        }

        $row = Fixture::query()->find($fixture);
        if (! $row) {
            return response()->json(['message' => 'Fixture not found.'], 404);
        }
        if ((int) $row->user_id !== (int) $request->user()->id) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $validated = $this->validateFixturePayload($request);

        $row->update([
            'name' => $validated['name'],
            'template' => $validated['template'] ?? null,
            'event' => $validated['event'],
            'schema' => $validated['schema'] ?? null,
        ]);

        return response()->json([
            'fixture' => $this->serialize($row->fresh()),
        ]);
    }

    /**
     * Delete a saved fixture owned by the authenticated user.
     */
    public function destroy(Request $request, string $fixture): JsonResponse
    {
        if (! Str::isUuid($fixture)) {
            return response()->json(['message' => 'Fixture not found.'], 404);
        }

        $row = Fixture::query()->find($fixture);
        if (! $row) {
            return response()->json(['message' => 'Fixture not found.'], 404);
        }
        if ((int) $row->user_id !== (int) $request->user()->id) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $row->delete();

        return response()->json(['deleted' => true]);
    }

    /**
     * @return array{name: string, template?: string|null, event: mixed, schema?: array<string, mixed>|null}
     */
    private function validateFixturePayload(Request $request): array
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'template' => ['nullable', 'string', 'max:80'],
            'event' => ['present'],
            'schema' => ['nullable', 'array'],
        ]);

        return [
            'name' => $validated['name'],
            'template' => $validated['template'] ?? null,
            'event' => $request->input('event'),
            'schema' => $validated['schema'] ?? null,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function serialize(Fixture $row): array
    {
        $payload = [
            'id' => $row->id,
            'name' => $row->name,
            'event' => $row->event,
            'updatedAt' => $row->updated_at?->toISOString(),
        ];

        if ($row->template !== null) {
            $payload['template'] = $row->template;
        }
        if ($row->schema !== null) {
            $payload['schema'] = $row->schema;
        }

        return $payload;
    }
}
