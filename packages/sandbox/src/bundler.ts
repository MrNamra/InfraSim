import * as esbuild from 'esbuild-wasm';
import type { ScriptAsset } from '@infrasim/shared-types';
import {
  ALLOWED_SANDBOX_MODULES,
  generateVirtualSdkFallbackModule,
  generateVirtualUtilityModule,
  isAllowedAllowlistPackage,
  isRestrictedBuiltin,
  isSafeBuiltin,
} from './shims/allowlistLibs.js';
import { generateCloudSdkShimModule } from './shims/cloudSdks.js';
import { DEFAULT_DRY_RUN_LIMITS, type BundleResult, type SandboxErrorReport } from './types.js';

export type VirtualSdkGenerator = (specifier: string) => string | null;

export interface BundleScriptInput {
  entryScript: ScriptAsset;
  designScripts?: readonly ScriptAsset[];
  esbuildWasmUrl?: string;
  /** Optional custom SDK virtual module generator (populated cleanly by T3.4 cloud shims). */
  sdkGenerator?: VirtualSdkGenerator;
}

const textEncoder = new TextEncoder();
const VIRTUAL_PREFIX = '/design/';
const UNSUPPORTED_MARKER = 'INFRASIM_UNSUPPORTED_MODULE::';
const MISSING_REL_MARKER = 'INFRASIM_MISSING_SCRIPT::';

const esbuildInitPromiseRef = { current: null as Promise<void> | null };
const registeredSdkGenerators: VirtualSdkGenerator[] = [generateCloudSdkShimModule];
const bundleCache = new Map<string, BundleResult>();

/** Registers a virtual SDK shim generator (used internally by T3.4 drop-in cloud SDK shims). */
export function registerSdkShimGenerator(generator: VirtualSdkGenerator): void {
  if (!registeredSdkGenerators.includes(generator)) {
    registeredSdkGenerators.unshift(generator);
    bundleCache.clear();
  }
}

/** Clears cached compiled bundles (primarily for testing). */
export function clearBundleCache(): void {
  bundleCache.clear();
}

/** Stops any background esbuild-wasm worker/subprocess cleanly on teardown. */
export async function stopSandboxBundler(): Promise<void> {
  bundleCache.clear();
  esbuildInitPromiseRef.current = null;
  await esbuild.stop();
}

async function ensureEsbuildInitialized(wasmUrl?: string): Promise<void> {
  const isBrowserLike =
    Boolean(wasmUrl) ||
    typeof (globalThis as { window?: unknown }).window !== 'undefined' ||
    typeof (globalThis as { importScripts?: unknown }).importScripts === 'function' ||
    (typeof (globalThis as { self?: unknown }).self !== 'undefined' &&
      typeof process === 'undefined');

  if (!isBrowserLike) {
    // In Node ESM/Vitest tests, esbuild-wasm runs directly without `initialize()`.
    return;
  }

  if (!esbuildInitPromiseRef.current) {
    const resolvedWasmUrl = wasmUrl || '/wasm/esbuild.wasm';
    esbuildInitPromiseRef.current = esbuild
      .initialize({
        wasmURL: resolvedWasmUrl,
        worker: false,
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already called')) {
          esbuildInitPromiseRef.current = null;
          throw err;
        }
      });
  }
  await esbuildInitPromiseRef.current;
}

function normalizePosixPath(p: string): string {
  const parts = p.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return '/' + stack.join('/');
}

function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function normalizeVirtualScriptPath(name: string): string {
  const cleaned = name.trim().replace(/^\/+/, '').replace(/^\.\//, '');
  return normalizePosixPath(VIRTUAL_PREFIX + (cleaned || 'handler.js'));
}

function getEsbuildLoader(name: string, language?: ScriptAsset['language']): esbuild.Loader {
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || language === 'typescript') return 'ts';
  if (lower.endsWith('.jsx')) return 'jsx';
  return 'js';
}

function hashBundleKey(entryScript: ScriptAsset, designScripts: readonly ScriptAsset[]): string {
  const parts = [
    entryScript.id,
    entryScript.name,
    entryScript.language,
    entryScript.source,
    ...designScripts.map((s) => `${s.id}:${s.name}:${s.language}:${s.source}`),
  ];
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (const str of parts) {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    h1 ^= 0xff;
  }
  return `${h1.toString(16)}-${h2.toString(16)}-${entryScript.source.length}-${designScripts.length}`;
}

