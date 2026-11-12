<?php

namespace App\Http\Controllers;

use App\Models\Design;
use App\Models\DesignVersion;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class DesignController extends Controller
{
    /**
     * List saved cloud designs owned by the authenticated user.
     */
    public function index(Request $request): JsonResponse
    {
        $rows = Design::query()
            ->where('user_id', $request->user()->id)
            ->orderByDesc('updated_at')
            ->get();

        return response()->json([
            'designs' => $rows->map(fn (Design $d): array => $this->serializeSummary($d))->values(),
        ]);
    }

    /**
     * Create a new cloud design document and record version 1.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'id' => ['nullable', 'uuid'],
            'name' => ['required', 'string', 'min:1', 'max:160'],
            'schemaVersion' => ['nullable', 'integer', 'min:1', 'max:10'],
            'doc' => ['required', 'array'],
            'doc.nodes' => ['present', 'array', 'max:200'],
            'doc.edges' => ['present', 'array', 'max:400'],
        ]);

        $requestedId = $validated['id'] ?? null;
        if (is_string($requestedId) && Design::withTrashed()->where('id', $requestedId)->exists()) {
            $requestedId = null;
        }
        $id = $requestedId ?? (string) Str::uuid();

        /** @var Design $design */
        $design = DB::transaction(function () use ($request, $validated, $id): Design {
            $row = Design::create([
                'id' => $id,
                'user_id' => $request->user()->id,
                'name' => $validated['name'],
                'doc' => $validated['doc'],
                'schema_version' => (int) ($validated['schemaVersion'] ?? ($validated['doc']['schemaVersion'] ?? 1)),
                'version' => 1,
                'visibility' => Design::VISIBILITY_PRIVATE,
            ]);

            DesignVersion::create([
                'design_id' => $row->id,
                'version' => 1,
                'doc' => $validated['doc'],
            ]);

            return $row;
        });

        return response()->json([
            'design' => $this->serializeDetail($design),
        ], 201);
    }

    /**
     * Return full details of an owned cloud design document.
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $design = $this->findOwnedOrFailResponse($request, $id, $errorResponse);
        if ($errorResponse !== null) {
            return $errorResponse;
        }

        return response()->json([
            'design' => $this->serializeDetail($design),
        ]);
    }

    /**
     * Update an owned cloud design with optimistic version locking (409 on mismatch).
     */
    public function update(Request $request, string $id): JsonResponse
    {
        $design = $this->findOwnedOrFailResponse($request, $id, $errorResponse);
        if ($errorResponse !== null) {
            return $errorResponse;
        }

        $validated = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:160'],
            'base_version' => ['required', 'integer', 'min:1'],
            'doc' => ['required', 'array'],
            'doc.nodes' => ['present', 'array', 'max:200'],
            'doc.edges' => ['present', 'array', 'max:400'],
        ]);

        if ((int) $validated['base_version'] !== (int) $design->version) {
            return response()->json([
                'message' => 'Design version conflict: newer changes exist on the server.',
                'currentVersion' => (int) $design->version,
                'latestDoc' => $design->doc,
            ], 409);
        }

        $updated = DB::transaction(function () use ($design, $validated): Design {
            $nextVersion = (int) $design->version + 1;
            $design->update([
                'name' => $validated['name'],
                'doc' => $validated['doc'],
                'version' => $nextVersion,
            ]);

            DesignVersion::create([
                'design_id' => $design->id,
                'version' => $nextVersion,
                'doc' => $validated['doc'],
            ]);

            return $design->fresh();
        });

        return response()->json([
            'design' => $this->serializeDetail($updated),
        ]);
    }

    /**
     * Soft-delete an owned cloud design.
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        $design = $this->findOwnedOrFailResponse($request, $id, $errorResponse);
        if ($errorResponse !== null) {
            return $errorResponse;
        }

        $design->delete();

        return response()->json(['deleted' => true]);
    }

    /**
     * List immutable historical versions for an owned cloud design.
     */
    public function versions(Request $request, string $id): JsonResponse
    {
        $design = $this->findOwnedOrFailResponse($request, $id, $errorResponse);
        if ($errorResponse !== null) {
            return $errorResponse;
        }

        $rows = DesignVersion::query()
            ->where('design_id', $design->id)
            ->orderByDesc('version')
            ->limit(50)
            ->get();

        return response()->json([
            'versions' => $rows->map(fn (DesignVersion $v): array => [
                'id' => $v->id,
                'version' => (int) $v->version,
                'doc' => $v->doc,
                'createdAt' => $v->created_at?->toISOString(),
            ])->values(),
        ]);
    }

    /**
     * Issue or revoke an unlisted read-only share token for an owned cloud design.
     */
    public function share(Request $request, string $id): JsonResponse
    {
        $design = $this->findOwnedOrFailResponse($request, $id, $errorResponse);
        if ($errorResponse !== null) {
            return $errorResponse;
        }

        $revoke = (bool) $request->boolean('revoke', false);
        if ($revoke) {
            $design->update([
                'visibility' => Design::VISIBILITY_PRIVATE,
                'share_token' => null,
            ]);

            return response()->json([
                'visibility' => Design::VISIBILITY_PRIVATE,
                'shareToken' => null,
            ]);
        }

        $token = $design->share_token ?: Str::random(32);
        $design->update([
            'visibility' => Design::VISIBILITY_UNLISTED,
            'share_token' => $token,
        ]);

        return response()->json([
            'visibility' => Design::VISIBILITY_UNLISTED,
            'shareToken' => $token,
        ]);
    }

    /**
     * Public unauthenticated endpoint serving an unlisted design snapshot with env secrets stripped.
     */
    public function showShared(string $token): JsonResponse
    {
        if (strlen($token) < 16 || strlen($token) > 128) {
            return response()->json(['message' => 'Shared design not found.'], 404);
        }

        $design = Design::query()
            ->where('share_token', $token)
            ->where('visibility', '!=', Design::VISIBILITY_PRIVATE)
            ->first();

        if (! $design) {
            return response()->json(['message' => 'Shared design not found.'], 404);
        }

        $sanitizedDoc = $this->sanitizeSharedDoc(is_array($design->doc) ? $design->doc : []);

        return response()->json([
            'design' => [
                'id' => $design->id,
                'name' => $design->name,
                'version' => (int) $design->version,
                'schemaVersion' => (int) $design->schema_version,
                'doc' => $sanitizedDoc,
                'updatedAt' => $design->updated_at?->toISOString(),
            ],
        ]);
    }

    private function findOwnedOrFailResponse(
        Request $request,
        string $id,
        ?JsonResponse &$errorResponse,
    ): ?Design {
        $errorResponse = null;

        if (! Str::isUuid($id)) {
            $errorResponse = response()->json(['message' => 'Design not found.'], 404);

            return null;
        }

        $design = Design::query()->find($id);
        if (! $design) {
            $errorResponse = response()->json(['message' => 'Design not found.'], 404);

            return null;
        }

        if ((int) $design->user_id !== (int) $request->user()->id) {
            $errorResponse = response()->json(['message' => 'Forbidden.'], 403);

            return null;
        }

        return $design;
    }

    /**
     * Strip mockEnv and script env secrets before exposing an unlisted read-only share.
     *
     * @param  array<string, mixed>  $doc
     * @return array<string, mixed>
     */
    private function sanitizeSharedDoc(array $doc): array
    {
        if (isset($doc['nodes']) && is_array($doc['nodes'])) {
            foreach ($doc['nodes'] as $idx => $node) {
                if (is_array($node) && isset($node['config']) && is_array($node['config'])) {
                    unset($doc['nodes'][$idx]['config']['mockEnv']);
                }
            }
        }

        if (isset($doc['scripts']) && is_array($doc['scripts'])) {
            foreach ($doc['scripts'] as $idx => $script) {
                if (is_array($script)) {
                    $doc['scripts'][$idx]['env'] = new \stdClass();
                }
            }
        }

        return $doc;
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeSummary(Design $design): array
    {
        $doc = is_array($design->doc) ? $design->doc : [];
        $nodes = is_array($doc['nodes'] ?? null) ? count($doc['nodes']) : 0;
        $edges = is_array($doc['edges'] ?? null) ? count($doc['edges']) : 0;

        return [
            'id' => $design->id,
            'name' => $design->name,
            'schemaVersion' => (int) $design->schema_version,
            'version' => (int) $design->version,
            'visibility' => $design->visibility,
            'shareToken' => $design->share_token,
            'nodeCount' => $nodes,
            'edgeCount' => $edges,
            'updatedAt' => $design->updated_at?->toISOString(),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeDetail(Design $design): array
    {
        return [
            ...$this->serializeSummary($design),
            'doc' => $design->doc,
        ];
    }
}
