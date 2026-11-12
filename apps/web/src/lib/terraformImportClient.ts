'use client';

import * as Comlink from 'comlink';
import {
  DEFAULT_TERRAFORM_IMPORT_TIMEOUT_MS,
  TERRAFORM_MAX_INPUT_BYTES,
  importTerraformJson,
  type TerraformImportOptions,
  type TerraformImportResult,
} from '@infrasim/terraform';
import type { TerraformImportWorkerApi } from '../workers/terraformImport.worker';

/**
 * Parses and converts Terraform `show -json` input off the main thread in a Web Worker,
 * enforcing the 5 MB input cap and 10 s execution timeout.
 * Falls back to in-process async execution only when `Worker` is unavailable (SSR/Node tests).
 */
export async function runTerraformImportInWorker(
  rawJson: string,
  options: TerraformImportOptions = {},
): Promise<TerraformImportResult> {
  const maxBytes = options.maxBytes ?? TERRAFORM_MAX_INPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERRAFORM_IMPORT_TIMEOUT_MS;
  const byteLength = new TextEncoder().encode(rawJson).byteLength;
  if (byteLength > maxBytes) {
    throw new Error(
      `Terraform JSON size (${(byteLength / (1024 * 1024)).toFixed(2)} MB) exceeds safety limit of ${(maxBytes / (1024 * 1024)).toFixed(1)} MB.`,
    );
  }

  if (typeof Worker === 'undefined') {
    return importTerraformJson(rawJson, options);
  }

  const worker = new Worker(new URL('../workers/terraformImport.worker.ts', import.meta.url), {
    type: 'module',
  });
  const proxy = Comlink.wrap<TerraformImportWorkerApi>(worker);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        worker.terminate();
        reject(
          new Error(
            `Terraform import exceeded ${Math.round(timeoutMs / 1000)}s time limit and was cancelled.`,
          ),
        );
      }, timeoutMs);
    });

    return await Promise.race([proxy.importJson(rawJson, options), timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
    proxy[Comlink.releaseProxy]();
    worker.terminate();
  }
}
