import type {
  Design,
  NodeInstance,
  PayloadFixture,
  ScriptAsset,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { executeInSandbox } from './runtime.js';
import type { DryRunResult, MockCallResolver, SandboxLimits } from './types.js';

export interface FixtureSuiteItemResult {
  fixtureId: string;
  fixtureName: string;
  passed: boolean;
  reason?: string;
  expectedStatus?: number;
  actualStatus?: number;
  virtualDurationMs: number;
  dryRunResult: DryRunResult;
}

export interface FixtureSuiteReport {
  total: number;
  passed: number;
  failed: number;
  results: FixtureSuiteItemResult[];
}

export interface RunFixtureSuiteInput {
  script: ScriptAsset;
  fixtures: readonly PayloadFixture[];
  designScripts?: readonly ScriptAsset[];
  design?: Design;
  node?: NodeInstance;
  service?: ServiceDefinition;
  customServices?: readonly ServiceDefinition[];
  seed?: number;
  env?: Record<string, string>;
  limits?: Partial<SandboxLimits>;
  mockResolver?: MockCallResolver;
  quickJsWasmUrl?: string;
  esbuildWasmUrl?: string;
}

/** Executes a handler script against every fixture in a test suite and checks expected HTTP status / non-throwing behavior. */
export async function runFixtureSuite(input: RunFixtureSuiteInput): Promise<FixtureSuiteReport> {
  const baseSeed = input.seed ?? input.design?.settings.seed ?? 42;
  const results: FixtureSuiteItemResult[] = [];
  let passedCount = 0;

  for (let i = 0; i < input.fixtures.length; i++) {
    const fixture = input.fixtures[i]!;
    const dryRunResult = await executeInSandbox({
      script: input.script,
      fixture,
      seed: baseSeed + i,
      seq: i + 1,
      ...(input.designScripts ? { designScripts: input.designScripts } : {}),
      ...(input.design ? { design: input.design } : {}),
      ...(input.node ? { node: input.node } : {}),
      ...(input.service ? { service: input.service } : {}),
      ...(input.customServices ? { customServices: input.customServices } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.mockResolver ? { mockResolver: input.mockResolver } : {}),
      ...(input.quickJsWasmUrl ? { quickJsWasmUrl: input.quickJsWasmUrl } : {}),
      ...(input.esbuildWasmUrl ? { esbuildWasmUrl: input.esbuildWasmUrl } : {}),
    });

    const actualStatus = dryRunResult.httpStatus;
    let passed = dryRunResult.ok;
    let reason: string | undefined;

    if (!dryRunResult.ok) {
      reason = dryRunResult.error
        ? `${dryRunResult.error.name}: ${dryRunResult.error.message}`
        : 'Invocation failed';
    } else if (fixture.expectedStatus !== undefined) {
      if (actualStatus === undefined) {
        passed = false;
        reason = `Expected HTTP status ${fixture.expectedStatus} but handler returned no statusCode`;
      } else if (actualStatus !== fixture.expectedStatus) {
        passed = false;
        reason = `Expected status ${fixture.expectedStatus}, got ${actualStatus}`;
      }
    }

    if (passed) {
      passedCount += 1;
    }

    results.push({
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      passed,
      ...(reason ? { reason } : {}),
      ...(fixture.expectedStatus !== undefined ? { expectedStatus: fixture.expectedStatus } : {}),
      ...(actualStatus !== undefined ? { actualStatus } : {}),
      virtualDurationMs: dryRunResult.virtualDurationMs,
      dryRunResult,
    });
  }

  return {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    results,
  };
}
