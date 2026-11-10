import type { OperationDef, OperationOverride } from '@infrasim/shared-types';

/** Maximum allowed rendered output size (1 MiB) per docs/specs/06-SERVICE-CATALOG-SPEC.md §4. */
export const MAX_TEMPLATE_OUTPUT_BYTES = 1024 * 1024;
const MAX_REPEAT_COUNT = 10_000;
const MAX_TOKENS_COUNT = 50_000;

export interface TemplateDiagnostic {
  message: string;
  line: number;
  column: number;
}

export interface TemplateValidationResult {
  valid: boolean;
  error?: TemplateDiagnostic;
}

export interface TemplateContext {
  input?: unknown;
  env?: Record<string, string>;
  seq?: number;
  nowMs?: number;
  baseEpochMs?: number;
  seed?: number;
  sizeBytes?: number;
}

export interface TemplateEvalResult {
  body: string;
  byteLength: number;
  truncated?: boolean;
}

export interface MockOperationPreview {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  byteLength: number;
}

// Deterministic fallback names & filler vocabulary for faker / tokens helpers
const FIRST_NAMES = [
  'Avery',
  'Jordan',
  'Priya',
  'Mateo',
  'Hana',
  'Elena',
  'Soren',
  'Nadia',
  'Rohan',
  'Maya',
  'Kai',
  'Clara',
];
const LAST_NAMES = [
  'Patel',
  'Chen',
  'Kim',
  'Garcia',
  'Silva',
  'Okafor',
  'Lindqvist',
  'Kowalski',
  'Tanaka',
  'Singh',
  'Reyes',
  'Weber',
];
const FILLER_TOKENS = [
  'cloud',
  'service',
  'latency',
  'route',
  'cache',
  'queue',
  'metric',
  'node',
  'stream',
  'worker',
  'policy',
  'token',
  'batch',
  'frame',
  'trace',
  'index',
];

