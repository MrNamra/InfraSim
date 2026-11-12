import type { NodeInstance, ScriptAsset } from '@infrasim/shared-types';
import { PAYLOAD_DOCTOR_RULES } from './generated/payloadDoctorRules.js';
import type { DryRunResult, PayloadDoctorHint, PayloadDoctorRule } from './types.js';

export interface AnalyzeDiagnosticsInput {
  result: DryRunResult;
  script: ScriptAsset;
  event: unknown;
  templateId?: string;
  node?: NodeInstance;
  env?: Record<string, string>;
  rules?: readonly PayloadDoctorRule[];
}

function matchesEventCheck(check: string | undefined, event: unknown): boolean {
  if (!check) return true;
  if (!event || typeof event !== 'object') return false;
  const obj = event as Record<string, unknown>;

  switch (check) {
    case 'body-is-string':
      return typeof obj.body === 'string';
    case 'query-params-null':
      return 'queryStringParameters' in obj && obj.queryStringParameters === null;
    case 'apigw-v2-payload': {
      const rc = obj.requestContext as Record<string, unknown> | undefined;
      return Boolean(rc && typeof rc === 'object' && 'http' in rc && !('httpMethod' in obj));
    }
    case 'sqs-records-body-string':
      return (
        Array.isArray(obj.Records) &&
        obj.Records.length > 0 &&
        Boolean(obj.Records[0] && typeof obj.Records[0] === 'object') &&
        'eventSource' in (obj.Records[0] as Record<string, unknown>) &&
        typeof (obj.Records[0] as Record<string, unknown>).body === 'string'
      );
    case 's3-notification-payload':
      return (
        Array.isArray(obj.Records) &&
        obj.Records.length > 0 &&
        Boolean(obj.Records[0] && typeof obj.Records[0] === 'object') &&
        's3' in (obj.Records[0] as Record<string, unknown>)
      );
    case 'is-base64-encoded':
      return obj.isBase64Encoded === true && typeof obj.body === 'string';
    case 'lowercase-headers': {
      const hdrs = obj.headers as Record<string, unknown> | undefined;
      if (!hdrs || typeof hdrs !== 'object') return false;
      const keys = Object.keys(hdrs);
      return keys.length > 0 && keys.every((k) => k === k.toLowerCase());
    }
    default:
      return true;
  }
}

