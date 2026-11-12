import type { LogEntry } from '@infrasim/shared-types';

export interface FormatPlatformLogsInput {
  serviceId: string;
  nodeId?: string;
  nodeLabel?: string;
  requestId: string;
  traceId?: string;
  durationMs: number;
  billedDurationMs?: number;
  memoryMb?: number;
  memoryPeakBytes?: number;
  coldStart?: boolean;
  initDurationMs?: number;
  statusCode?: number;
  method?: string;
  ok: boolean;
  errorMessage?: string;
  startVirtualMs?: number;
  endVirtualMs?: number;
  replayedFromProfile?: boolean;
}

export interface FormattedPlatformLogBundle {
  startEntries: Omit<LogEntry, 'id'>[];
  endEntries: Omit<LogEntry, 'id'>[];
}

function toMbEstimate(memoryPeakBytes?: number, fallbackMb = 32): number {
  if (!memoryPeakBytes || memoryPeakBytes <= 0) {
    return fallbackMb;
  }
  return Math.max(1, Math.round(memoryPeakBytes / (1024 * 1024)));
}

function sanitizeFunctionName(nodeLabel?: string, fallback = 'handler'): string {
  const cleaned = (nodeLabel ?? fallback).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-|-$/g, '');
  return cleaned || fallback;
}

/**
 * Generates authentic provider-style runtime platform log lines for AWS Lambda,
 * GCP Cloud Run, Azure Functions, and OCI/generic services (spec §9.2).
 */
