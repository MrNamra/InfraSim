<?php

namespace App\Http\Controllers;

use App\Models\CustomService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class CustomServiceController extends Controller
{
    private const VALID_KINDS = [
        'compute', 'fn', 'lb', 'gw', 'cdn', 'dns', 'net',
        'object', 'block', 'file', 'sql', 'kv', 'doc', 'cache', 'graph', 'ts', 'olap', 'search',
        'queue', 'topic', 'stream', 'bus', 'workflow', 'auth', 'secret', 'kms', 'email', 'async',
        'llm', 'ml', 'vision', 'speech', 'text-ai', 'doc-ai', 'bot',
    ];

    /**
     * List custom services belonging to the authenticated user.
     */
    public function index(Request $request): JsonResponse
    {
        $rows = CustomService::query()
            ->where('user_id', $request->user()->id)
            ->orderByDesc('updated_at')
            ->get();

        return response()->json([
            'customServices' => $rows->map(fn (CustomService $row) => $this->serialize($row))->values(),
        ]);
    }

    /**
     * Store a newly validated custom service for the authenticated user.
     */
    public function store(Request $request): JsonResponse
    {
        $user = $request->user();
        $validated = $this->validateDefinition($request, null);

        $definition = $validated['definition'];
        $definition['provider'] = 'custom';
        $definition['ownerId'] = (string) $user->id;

        $row = CustomService::create([
            'user_id' => $user->id,
            'service_id' => $definition['id'],
            'definition' => $definition,
        ]);

        return response()->json([
            'customService' => $this->serialize($row),
        ], 201);
    }

    /**
     * Update an existing custom service owned by the authenticated user.
     */
    public function update(Request $request, string $customService): JsonResponse
    {
        $user = $request->user();
        $row = $this->findByIdOrServiceId($customService);
        if (! $row) {
            return response()->json(['message' => 'Custom service not found.'], 404);
        }
        if ((int) $row->user_id !== (int) $user->id) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $validated = $this->validateDefinition($request, $row->id);
        $definition = $validated['definition'];
        $definition['provider'] = 'custom';
        $definition['ownerId'] = (string) $user->id;

        $row->update([
            'service_id' => $definition['id'],
            'definition' => $definition,
        ]);

        return response()->json([
            'customService' => $this->serialize($row->fresh()),
        ]);
    }

    /**
     * Delete a custom service owned by the authenticated user.
     */
    public function destroy(Request $request, string $customService): JsonResponse
    {
        $user = $request->user();
        $row = $this->findByIdOrServiceId($customService);
        if (! $row) {
            return response()->json(['message' => 'Custom service not found.'], 404);
        }
        if ((int) $row->user_id !== (int) $user->id) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $row->delete();

        return response()->json(['deleted' => true]);
    }

    private function findByIdOrServiceId(string $identifier): ?CustomService
    {
        if (Str::isUuid($identifier)) {
            return CustomService::query()
                ->where('id', $identifier)
                ->orWhere('service_id', $identifier)
                ->first();
        }

        return CustomService::query()
            ->where('service_id', $identifier)
            ->first();
    }

    /**
     * @return array{definition: array<string, mixed>}
     */
    private function validateDefinition(Request $request, ?string $ignoreRecordId): array
    {
        $payload = $request->input('definition', $request->all());
        $request->merge(['definition' => $payload]);

        $uniqueRule = Rule::unique('custom_services', 'service_id');
        if ($ignoreRecordId !== null) {
            $uniqueRule->ignore($ignoreRecordId);
        }

        $validated = $request->validate([
            'definition' => ['required', 'array'],
            'definition.id' => [
                'required',
                'string',
                'max:80',
                'regex:/^custom\.[a-z0-9][a-z0-9._-]{1,60}$/',
                $uniqueRule,
            ],
            'definition.name' => ['required', 'string', 'min:1', 'max:100'],
            'definition.category' => ['required', 'string', 'min:1', 'max:60'],
            'definition.kind' => ['required', 'string', Rule::in(self::VALID_KINDS)],
            'definition.description' => ['required', 'string', 'max:1000'],
            'definition.scope' => ['required', 'string', Rule::in(['regional', 'zonal', 'global'])],
            'definition.latency' => ['required', 'array'],
            'definition.latency.distribution' => [
                'required',
                'string',
                Rule::in(['lognormal', 'fixed', 'normal', 'bimodal']),
            ],
            'definition.latency.p50' => ['required', 'numeric', 'gt:0', 'max:600000'],
            'definition.latency.p95' => ['required', 'numeric', 'gte:definition.latency.p50', 'max:600000'],
            'definition.capacity' => ['required', 'array'],
            'definition.capacity.type' => [
                'required',
                'string',
                Rule::in(['elastic', 'slots', 'conc', 'rps', 'units', 'conn', 'tpm', 'passthrough']),
            ],
            'definition.failure' => ['required', 'array'],
            'definition.failure.errorRate' => ['required', 'numeric', 'min:0', 'max:1'],
            'definition.failure.kinds' => ['present', 'array'],
            'definition.operations' => ['required', 'array', 'min:1'],
            'definition.operations.*.name' => ['required', 'string', 'min:1', 'max:80'],
            'definition.operations.*.summary' => ['required', 'string', 'max:300'],
            'definition.operations.*.defaultResponse' => ['required', 'array'],
            'definition.operations.*.defaultResponse.statusCode' => ['required', 'integer', 'min:100', 'max:599'],
            'definition.operations.*.defaultResponse.bodyTemplate' => ['required', 'string'],
            'definition.pricing' => ['required', 'array'],
            'definition.pricing.model' => ['required', 'string', 'max:32'],
            'definition.icon' => ['required', 'string', 'max:40'],
            'definition.color' => ['nullable', 'string', 'max:32'],
            'definition.manualUnitPrice' => ['nullable', 'numeric', 'min:0'],
            'definition.manualUnit' => ['nullable', 'string', 'max:40'],
        ]);

        return ['definition' => $validated['definition']];
    }

    /** @return array<string, mixed> */
    private function serialize(CustomService $row): array
    {
        return [
            'id' => $row->id,
            'serviceId' => $row->service_id,
            'definition' => $row->definition,
            'updatedAt' => $row->updated_at?->toISOString(),
        ];
    }
}
