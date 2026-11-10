# 11 — AI Services Mock Behavior

Applies to all catalog rows with mock kind `llm`, `ml`, `vision`, `speech`, `text-ai`, `doc-ai`, `bot`, `async`, and RAG-style `search` (files 07–10).

## 0. Principles

1. **Nothing real is called.** No model, no API key, no network. Responses are generated from templates by a seeded generator.
2. **Archetypes, not benchmarks.** We model *how AI services behave* (time to first token, decode speed, quotas, long tails), using generic profiles. We do **not** claim performance numbers for specific vendor models. Users can label a node with any model name they like; the label has no effect on numbers.
3. **Shape fidelity, not semantic fidelity.** Responses must have the right JSON shape so user code that reads `choices[0].message.content` (or equivalent) does not crash.
4. **Teach the real pain points**: throttling (TPM/RPM), long generations vs gateway timeouts, streaming vs non-streaming, retries, cost per token.

## 1. LLM latency model

```
prefillMs   = inputTokens × prefillMsPerToken
ttftMs      = sample(ttft lognormal) + prefillMs
decodeMs    = outputTokens / tokensPerSec × 1000
totalMs     = ttftMs + decodeMs
```

### Model profiles (editable archetypes)

| Profile | TTFT p50 / p95 (ms) | Tokens/sec (decode) | prefillMsPerToken | Context window (tokens) | Typical use |
|---|---|---|---|---|---|
| `small-fast` | 300 / 900 | 120 | 0.02 | 128,000 | classification, routing, short replies |
| `balanced` | 500 / 1,800 | 70 | 0.03 | 200,000 | chat, summarization |
| `large` | 800 / 3,000 | 45 | 0.04 | 200,000 | complex writing, analysis |
| `reasoning` | 3,000 / 15,000 | 40 | 0.04 | 200,000 | hidden "thinking" before answer |
| `embedding` | 60 / 200 | n/a | 0.005 | 8,000 | vectors |

The catalog rows' p50/p95 "full response" columns (3000/12000) correspond roughly to `balanced` with ~150–400 output tokens; when a profile is selected, the profile model overrides the row's p50/p95. Show both: "typical full response: ~X s" computed from the profile and token counts.

### Token counting

- `inputTokens`: from the call input, estimated `ceil(chars / 4)` unless the call supplies `usage.inputTokens` (mock SDK option).
- `outputTokens`: from the response template (`{{tokens(n)}}` or actual template length ÷ 4), or `outputTokens: {p50, p95}` sampled lognormal, capped by `maxOutputTokens` from the request.
- `reasoning` profile: add hidden `thinkingTokens` (sampled) that count toward latency and cost but are not returned.

## 2. Quotas and throttling

Per **deployment/model/region** (editable):

```ts
interface AiQuota {
  rpm?: number;                 // requests per minute
  tpm?: number;                 // tokens per minute (input + output)
  concurrency?: number;         // max concurrent generations
  countMaxTokensUpfront?: boolean; // reserve max_tokens at request time (some providers do)
  maxContextTokens: number;
  maxOutputTokens: number;
}
```

- Implement as **token buckets** (refill continuously; burst = 1 minute of quota by default).
- Exceeded → fail instantly with provider-shaped 429 and `retryAfterMs` (time until enough tokens refill).
- `inputTokens + maxOutputTokens > maxContextTokens` → 400 validation error (`context_length_exceeded` style) — a lesson on prompt size.
- Optional `contentFilterRate` (default 0): returns a "blocked by content filter" finish reason/error.
- **Capacity modes** (select per node):
  - `on-demand`: shared capacity. Quota applies; add **jitter**: with probability `slowdownProb` (default 2%) multiply latency by 2–4× (noisy neighbor).
  - `provisioned`: fixed capacity `units × tokensPerSecPerUnit`. Concurrent generations share throughput; when demand exceeds capacity, requests **queue** (latency grows) then reject. Hourly cost, not per token.
- Provider error names (approximate — verify against SDK docs when implementing):

| Provider | Throttle error | Context too long |
|---|---|---|
| AWS Bedrock | HTTP 429 `ThrottlingException` | `ValidationException` |
| Azure OpenAI | HTTP 429 (with `Retry-After`) | HTTP 400 `context_length_exceeded` |
| GCP Vertex AI | HTTP 429 / `RESOURCE_EXHAUSTED` | HTTP 400 `INVALID_ARGUMENT` |
| OCI Generative AI | HTTP 429 `TooManyRequests` | HTTP 400 |

## 3. Streaming

- `InvokeStream` operations return chunks. Timeline: first chunk at `ttftMs`, then a chunk every `chunkTokens / tokensPerSec` seconds (default `chunkTokens = 4`).
- Engine represents a streaming call as **two spans**: `ttft` and `decode`. Callers that stream release their gateway slot only when the stream ends (important for LB/gateway idle timeouts).
- Teach: streaming improves *perceived* latency (TTFT), not total time; a non-streaming call behind an API gateway with a ~30 s timeout fails for long generations.
- Chunk wire format per provider is approximate: server-sent events `data: {json}` with a final `[DONE]`-style marker where applicable. Exact fidelity not required; the mock SDK exposes an async iterator (`for await (const chunk of stream)`).

## 4. Mock output generators

Selected per operation (`responseMode`):

| Mode | Behavior |
|---|---|
| `fixed` | Always the same text |
| `template` | Template with `{{input...}}`, `{{faker...}}`, `{{tokens(n)}}` |
| `echo` | Returns the user's last message (useful for debugging prompts) |
| `json-fill` | Given a JSON Schema (structured output), fills a valid object with seeded values — so `JSON.parse(...)` and field access never crash |
| `tool-call` | Returns a tool/function call with arguments generated from the tool's JSON Schema |
| `sequence` | Cycles through a user-provided list of responses (simulate multi-turn) |