export function formatProviderPlatformLogs(
  input: FormatPlatformLogsInput,
): FormattedPlatformLogBundle {
  const startVirtualMs = Number((input.startVirtualMs ?? 0).toFixed(2));
  const endVirtualMs = Number((input.endVirtualMs ?? startVirtualMs + input.durationMs).toFixed(2));
  const durationMs = Math.max(0, input.durationMs);
  const billedMs = input.billedDurationMs ?? Math.max(1, Math.ceil(durationMs));
  const memoryMb = Math.max(16, Math.round(input.memoryMb ?? 128));
  const memoryUsedMb = Math.min(memoryMb, toMbEstimate(input.memoryPeakBytes));
  const fnName = sanitizeFunctionName(input.nodeLabel, 'api');
  const commonMeta = {
    source: 'platform' as const,
    requestId: input.requestId,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.replayedFromProfile ? { replayedFromProfile: true } : {}),
  };

  if (input.serviceId.startsWith('aws.')) {
    const startEntries: Omit<LogEntry, 'id'>[] = [
      {
        ...commonMeta,
        tVirtualMs: startVirtualMs,
        level: 'info',
        message: `START RequestId: ${input.requestId} Version: $LATEST`,
      },
    ];
    const endEntries: Omit<LogEntry, 'id'>[] = [];
    if (!input.ok && input.errorMessage) {
      endEntries.push({
        ...commonMeta,
        tVirtualMs: endVirtualMs,
        level: 'error',
        message: `Invoke Error\t${JSON.stringify({
          errorType: 'Error',
          errorMessage: input.errorMessage,
        })}`,
        data: { requestId: input.requestId, errorMessage: input.errorMessage },
      });
    }
    endEntries.push({
      ...commonMeta,
      tVirtualMs: endVirtualMs,
      level: 'info',
      message: `END RequestId: ${input.requestId}`,
    });
    const initSegment =
      input.coldStart && input.initDurationMs !== undefined
        ? ` Init Duration: ${input.initDurationMs.toFixed(1)} ms`
        : '';
    endEntries.push({
      ...commonMeta,
      tVirtualMs: endVirtualMs,
      level: input.ok ? 'info' : 'warn',
      message: `REPORT RequestId: ${input.requestId} Duration: ${durationMs.toFixed(2)} ms Billed Duration: ${billedMs} ms Memory Size: ${memoryMb} MB Max Memory Used: ${memoryUsedMb} MB${initSegment}`,
      data: {
        requestId: input.requestId,
        durationMs: Number(durationMs.toFixed(2)),
        billedDurationMs: billedMs,
        memorySizeMb: memoryMb,
        maxMemoryUsedMb: memoryUsedMb,
        coldStart: Boolean(input.coldStart),
        ...(input.coldStart && input.initDurationMs !== undefined
          ? { initDurationMs: Number(input.initDurationMs.toFixed(1)) }
          : {}),
      },
    });
    return { startEntries, endEntries };
  }

  if (input.serviceId.startsWith('gcp.')) {
    const status = input.statusCode ?? (input.ok ? 200 : 500);
    const method = (input.method ?? 'POST').toUpperCase();
    const severity = input.ok ? 'INFO' : 'ERROR';
    const payload = {
      httpRequest: {
        requestMethod: method,
        status,
        latency: `${(durationMs / 1000).toFixed(3)}s`,
      },
      severity,
      ...(input.coldStart && input.initDurationMs !== undefined
        ? { coldStartInitDuration: `${(input.initDurationMs / 1000).toFixed(3)}s` }
        : {}),
      ...(input.errorMessage ? { error: input.errorMessage } : {}),
    };
    return {
      startEntries: [],
      endEntries: [
        {
          ...commonMeta,
          tVirtualMs: endVirtualMs,
          level: input.ok ? 'info' : 'error',
          message: JSON.stringify(payload),
          data: payload,
        },
      ],
    };
  }

  if (input.serviceId.startsWith('azure.')) {
    const statusWord = input.ok ? 'Succeeded' : 'Failed';
    return {
      startEntries: [
        {
          ...commonMeta,
          tVirtualMs: startVirtualMs,
          level: 'info',
          message: `Executing 'Functions.${fnName}' (Reason='This function was programmatically called via the host APIs.', Id=${input.requestId})`,
        },
      ],
      endEntries: [
        {
          ...commonMeta,
          tVirtualMs: endVirtualMs,
          level: input.ok ? 'info' : 'error',
          message: `Executed 'Functions.${fnName}' (${statusWord}, Id=${input.requestId}, Duration=${Math.max(1, Math.round(durationMs))}ms)${!input.ok && input.errorMessage ? ` - ${input.errorMessage}` : ''}`,
        },
      ],
    };
  }

  // OCI / generic / custom stdout/stderr style with requestId prefix
  const initSuffix =
    input.coldStart && input.initDurationMs !== undefined
      ? ` initMs=${input.initDurationMs.toFixed(1)}`
      : '';
  return {
    startEntries: [
      {
        ...commonMeta,
        tVirtualMs: startVirtualMs,
        level: 'info',
        message: `[${input.requestId}] START fn=${fnName}`,
      },
    ],
    endEntries: [
      {
        ...commonMeta,
        tVirtualMs: endVirtualMs,
        level: input.ok ? 'info' : 'error',
        message: `[${input.requestId}] ${input.ok ? 'DONE' : 'ERROR'} fn=${fnName} status=${input.statusCode ?? (input.ok ? 200 : 500)} duration=${durationMs.toFixed(2)}ms${initSuffix}${!input.ok && input.errorMessage ? ` err=${input.errorMessage}` : ''}`,
      },
    ],
  };
}

/** Wraps captured user logs with provider-specific platform lines and sequential IDs. */
export function attachProviderPlatformLogs(
  userLogs: readonly LogEntry[],
  input: FormatPlatformLogsInput,
): LogEntry[] {
  const { startEntries, endEntries } = formatProviderPlatformLogs(input);
  const combined: Omit<LogEntry, 'id'>[] = [
    ...startEntries,
    ...userLogs.map(({ id: _ignored, ...rest }) => ({
      ...rest,
      requestId: rest.requestId ?? input.requestId,
      ...(rest.nodeId ? {} : input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(rest.traceId ? {} : input.traceId ? { traceId: input.traceId } : {}),
    })),
    ...endEntries,
  ];
  return combined.map((entry, idx) => ({
    ...entry,
    id: idx + 1,
  }));
}
