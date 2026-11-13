<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

class RequestIdMiddleware
{
    /**
     * Assign an X-Request-Id to incoming requests and emit a structured JSON log on completion.
     */
    public function handle(Request $request, Closure $next): Response
    {
        $start = microtime(true);
        $requestId = $request->header('X-Request-Id');
        if (! $requestId || ! is_string($requestId) || strlen($requestId) > 100) {
            $requestId = (string) Str::uuid();
        }

        $request->attributes->set('request_id', $requestId);

        $response = $next($request);

        $response->headers->set('X-Request-Id', $requestId);

        $durationMs = round((microtime(true) - $start) * 1000, 2);

        // Structured JSON log without passwords, tokens, or user code payloads
        Log::info('http_request', [
            'request_id' => $requestId,
            'method' => $request->method(),
            'path' => $request->path(),
            'status' => $response->getStatusCode(),
            'duration_ms' => $durationMs,
            'client_ip' => $request->ip(),
        ]);

        return $response;
    }
}