`tokens(n)` filler is neutral placeholder text (e.g. lorem-style), clearly fake.

## 5. Provider-shaped responses

Default `shape: "provider"`. Also offer `shape: "normalized"` `{ text, usage:{inputTokens,outputTokens}, finishReason }`. Shapes below are **approximate**; the agent MUST check the current SDK docs and adjust field names.

**AWS Bedrock (Converse-style)**
```json
{ "output": { "message": { "role": "assistant", "content": [ { "text": "{{text}}" } ] } },
  "stopReason": "end_turn",
  "usage": { "inputTokens": {{in}}, "outputTokens": {{out}}, "totalTokens": {{total}} },
  "metrics": { "latencyMs": {{ms}} } }
```

**Azure OpenAI (chat completions-style)**
```json
{ "id": "chatcmpl-{{faker.hex(12)}}", "object": "chat.completion", "created": {{now.s}}, "model": "{{deploymentName}}",
  "choices": [ { "index": 0, "message": { "role": "assistant", "content": "{{text}}" }, "finish_reason": "stop" } ],
  "usage": { "prompt_tokens": {{in}}, "completion_tokens": {{out}}, "total_tokens": {{total}} } }
```

**GCP Vertex AI (generateContent-style)**
```json
{ "candidates": [ { "content": { "role": "model", "parts": [ { "text": "{{text}}" } ] }, "finishReason": "STOP" } ],
  "usageMetadata": { "promptTokenCount": {{in}}, "candidatesTokenCount": {{out}}, "totalTokenCount": {{total}} } }
```

**OCI Generative AI (chat-style)**
```json
{ "modelId": "{{modelLabel}}",
  "chatResponse": { "choices": [ { "message": { "role": "ASSISTANT", "content": [ { "type": "TEXT", "text": "{{text}}" } ] }, "finishReason": "stop" } ],
                    "usage": { "promptTokens": {{in}}, "completionTokens": {{out}}, "totalTokens": {{total}} } } }
```

**Embeddings**: `Embed` returns a seeded vector of `dimensions` (default 1024) floats in [-1, 1], one per input; batch size limit (default 96 inputs); latency = base + 0.5 ms × inputs.

## 6. Inference endpoints (`ml`)

SageMaker / Vertex endpoint / Azure ML / OCI Data Science model deployment:
- `instances × concurrencyPerInstance` slots; latency = profile p50/p95 + `payloadBytes / 10 MB/s`.
- `autoscaling` with `scaleOutLagS` (default 60–180 s for GPU instances — illustrative).
- Optional **scale-to-zero** (serverless inference): first request after idle pays `coldMs` (default p50 30,000 / p95 90,000 — illustrative) → timeouts upstream (lesson).
- Cost: per instance-hour (file 14).

## 7. Vision, document, speech, text AI

| Kind | Latency model | Notes |
|---|---|---|
| `vision` | `base + perMB × imageSizeMB` (default base per catalog, perMB 40 ms) | Mock labels/boxes from template; `{{repeat(n, ...)}}` for n detections |
| `doc-ai` | `base + perPage × pages` (default 400 ms/page) | Mock key/value pairs & text blocks |
| `text-ai` | `base + 0.02 ms × chars` | Sentiment/entities/translation templates |
| `speech` (sync) | `max(base, 0.3 × audioSeconds × 1000)` | Short audio only; mock transcript via `tokens(n)` |
| `speech` (batch) / `async` | **Async job protocol** | `Start` returns `jobId` immediately; `GetStatus` returns `IN_PROGRESS` until virtual time `jobDurationMs` elapses, then `COMPLETED` with result or `FAILED` at `failRate` |
| `bot` | `base` | Returns intent + templated reply |

## 8. RAG building blocks

`search` rows used as vector/semantic search return `topK` passages from a user-editable list (id, text, score descending). Provide a starter template **"RAG chatbot"**: Client → API (compute) → `Embed` → vector search → LLM → response, with cache and queue variants. Latency adds up (embed ≈ 100–300 ms, search ≈ 50–300 ms, LLM seconds): teaches why LLM dominates and where to stream/cache.

## 9. Cost counters

Per node: `tokensIn`, `tokensOut` (+ hidden thinking tokens billed as output), requests, instance-hours for provisioned/endpoints. Unit prices come from the price sync when a SKU is found (file 14); otherwise the user enters **manual price per 1M input/output tokens** and the UI shows a "manual price" chip. Never ship guessed prices.

## 10. Insights this enables (file 17)

- TPM/RPM throttling under load; suggest queue + backoff, batching, lower `max_tokens`, or provisioned capacity.
- Long generations behind gateways with short timeouts → recommend streaming or async job pattern.
- Retry storm on 429 without backoff/jitter.
- LLM call on the critical path of a page that could be cached or precomputed.
- Oversized prompts (context error / cost spike).
- Model fallback chain suggestion (try cheaper model on 429).

## 11. Acceptance tests

1. 1,000 calls at `balanced` with 300 output tokens: median total ≈ `ttft + 300/70 s` (±10%).
2. TPM bucket: 60k TPM with 1k-token calls → sustained ≈ 60 calls/min; the 61st in a minute returns 429 with `retryAfterMs > 0`.
3. Context overflow returns 400 with provider-shaped error and never calls downstream.
4. `json-fill` output always validates against the supplied schema.
5. Async speech job: `GetStatus` before completion is `IN_PROGRESS`, after is `COMPLETED`; deterministic for same seed.
6. Streaming call: first chunk at TTFT; last chunk at TTFT + decode; spans recorded as two.