function cleanSourceMapJson(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as { sources?: string[] };
    if (Array.isArray(parsed.sources)) {
      parsed.sources = parsed.sources.map((src) =>
        src
          .replace(/^infrasim-design:/, '')
          .replace(/^infrasim-allowlist:/, 'allowlist:')
          .replace(/^\/design\//, ''),
      );
    }
    return JSON.stringify(parsed);
  } catch {
    return rawJson;
  }
}

function formatBuildFailure(err: unknown): SandboxErrorReport[] {
  const esErr = err as {
    errors?: {
      text: string;
      location?: { file?: string; line?: number; column?: number } | null;
    }[];
    message?: string;
  };

  if (Array.isArray(esErr.errors) && esErr.errors.length > 0) {
    return esErr.errors.map((e) => {
      const site = e.location
        ? {
            ...(e.location.file ? { file: e.location.file.replace(/^\/design\//, '') } : {}),
            line: Math.max(1, e.location.line ?? 1),
            column: Math.max(1, (e.location.column ?? 0) + 1),
          }
        : undefined;

      if (e.text.includes(UNSUPPORTED_MARKER)) {
        const spec = e.text.split(UNSUPPORTED_MARKER)[1]?.trim() ?? 'unknown';
        return {
          category: 'UnsupportedModule',
          name: 'UnsupportedModule',
          message: `Module "${spec}" isn't available in the simulator. Available modules: ${ALLOWED_SANDBOX_MODULES.join(', ')}`,
          ...(site ? { site } : {}),
        };
      }

      if (e.text.includes(MISSING_REL_MARKER)) {
        const payload = e.text.split(MISSING_REL_MARKER)[1]?.trim() ?? '';
        const [target, available] = payload.split('|AVAIL|');
        return {
          category: 'UnsupportedModule',
          name: 'UnsupportedModule',
          message: `Relative import "${target}" was not found in design scripts.${available ? ` Available scripts: ${available}` : ''}`,
          ...(site ? { site } : {}),
        };
      }

      return {
        category: 'UserCodeError',
        name: 'SyntaxError',
        message: e.text,
        ...(site ? { site } : {}),
      };
    });
  }

  return [
    {
      category: 'UserCodeError',
      name: 'BuildError',
      message: err instanceof Error ? err.message : String(err),
    },
  ];
}

/** Returns true when `specifier` belongs to the sandbox allow-list or supported Node stubs. */
export function isAllowedModuleSpecifier(specifier: string): boolean {
  return (
    isAllowedAllowlistPackage(specifier) ||
    isSafeBuiltin(specifier) ||
    isRestrictedBuiltin(specifier)
  );
}

/**
 * Bundles user JS/TS scripts via `esbuild-wasm` using an isolated in-memory virtual filesystem,
 * stripping TypeScript annotations, resolving allow-listed modules & sibling design scripts,
 * and generating Source Map v3 mappings back to original line/column coordinates.
 */
export async function bundleUserScript(input: BundleScriptInput): Promise<BundleResult> {
  const { entryScript } = input;
  const designScripts = input.designScripts ?? [];

  // Enforce source limits prior to compilation
  const entryBytes = textEncoder.encode(entryScript.source).length;
  if (entryBytes > DEFAULT_DRY_RUN_LIMITS.maxSourceBytes) {
    return {
      ok: false,
      errors: [
        {
          category: 'UserCodeError',
          name: 'SourceLimitError',
          message: `Script size (${Math.round(entryBytes / 1024)} KB) exceeds 200 KB limit`,
        },
      ],
    };
  }
  const allScripts = [
    entryScript,
    ...designScripts.filter((s) => s.id !== entryScript.id && s.name !== entryScript.name),
  ];
  const totalBytes = allScripts.reduce((acc, s) => acc + textEncoder.encode(s.source).length, 0);
  if (totalBytes > DEFAULT_DRY_RUN_LIMITS.maxDesignSourceBytes) {
    return {
      ok: false,
      errors: [
        {
          category: 'UserCodeError',
          name: 'SourceLimitError',
          message: `Design script bundle size (${Math.round(totalBytes / 1024)} KB) exceeds 1 MB limit`,
        },
      ],
    };
  }

  const cacheKey = hashBundleKey(entryScript, allScripts);
  const cached = !input.sdkGenerator ? bundleCache.get(cacheKey) : undefined;
  if (cached) {
    return cached;
  }

  await ensureEsbuildInitialized(input.esbuildWasmUrl);

  const scriptMap = new Map<string, ScriptAsset>();
  for (const script of allScripts) {
    scriptMap.set(normalizeVirtualScriptPath(script.name), script);
  }
  const entryPath = normalizeVirtualScriptPath(entryScript.name);
  const availableScriptNames = allScripts.map((s) => s.name).join(', ');
  const resolvedModules = new Set<string>();

  const virtualPlugin: esbuild.Plugin = {
    name: 'infrasim-virtual-sandbox',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') {
          return { path: entryPath, namespace: 'infrasim-design' };
        }

        // Relative or absolute design-local imports
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const baseDir = args.importer ? dirnamePosix(args.importer) : dirnamePosix(entryPath);
          const candidateBase = args.path.startsWith('/')
            ? normalizePosixPath(
                args.path.startsWith('/design/') ? args.path : VIRTUAL_PREFIX + args.path.slice(1),
              )
            : normalizePosixPath(`${baseDir}/${args.path}`);

          const candidates = [
            candidateBase,
            `${candidateBase}.ts`,
            `${candidateBase}.tsx`,
            `${candidateBase}.js`,
            `${candidateBase}.mjs`,
            `${candidateBase}.json`,
            `${candidateBase}/index.ts`,
            `${candidateBase}/index.js`,
          ];

          for (const candidate of candidates) {
            if (scriptMap.has(candidate)) {
              return { path: candidate, namespace: 'infrasim-design' };
            }
          }

          return {
            errors: [
              {
                text: `${MISSING_REL_MARKER}${args.path}|AVAIL|${availableScriptNames}`,
              },
            ],
          };
        }

        // Allow-listed external modules & safe/restricted Node builtins
        if (isAllowedModuleSpecifier(args.path)) {
          resolvedModules.add(args.path);
          return { path: args.path, namespace: 'infrasim-allowlist' };
        }

        return {
          errors: [
            {
              text: `${UNSUPPORTED_MARKER}${args.path}`,
            },
          ],
        };
      });

      build.onLoad({ filter: /.*/, namespace: 'infrasim-design' }, (args) => {
        const script = scriptMap.get(args.path);
        if (!script) {
          return {
            errors: [
              {
                text: `${MISSING_REL_MARKER}${args.path}|AVAIL|${availableScriptNames}`,
              },
            ],
          };
        }
        return {
          contents: script.source,
          loader: getEsbuildLoader(script.name, script.language),
          resolveDir: dirnamePosix(args.path),
        };
      });

      build.onLoad({ filter: /.*/, namespace: 'infrasim-allowlist' }, (args) => {
        const customCode =
          input.sdkGenerator?.(args.path) ??
          registeredSdkGenerators.reduce<string | null>(
            (found, gen) => found ?? gen(args.path),
            null,
          );
        const contents =
          customCode ??
          generateVirtualUtilityModule(args.path) ??
          generateVirtualSdkFallbackModule(args.path);

        if (!contents) {
          return {
            errors: [{ text: `${UNSUPPORTED_MARKER}${args.path}` }],
          };
        }

        return {
          contents,
          loader: 'js',
        };
      });
    },
  };

  try {
    const out = await esbuild.build({
      entryPoints: [entryPath],
      outfile: 'bundle.js',
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__infrasimModuleExports',
      target: ['es2022'],
      platform: 'neutral',
      mainFields: ['module', 'main'],
      sourcemap: 'external',
      sourcesContent: false,
      plugins: [virtualPlugin],
      logLevel: 'silent',
    });

    let codeText = '';
    let mapText: string | undefined;
    for (const file of out.outputFiles ?? []) {
      if (file.path.endsWith('.map')) {
        mapText = cleanSourceMapJson(file.text);
      } else if (file.path.endsWith('.js')) {
        codeText = file.text;
      }
    }

    const finalCode = `${codeText}\nglobalThis.__infrasimModuleExports = typeof __infrasimModuleExports !== 'undefined' ? __infrasimModuleExports : {};\n`;
    const result: BundleResult = {
      ok: true,
      code: finalCode,
      ...(mapText ? { sourceMapJson: mapText } : {}),
      warnings: out.warnings.map((w) => w.text),
      resolvedModules: Array.from(resolvedModules),
    };

    if (!input.sdkGenerator) {
      if (bundleCache.size > 64) {
        const firstKey = bundleCache.keys().next().value;
        if (firstKey) bundleCache.delete(firstKey);
      }
      bundleCache.set(cacheKey, result);
    }

    return result;
  } catch (err) {
    return {
      ok: false,
      errors: formatBuildFailure(err),
    };
  }
}