function findMissingEnvKeys(
  source: string,
  effectiveEnv: Record<string, string>,
  result: DryRunResult,
): string[] {
  const keys = new Set<string>();
  const re = /\bprocess\.env\.([A-Z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const key = m[1]!;
    if (effectiveEnv[key] === undefined || effectiveEnv[key] === '') {
      keys.add(key);
    }
  }
  if (keys.size === 0) return [];

  const errText = `${result.error?.message ?? ''} ${result.calls.map((c) => c.httpUrl ?? JSON.stringify(c.input ?? '')).join(' ')}`;
  if (!result.error && !errText.includes('undefined')) {
    return [];
  }
  return Array.from(keys);
}

function detectMissingMockCall(result: DryRunResult): { serviceId: string; op: string } | null {
  const errMsg = result.error?.message ?? '';
  if (!/cannot read properties of undefined|is not iterable|cannot destructure/i.test(errMsg)) {
    return null;
  }
  // Prefer most recent successful cloud/HTTP call prior to the error
  for (let i = result.calls.length - 1; i >= 0; i--) {
    const call = result.calls[i]!;
    if (!call.error) {
      return { serviceId: call.serviceId, op: call.op };
    }
  }
  return null;
}

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

/**
 * Evaluates data-driven Payload Doctor JSON rules against a sandbox dry-run result, source code,
 * and trigger event to surface concrete actionable fixes.
 */
export function analyzeDryRunDiagnostics(input: AnalyzeDiagnosticsInput): PayloadDoctorHint[] {
  const rules = input.rules ?? PAYLOAD_DOCTOR_RULES;
  const { result, script, event, templateId, node } = input;
  const effectiveEnv: Record<string, string> = {
    ...(node?.config.mockEnv ?? {}),
    ...(script.env ?? {}),
    ...(input.env ?? {}),
  };

  const hints: PayloadDoctorHint[] = [];
  const seenRuleIds = new Set<string>();

  for (const rule of rules) {
    if (seenRuleIds.has(rule.id)) continue;

    if (rule.matchCategories && rule.matchCategories.length > 0) {
      if (!result.error || !rule.matchCategories.includes(result.error.category)) {
        continue;
      }
    }

    if (rule.requiresTemplate && rule.requiresTemplate.length > 0) {
      if (!templateId || !rule.requiresTemplate.includes(templateId)) {
        continue;
      }
    }

    if (!matchesEventCheck(rule.eventCheck, event)) {
      continue;
    }

    if (rule.errorPattern) {
      if (!result.error) continue;
      if (!new RegExp(rule.errorPattern, 'i').test(result.error.message)) continue;
    }

    if (rule.stackPattern) {
      const stack = result.error?.stack ?? '';
      if (!new RegExp(rule.stackPattern, 'i').test(stack)) continue;
    }

    if (rule.sourcePattern) {
      if (!new RegExp(rule.sourcePattern).test(script.source)) continue;
    }

    if (rule.excludeSourcePattern) {
      if (new RegExp(rule.excludeSourcePattern).test(script.source)) continue;
    }

    const vars: Record<string, string> = {
      errorMessage: result.error?.message ?? '',
      timeoutSec: (Math.max(10, script.timeoutMs) / 1000).toFixed(2),
      slowServiceNote: '',
      service: 'mock service',
      envKey: '',
    };

    if (rule.checkMissingMockField) {
      const targetCall = detectMissingMockCall(result);
      if (!targetCall) continue;
      vars.service = `${targetCall.serviceId}.${targetCall.op}`;

      let patchedSource: string | undefined;
      if (rule.patchTemplate) {
        const { find, findIsRegex, replace } = rule.patchTemplate;
        patchedSource = findIsRegex
          ? script.source.replace(new RegExp(find, 'g'), replace)
          : script.source.split(find).join(replace);
      }
      seenRuleIds.add(rule.id);
      hints.push({
        ruleId: rule.id,
        title: rule.title,
        message: interpolateTemplate(rule.message, vars),
        severity: rule.severity,
        ...(rule.actionLabel ? { actionLabel: rule.actionLabel } : {}),
        ...(rule.actionKind ? { actionKind: rule.actionKind } : {}),
        ...(patchedSource && patchedSource !== script.source ? { patchedSource } : {}),
        targetServiceId: targetCall.serviceId,
        targetOp: targetCall.op,
      });
      continue;
    }

    if (rule.checkMissingEnv) {
      const missingKeys = findMissingEnvKeys(script.source, effectiveEnv, result);
      if (missingKeys.length === 0) continue;
      vars.envKey = missingKeys[0]!;
    }

    if (result.error?.category === 'Timeout' && result.calls.length > 0) {
      const slowest = [...result.calls].sort((a, b) => b.latencyMs - a.latencyMs)[0]!;
      vars.slowServiceNote = ` while waiting on ${slowest.serviceId}.${slowest.op} (${slowest.latencyMs.toFixed(0)} ms)`;
    }

    let patchedSource: string | undefined;
    if (rule.patchTemplate) {
      const { find, findIsRegex, replace } = rule.patchTemplate;
      const replaced = findIsRegex
        ? script.source.replace(new RegExp(find, 'g'), replace)
        : script.source.split(find).join(replace);
      if (replaced !== script.source) {
        patchedSource = replaced;
      }
    }

    seenRuleIds.add(rule.id);
    hints.push({
      ruleId: rule.id,
      title: rule.title,
      message: interpolateTemplate(rule.message, vars),
      severity: rule.severity,
      ...(rule.actionLabel ? { actionLabel: rule.actionLabel } : {}),
      ...(rule.actionKind ? { actionKind: rule.actionKind } : {}),
      ...(patchedSource ? { patchedSource } : {}),
      ...(vars.envKey ? { envKey: vars.envKey } : {}),
    });
  }

  return hints;
}
