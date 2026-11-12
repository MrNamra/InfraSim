import { describe, expect, it, vi } from 'vitest';
import type { ScriptAsset } from '@infrasim/shared-types';
import { createSandboxClient } from './sandboxClient';

const sampleScript: ScriptAsset = {
  id: 's1',
  name: 'index.js',
  kind: 'handler',
  language: 'javascript',
  entry: 'handler',
  source: 'export async function handler() { return { ok: true }; }',
  memoryMb: 128,
  timeoutMs: 3000,
  env: {},
};

describe('T3.1 sandboxClient heartbeat watchdog', () => {
  it('terminates a hung worker after watchdog timeout and respawns a clean worker on the next run', async () => {
    let spawnCount = 0;
    const terminated: number[] = [];

    const client = createSandboxClient({
      watchdogTimeoutMs: 60,
      createWorker: () => {
        const workerId = ++spawnCount;
        return {
          ping: async () => {
            if (workerId === 1) {
              // Hang heartbeat on worker 1
              return new Promise<number>(() => {});
            }
            return Date.now();
          },
          dryRun: async () => {
            if (workerId === 1) {
              // Never resolve dryRun on hung worker 1
              return new Promise(() => {});
            }
            return {
              ok: true,
              seed: 42,
              result: { recovered: true },
              virtualDurationMs: 1,
              billedDurationMs: 1,
              guestCpuMs: 1,
              memoryPeakBytes: 1024,
              logs: [],
              calls: [],
            };
          },
          terminate: () => {
            terminated.push(workerId);
          },
        };
      },
    });

    const first = await client.dryRun({ script: sampleScript });
    expect(first.ok).toBe(false);
    expect(first.error?.name).toBe('WorkerWatchdogTimeout');
    expect(terminated).toEqual([1]);

    const second = await client.dryRun({ script: sampleScript });
    expect(second.ok).toBe(true);
    expect(second.result).toEqual({ recovered: true });
    expect(spawnCount).toBe(2);

    const spy = vi.fn();
    spy(second);
    expect(spy).toHaveBeenCalledOnce();
    client.terminate();
  });

  it('delegates runSuite cleanly via fallback when Worker is unavailable', async () => {
    const client = createSandboxClient();
    const report = await client.runSuite({
      script: {
        ...sampleScript,
        source:
          'export async function handler() { return { statusCode: 200, body: JSON.stringify({ ok: true }) }; }',
      },
      fixtures: [
        { id: 'f1', name: 'Pass 200', event: {}, expectedStatus: 200 },
        { id: 'f2', name: 'Expect 201', event: {}, expectedStatus: 201 },
      ],
    });
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    client.terminate();
  });
});