function createMulberry32(seedInput: number): () => number {
  let state = seedInput >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashNumbers(a: number, b: number, c: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Pure integer UTC ISO-8601 formatting from epoch milliseconds without constructing Date. */
function formatUtcIsoFromEpochMs(epochMs: number): string {
  const clamped = Math.max(0, Math.floor(epochMs));
  const ms = clamped % 1000;
  let totalSec = Math.floor(clamped / 1000);
  const sec = totalSec % 60;
  totalSec = Math.floor(totalSec / 60);
  const min = totalSec % 60;
  totalSec = Math.floor(totalSec / 60);
  const hour = totalSec % 24;
  const daysSinceEpoch = Math.floor(totalSec / 24);

  // Civil-from-days algorithm (Howard Hinnant)
  const z = daysSinceEpoch + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = y + (month <= 2 ? 1 : 0);

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  const pad4 = (n: number) => String(n).padStart(4, '0');

  return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:${pad2(sec)}.${pad3(ms)}Z`;
}

function getLineCol(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

interface TemplatePart {
  kind: 'text' | 'expr';
  value: string;
  offset: number;
}

/**
 * Splits a template string into text segments and `{{ ... }}` expression contents,
 * respecting quoted string literals inside helpers such as `{{repeat(5, "{\"id\":\"{{faker.uuid}}\"}")}}`.
 */
function tokenizeTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  let textStart = 0;

  while (i < template.length) {
    if (template[i] === '{' && template[i + 1] === '{') {
      if (i > textStart) {
        parts.push({ kind: 'text', value: template.slice(textStart, i), offset: textStart });
      }
      const exprOpenOffset = i;
      i += 2;
      const exprStart = i;
      let braceDepth = 1;
      let quote: '"' | "'" | null = null;
      let escaped = false;
      let closed = false;

      while (i < template.length) {
        const ch = template[i]!;
        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === quote) {
            quote = null;
          }
          i += 1;
          continue;
        }

        if (ch === '"' || ch === "'") {
          quote = ch;
          i += 1;
          continue;
        }

        if (ch === '{' && template[i + 1] === '{') {
          braceDepth += 1;
          i += 2;
          continue;
        }

        if (ch === '}' && template[i + 1] === '}') {
          braceDepth -= 1;
          if (braceDepth === 0) {
            const inner = template.slice(exprStart, i);
            parts.push({ kind: 'expr', value: inner, offset: exprOpenOffset });
            i += 2;
            textStart = i;
            closed = true;
            break;
          }
          i += 2;
          continue;
        }
        i += 1;
      }

      if (!closed) {
        const lc = getLineCol(template, exprOpenOffset);
        throw new TemplateSyntaxError(
          quote ? 'Unclosed string literal inside template expression' : 'Unclosed "{{" expression',
          lc.line,
          lc.column,
        );
      }
      continue;
    }

    i += 1;
  }

  if (textStart < template.length) {
    parts.push({ kind: 'text', value: template.slice(textStart), offset: textStart });
  }
  return parts;
}

function unescapeQuoted(raw: string): string {
  const quote = raw[0]!;
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      const next = body[i + 1]!;
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === quote || next === '\\' || next === '"' || next === "'") out += next;
      else out += next;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function splitCallArgs(rawArgs: string, exprOffset: number, template: string): string[] {
  const args: string[] = [];
  let curStart = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let parenDepth = 0;

  for (let i = 0; i < rawArgs.length; i++) {
    const ch = rawArgs[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
    } else if (ch === ',' && parenDepth === 0) {
      args.push(rawArgs.slice(curStart, i).trim());
      curStart = i + 1;
    }
  }
  if (quote) {
    const lc = getLineCol(template, exprOffset);
    throw new TemplateSyntaxError('Unclosed string argument in helper call', lc.line, lc.column);
  }
  const trailing = rawArgs.slice(curStart).trim();
  if (trailing.length > 0 || args.length > 0) {
    args.push(trailing);
  }
  return args;
}

type ParsedArg =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string };

function parseArgToken(token: string, exprOffset: number, template: string): ParsedArg {
  const trimmed = token.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return { kind: 'string', value: unescapeQuoted(trimmed) };
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { kind: 'number', value: Number(trimmed) };
  }
  if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) {
    return { kind: 'ident', value: trimmed };
  }
  const lc = getLineCol(template, exprOffset);
  throw new TemplateSyntaxError(`Invalid expression argument "${trimmed}"`, lc.line, lc.column);
}

type AstExpr =
  | { kind: 'input'; path: string[] }
  | { kind: 'env'; name: string }
  | { kind: 'seq' }
  | { kind: 'now'; iso: boolean }
  | { kind: 'faker_uuid' }
  | { kind: 'faker_name' }
  | { kind: 'faker_email' }
  | { kind: 'faker_int'; min: number; max: number }
  | { kind: 'faker_hex'; len: number }
  | { kind: 'faker_pick'; choices: string[] }
  | { kind: 'binary'; sizeArg: number | 'sizeBytes' }
  | { kind: 'repeat'; count: number; fragmentNodes: AstNode[] }
  | { kind: 'json'; path: string[] }
  | { kind: 'tokens'; count: number };

type AstNode = { kind: 'text'; value: string } | { kind: 'expr'; expr: AstExpr };

function parseExpression(rawInner: string, exprOffset: number, template: string): AstExpr {
  const expr = rawInner.trim();
  const lc = getLineCol(template, exprOffset);

  if (!expr) {
    throw new TemplateSyntaxError('Empty "{{}}" template expression', lc.line, lc.column);
  }

  if (expr === 'seq') return { kind: 'seq' };
  if (expr === 'now') return { kind: 'now', iso: false };
  if (expr === 'now.iso') return { kind: 'now', iso: true };
  if (expr === 'faker.uuid') return { kind: 'faker_uuid' };
  if (expr === 'faker.name') return { kind: 'faker_name' };
  if (expr === 'faker.email') return { kind: 'faker_email' };

  if (expr.startsWith('input.')) {
    const pathStr = expr.slice('input.'.length);
    const segments = pathStr.split('.').filter(Boolean);
    if (segments.length === 0) {
      throw new TemplateSyntaxError('Missing field path after "input."', lc.line, lc.column);
    }
    return { kind: 'input', path: segments };
  }

  if (expr.startsWith('env.')) {
    const name = expr.slice('env.'.length).trim();
    if (!name) {
      throw new TemplateSyntaxError('Missing variable name after "env."', lc.line, lc.column);
    }
    return { kind: 'env', name };
  }

  const callMatch = /^([a-zA-Z_][a-zA-Z0-9_.]*)\(([\s\S]*)\)$/.exec(expr);
  if (callMatch) {
    const fnName = callMatch[1]!;
    const rawArgBody = callMatch[2]!;
    const argTokens =
      rawArgBody.trim().length > 0 ? splitCallArgs(rawArgBody, exprOffset, template) : [];
    const args = argTokens.map((tok) => parseArgToken(tok, exprOffset, template));

    if (fnName === 'faker.int') {
      if (args.length !== 2 || args[0]!.kind !== 'number' || args[1]!.kind !== 'number') {
        throw new TemplateSyntaxError(
          'faker.int(min, max) expects two integer arguments',
          lc.line,
          lc.column,
        );
      }
      const min = Math.trunc(args[0]!.value);
      const max = Math.trunc(args[1]!.value);
      if (min > max) {
        throw new TemplateSyntaxError(
          `faker.int min (${min}) cannot exceed max (${max})`,
          lc.line,
          lc.column,
        );
      }
      return { kind: 'faker_int', min, max };
    }

    if (fnName === 'faker.hex') {
      if (
        args.length !== 1 ||
        args[0]!.kind !== 'number' ||
        args[0]!.value < 1 ||
        args[0]!.value > 4096
      ) {
        throw new TemplateSyntaxError(
          'faker.hex(n) expects an integer length in [1, 4096]',
          lc.line,
          lc.column,
        );
      }
      return { kind: 'faker_hex', len: Math.trunc(args[0]!.value) };
    }

    if (fnName === 'faker.pick') {
      if (args.length === 0) {
        throw new TemplateSyntaxError(
          'faker.pick(...) expects at least one choice',
          lc.line,
          lc.column,
        );
      }
      const choices = args.map((a) => {
        if (a.kind === 'string') return a.value;
        if (a.kind === 'number') return String(a.value);
        throw new TemplateSyntaxError(
          'faker.pick(...) choices must be string or number literals',
          lc.line,
          lc.column,
        );
      });
      return { kind: 'faker_pick', choices };
    }

    if (fnName === 'binary') {
      if (args.length !== 1) {
        throw new TemplateSyntaxError(
          'binary(n) expects 1 byte-count argument',
          lc.line,
          lc.column,
        );
      }
      const a0 = args[0]!;
      if (a0.kind === 'ident' && a0.value === 'sizeBytes') {
        return { kind: 'binary', sizeArg: 'sizeBytes' };
      }
      if (a0.kind === 'number' && a0.value >= 0) {
        return { kind: 'binary', sizeArg: Math.trunc(a0.value) };
      }
      throw new TemplateSyntaxError(
        'binary(n) expects a non-negative number or "sizeBytes"',
        lc.line,
        lc.column,
      );
    }

    if (fnName === 'repeat') {
      if (args.length !== 2 || args[0]!.kind !== 'number' || args[1]!.kind !== 'string') {
        throw new TemplateSyntaxError(
          'repeat(n, "...") expects an integer count and a string fragment',
          lc.line,
          lc.column,
        );
      }
      const count = Math.trunc(args[0]!.value);
      if (count < 0 || count > MAX_REPEAT_COUNT) {
        throw new TemplateSyntaxError(
          `repeat count must be between 0 and ${MAX_REPEAT_COUNT}`,
          lc.line,
          lc.column,
        );
      }
      const fragmentNodes = parseAst(args[1]!.value);
      return { kind: 'repeat', count, fragmentNodes };
    }

    if (fnName === 'json') {
      if (args.length !== 1 || args[0]!.kind !== 'ident') {
        throw new TemplateSyntaxError(
          'json(input) expects "input" or "input.field"',
          lc.line,
          lc.column,
        );
      }
      const target = args[0]!.value;
      if (target === 'input') {
        return { kind: 'json', path: [] };
      }
      if (target.startsWith('input.')) {
        return { kind: 'json', path: target.slice('input.'.length).split('.').filter(Boolean) };
      }
      throw new TemplateSyntaxError('json(...) path must reference "input"', lc.line, lc.column);
    }

    if (fnName === 'tokens') {
      if (
        args.length !== 1 ||
        args[0]!.kind !== 'number' ||
        args[0]!.value < 0 ||
        args[0]!.value > MAX_TOKENS_COUNT
      ) {
        throw new TemplateSyntaxError(
          `tokens(n) expects an integer in [0, ${MAX_TOKENS_COUNT}]`,
          lc.line,
          lc.column,
        );
      }
      return { kind: 'tokens', count: Math.trunc(args[0]!.value) };
    }

    throw new TemplateSyntaxError(`Unknown template helper "${fnName}"`, lc.line, lc.column);
  }

  throw new TemplateSyntaxError(`Unknown template expression "${expr}"`, lc.line, lc.column);
}

function parseAst(template: string): AstNode[] {
  const parts = tokenizeTemplate(template);
  return parts.map((part) => {
    if (part.kind === 'text') {
      return { kind: 'text', value: part.value };
    }
    return {
      kind: 'expr',
      expr: parseExpression(part.value, part.offset, template),
    };
  });
}

function resolvePath(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const key of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(key);
      current =
        Number.isInteger(idx) && idx >= 0 && idx < current.length ? current[idx] : undefined;
    } else {
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

function randomHex(rng: () => number, len: number): string {
  const hexChars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += hexChars[Math.floor(rng() * 16) % 16]!;
  }
  return out;
}

function randomUuid(rng: () => number): string {
  const p1 = randomHex(rng, 8);
  const p2 = randomHex(rng, 4);
  const p3 = `4${randomHex(rng, 3)}`;
  const variant = ['8', '9', 'a', 'b'][Math.floor(rng() * 4) % 4]!;
  const p4 = `${variant}${randomHex(rng, 3)}`;
  const p5 = randomHex(rng, 12);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

function evalNodes(
  nodes: AstNode[],
  ctx: TemplateContext,
  rng: () => number,
  extraBinaryBytes: { total: number },
): string {
  let output = '';

  for (const node of nodes) {
    if (node.kind === 'text') {
      output += node.value;
    } else {
      const e = node.expr;
      switch (e.kind) {
        case 'input': {
          const val = resolvePath(ctx.input, e.path);
          if (val === undefined || val === null) {
            output += '';
          } else if (typeof val === 'object') {
            output += JSON.stringify(val);
          } else {
            output += String(val);
          }
          break;
        }
        case 'env': {
          output += ctx.env?.[e.name] ?? '';
          break;
        }
        case 'seq': {
          output += String(ctx.seq ?? 1);
          break;
        }
        case 'now': {
          const baseEpochMs = ctx.baseEpochMs ?? 1_700_000_000_000;
          const vMs = Math.max(0, ctx.nowMs ?? 0);
          output += e.iso ? formatUtcIsoFromEpochMs(baseEpochMs + vMs) : String(Math.round(vMs));
          break;
        }
        case 'faker_uuid': {
          output += randomUuid(rng);
          break;
        }
        case 'faker_name': {
          const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length) % FIRST_NAMES.length]!;
          const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length) % LAST_NAMES.length]!;
          output += `${first} ${last}`;
          break;
        }
        case 'faker_email': {
          const first =
            FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length) % FIRST_NAMES.length]!.toLowerCase();
          const num = Math.floor(rng() * 900 + 100);
          output += `${first}${num}@example.test`;
          break;
        }
        case 'faker_int': {
          const span = e.max - e.min + 1;
          output += String(e.min + Math.floor(rng() * span));
          break;
        }
        case 'faker_hex': {
          output += randomHex(rng, e.len);
          break;
        }
        case 'faker_pick': {
          const choice = e.choices[Math.floor(rng() * e.choices.length) % e.choices.length]!;
          output += choice;
          break;
        }
        case 'binary': {
          const byteCount = Math.max(
            0,
            e.sizeArg === 'sizeBytes' ? (ctx.sizeBytes ?? 1024) : e.sizeArg,
          );
          extraBinaryBytes.total += byteCount;
          output += byteCount === 0 ? '' : `<binary:${byteCount}B>`;
          break;
        }
        case 'repeat': {
          const seedBase = hashNumbers(ctx.seed ?? 42, ctx.seq ?? 1, e.count);
          const chunks: string[] = [];
          let runningLen = output.length;
          for (let i = 0; i < e.count; i++) {
            const subRng = createMulberry32(hashNumbers(seedBase, i + 1, 0x2f6e2b1));
            const item = evalNodes(e.fragmentNodes, ctx, subRng, extraBinaryBytes);
            runningLen += item.length + (i > 0 ? 1 : 0);
            if (runningLen > MAX_TEMPLATE_OUTPUT_BYTES) {
              throw new Error(
                `Template output exceeded 1 MB limit (${MAX_TEMPLATE_OUTPUT_BYTES} bytes)`,
              );
            }
            chunks.push(item);
          }
          output += chunks.join(',');
          break;
        }
        case 'json': {
          const target = e.path.length === 0 ? ctx.input : resolvePath(ctx.input, e.path);
          output += JSON.stringify(target ?? null);
          break;
        }
        case 'tokens': {
          const words: string[] = [];
          for (let i = 0; i < e.count; i++) {
            words.push(
              FILLER_TOKENS[Math.floor(rng() * FILLER_TOKENS.length) % FILLER_TOKENS.length]!,
            );
          }
          output += words.join(' ');
          break;
        }
      }
    }

    if (output.length > MAX_TEMPLATE_OUTPUT_BYTES) {
      throw new Error(`Template output exceeded 1 MB limit (${MAX_TEMPLATE_OUTPUT_BYTES} bytes)`);
    }
  }

  return output;
}

/** Validates template expression syntax and reports exact 1-based line and column diagnostics. */
export function validateResponseTemplate(template: string): TemplateValidationResult {
  try {
    parseAst(template);
    return { valid: true };
  } catch (err) {
    if (err instanceof TemplateSyntaxError) {
      return {
        valid: false,
        error: {
          message: err.message,
          line: err.line,
          column: err.column,
        },
      };
    }
    return {
      valid: false,
      error: {
        message: err instanceof Error ? err.message : 'Invalid response template',
        line: 1,
        column: 1,
      },
    };
  }
}

/** Evaluates a mock response template deterministically using virtual time and a seeded PRNG. */
export function evaluateResponseTemplate(
  template: string,
  context: TemplateContext = {},
): TemplateEvalResult {
  const ast = parseAst(template);
  const seed = hashNumbers(context.seed ?? 42, context.seq ?? 1, Math.round(context.nowMs ?? 0));
  const rng = createMulberry32(seed);
  const extraBinaryBytes = { total: 0 };
  const body = evalNodes(ast, context, rng, extraBinaryBytes);
  const encodedBytes = new TextEncoder().encode(body).length;
  if (encodedBytes > MAX_TEMPLATE_OUTPUT_BYTES) {
    throw new Error(`Template output exceeded 1 MB limit (${MAX_TEMPLATE_OUTPUT_BYTES} bytes)`);
  }
  const byteLength =
    extraBinaryBytes.total > 0 ? Math.max(encodedBytes, extraBinaryBytes.total) : encodedBytes;
  return {
    body,
    byteLength,
  };
}

/** Renders a full preview of an operation response combining catalog defaults and node overrides. */
export function renderMockOperationPreview(
  operation: OperationDef,
  override: OperationOverride | undefined,
  context: TemplateContext = {},
): MockOperationPreview {
  const statusCode = override?.statusCode ?? operation.defaultResponse.statusCode;
  const rawHeaders = override?.headers ?? operation.defaultResponse.headers ?? {};
  const template = override?.responseTemplate ?? operation.defaultResponse.bodyTemplate;
  const sizeBytes = override?.responseSizeBytes ?? operation.defaultResponse.sizeBytes ?? 1024;

  const headers: Record<string, string> = {};
  for (const [idx, [k, v]] of Object.entries(rawHeaders).entries()) {
    const res = evaluateResponseTemplate(v, {
      ...context,
      sizeBytes,
      seed: (context.seed ?? 42) + idx + 1,
    });
    headers[k] = res.body;
  }

  const evaluated = evaluateResponseTemplate(template, { ...context, sizeBytes });
  return {
    statusCode,
    headers,
    body: evaluated.body,
    byteLength: override?.responseSizeBytes ?? Math.max(evaluated.byteLength, 0),
  };
}
