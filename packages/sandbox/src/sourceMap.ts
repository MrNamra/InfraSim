import type { SourceLocation } from './types.js';

interface RawSourceMapV3 {
  version: number;
  sources?: string[];
  names?: string[];
  mappings?: string;
}

interface MappingSegment {
  generatedColumn: number;
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
}

const VLQ_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_CHAR_TO_VAL = new Map<string, number>(Array.from(VLQ_BASE64).map((ch, idx) => [ch, idx]));

function decodeVlqSegment(line: string): MappingSegment[] {
  const segments: MappingSegment[] = [];
  let i = 0;
  let generatedColumn = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;

  while (i < line.length) {
    if (line[i] === ',') {
      i += 1;
      continue;
    }

    const readVlq = (): number | null => {
      let result = 0;
      let shift = 0;
      while (i < line.length) {
        const ch = line[i]!;
        if (ch === ',' || ch === ';') {
          return null;
        }
        i += 1;
        const digit = VLQ_CHAR_TO_VAL.get(ch);
        if (digit === undefined) {
          return null;
        }
        const continuation = (digit & 32) !== 0;
        result += (digit & 31) << shift;
        shift += 5;
        if (!continuation) {
          const negative = (result & 1) === 1;
          const shifted = result >> 1;
          return negative ? -shifted : shifted;
        }
      }
      return null;
    };

    const dGenCol = readVlq();
    if (dGenCol === null) break;
    generatedColumn += dGenCol;

    if (i >= line.length || line[i] === ',') {
      continue;
    }

    const dSource = readVlq();
    const dOrigLine = readVlq();
    const dOrigCol = readVlq();
    if (dSource === null || dOrigLine === null || dOrigCol === null) {
      break;
    }
    sourceIndex += dSource;
    originalLine += dOrigLine;
    originalColumn += dOrigCol;

    // Consume optional 5th field (name index)
    if (i < line.length && line[i] !== ',') {
      readVlq();
    }

    segments.push({
      generatedColumn: generatedColumn + 1, // 1-based
      sourceIndex,
      originalLine: originalLine + 1, // 1-based
      originalColumn: originalColumn + 1, // 1-based
    });
  }

  return segments;
}

/** Decodes Source Map v3 mappings so bundled QuickJS stacks map to editor lines/columns. */
export class SourceMapTranslator {
  private readonly sources: string[];
  private readonly lines: MappingSegment[][];
  private readonly preludeLineOffset: number;

  constructor(sourceMapJson?: string, preludeLineOffset = 0) {
    this.preludeLineOffset = preludeLineOffset;
    if (!sourceMapJson) {
      this.sources = [];
      this.lines = [];
      return;
    }

    let parsed: RawSourceMapV3;
    try {
      parsed = JSON.parse(sourceMapJson) as RawSourceMapV3;
    } catch {
      this.sources = [];
      this.lines = [];
      return;
    }

    this.sources = parsed.sources ?? [];
    const rawMappings = parsed.mappings ?? '';
    if (!rawMappings) {
      this.lines = [];
      return;
    }

    const rawLines = rawMappings.split(';');
    let prevSource = 0;
    let prevOrigLine = 0;
    let prevOrigCol = 0;

    this.lines = rawLines.map((rawLine) => {
      if (!rawLine) return [];
      // NOTE: sourceIndex/originalLine/originalColumn state persists across lines in Source Map v3
      const segments: MappingSegment[] = [];
      let i = 0;
      let generatedCol = 0;

      while (i < rawLine.length) {
        if (rawLine[i] === ',') {
          i += 1;
          continue;
        }
        const readVlq = (): number | null => {
          let result = 0;
          let shift = 0;
          while (i < rawLine.length) {
            const ch = rawLine[i]!;
            if (ch === ',') return null;
            i += 1;
            const digit = VLQ_CHAR_TO_VAL.get(ch);
            if (digit === undefined) return null;
            const cont = (digit & 32) !== 0;
            result += (digit & 31) << shift;
            shift += 5;
            if (!cont) {
              const neg = (result & 1) === 1;
              const shifted = result >> 1;
              return neg ? -shifted : shifted;
            }
          }
          return null;
        };

        const dGenCol = readVlq();
        if (dGenCol === null) break;
        generatedCol += dGenCol;
        if (i >= rawLine.length || rawLine[i] === ',') {
          continue;
        }
        const dSrc = readVlq();
        const dLine = readVlq();
        const dCol = readVlq();
        if (dSrc === null || dLine === null || dCol === null) break;
        prevSource += dSrc;
        prevOrigLine += dLine;
        prevOrigCol += dCol;
        if (i < rawLine.length && rawLine[i] !== ',') {
          readVlq();
        }
        segments.push({
          generatedColumn: generatedCol + 1,
          sourceIndex: prevSource,
          originalLine: prevOrigLine + 1,
          originalColumn: prevOrigCol + 1,
        });
      }
      return segments;
    });
  }

  /** Resolves a bundled QuickJS line and column back to original source location. */
  resolve(bundleLine: number, bundleColumn = 1): SourceLocation {
    const adjustedLine = Math.max(1, bundleLine - this.preludeLineOffset);
    const segments = this.lines[adjustedLine - 1];
    if (!segments || segments.length === 0) {
      return { line: adjustedLine, column: Math.max(1, bundleColumn) };
    }

    let best = segments[0]!;
    for (const seg of segments) {
      if (seg.generatedColumn <= bundleColumn) {
        best = seg;
      } else {
        break;
      }
    }

    const file = this.sources[best.sourceIndex];
    return {
      ...(file ? { file } : {}),
      line: Math.max(1, best.originalLine),
      column: Math.max(1, best.originalColumn),
    };
  }

  /** Rewrites bundled QuickJS stack frames (`bundle.js:line:col`) to original source locations. */
  rewriteStack(
    rawStack: string | undefined,
    bundleFilename = 'bundle.js',
  ): {
    stack: string | undefined;
    firstSite?: SourceLocation;
  } {
    if (!rawStack) {
      return { stack: undefined };
    }

    const escaped = bundleFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped}):(\\d+)(?::(\\d+))?`, 'g');
    let firstSite: SourceLocation | undefined;

    const rewritten = rawStack.replace(re, (_full, _file, lineStr: string, colStr?: string) => {
      const genLine = Number(lineStr);
      const genCol = colStr ? Number(colStr) : 1;
      const mapped = this.resolve(genLine, genCol);
      if (!firstSite) {
        firstSite = mapped;
      }
      const label = mapped.file ?? 'handler';
      return `${label}:${mapped.line}:${mapped.column}`;
    });

    return { stack: rewritten, firstSite };
  }
}

void decodeVlqSegment;
