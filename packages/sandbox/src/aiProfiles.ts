import type { NodeConfig } from '@infrasim/shared-types';

export type AiProfileId = NonNullable<NonNullable<NodeConfig['ai']>['profile']>;

export interface AiModelProfileSpec {
  id: AiProfileId;
  label: string;
  ttftP50Ms: number;
  ttftP95Ms: number;
  tokensPerSec: number;
  prefillMsPerToken: number;
  contextWindow: number;
  typicalUse: string;
}

/**
 * Editable generic LLM / Embedding performance archetypes (Spec 11 §1).
 * Not benchmarks for specific vendor models.
 */
export const AI_MODEL_PROFILES: Record<AiProfileId, AiModelProfileSpec> = {
  'small-fast': {
    id: 'small-fast',
    label: 'small-fast',
    ttftP50Ms: 300,
    ttftP95Ms: 900,
    tokensPerSec: 120,
    prefillMsPerToken: 0.02,
    contextWindow: 128_000,
    typicalUse: 'classification, routing, short replies',
  },
  balanced: {
    id: 'balanced',
    label: 'balanced',
    ttftP50Ms: 500,
    ttftP95Ms: 1_800,
    tokensPerSec: 70,
    prefillMsPerToken: 0.03,
    contextWindow: 200_000,
    typicalUse: 'chat, summarization',
  },
  large: {
    id: 'large',
    label: 'large',
    ttftP50Ms: 800,
    ttftP95Ms: 3_000,
    tokensPerSec: 45,
    prefillMsPerToken: 0.04,
    contextWindow: 200_000,
    typicalUse: 'complex writing, analysis',
  },
  reasoning: {
    id: 'reasoning',
    label: 'reasoning',
    ttftP50Ms: 3_000,
    ttftP95Ms: 15_000,
    tokensPerSec: 40,
    prefillMsPerToken: 0.04,
    contextWindow: 200_000,
    typicalUse: 'hidden thinking before answer',
  },
  embedding: {
    id: 'embedding',
    label: 'embedding',
    ttftP50Ms: 60,
    ttftP95Ms: 200,
    tokensPerSec: 0,
    prefillMsPerToken: 0.005,
    contextWindow: 8_000,
    typicalUse: 'vectors',
  },
};

/**
 * Estimates typical median full-response latency (ms) for an AI profile & token counts.
 */
export function estimateTypicalFullResponseMs(
  profileId: AiProfileId,
  inputTokens = 500,
  outputTokens = 250,
): number {
  const spec = AI_MODEL_PROFILES[profileId] ?? AI_MODEL_PROFILES.balanced;
  const prefillMs = Math.max(0, inputTokens) * spec.prefillMsPerToken;
  const hiddenThinking = profileId === 'reasoning' ? 400 : 0;
  const decodeMs =
    spec.tokensPerSec > 0 ? ((outputTokens + hiddenThinking) / spec.tokensPerSec) * 1000 : 0;
  return Math.round(spec.ttftP50Ms + prefillMs + decodeMs);
}
