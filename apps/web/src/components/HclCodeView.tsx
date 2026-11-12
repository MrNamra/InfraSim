'use client';

import { useMemo } from 'react';

export interface HclCodeViewProps {
  content: string;
  previousContent?: string;
  language: 'hcl' | 'markdown';
  testId?: string;
}

const HCL_KEYWORDS = new Set([
  'resource',
  'data',
  'variable',
  'output',
  'provider',
  'terraform',
  'required_providers',
  'locals',
  'module',
  'dynamic',
]);

interface HclTokenPart {
  text: string;
  tone: 'comment' | 'keyword' | 'string' | 'number' | 'bool' | 'key' | 'ref' | 'plain';
}

function tokenizeHclLine(line: string): HclTokenPart[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return [{ text: line, tone: 'comment' }];
  }

  const parts: HclTokenPart[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '#') {
      parts.push({ text: line.slice(i), tone: 'comment' });
      break;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\' && j + 1 < line.length) {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      parts.push({ text: line.slice(i, j), tone: 'string' });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_.-]/.test(line[j]!)) {
        j++;
      }
      const word = line.slice(i, j);
      if (word === 'true' || word === 'false' || word === 'null') {
        parts.push({ text: word, tone: 'bool' });
      } else if (HCL_KEYWORDS.has(word)) {
        parts.push({ text: word, tone: 'keyword' });
      } else if (/^\s*=/.test(line.slice(j))) {
        parts.push({ text: word, tone: 'key' });
      } else if (word.includes('.')) {
        parts.push({ text: word, tone: 'ref' });
      } else {
        parts.push({ text: word, tone: 'plain' });
      }
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < line.length && /[0-9.]/.test(line[j]!)) {
        j++;
      }
      parts.push({ text: line.slice(i, j), tone: 'number' });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < line.length && !/[A-Za-z0-9_"#]/.test(line[j]!)) {
      j++;
    }
    parts.push({ text: line.slice(i, j), tone: 'plain' });
    i = j;
  }
  return parts;
}

const TONE_CLASS: Record<HclTokenPart['tone'], string> = {
  comment: 'text-[var(--text-muted)] italic',
  keyword: 'text-[var(--accent)] font-medium',
  string: 'text-[var(--status-ok)]',
  number: 'text-[var(--status-warm)]',
  bool: 'text-[var(--status-warm)]',
  key: 'text-[var(--text-primary)]',
  ref: 'text-[#60a5fa]',
  plain: 'text-[var(--text-secondary)]',
};

/** Calibrated HCL/Markdown viewer with line numbers and edit-diff gutter ticks. */
export function HclCodeView({ content, previousContent, language, testId }: HclCodeViewProps) {
  const rows = useMemo(() => {
    const lines = content.replace(/\n$/, '').split('\n');
    const prevSet = previousContent !== undefined ? new Set(previousContent.split('\n')) : null;
    return lines.map((line, index) => ({
      lineNo: index + 1,
      raw: line,
      changed: prevSet !== null && !prevSet.has(line) && line.trim().length > 0,
      tokens: language === 'hcl' ? tokenizeHclLine(line) : null,
    }));
  }, [content, previousContent, language]);

  return (
    <div
      data-testid={testId}
      className="h-full overflow-auto bg-[var(--bg-sunken)] font-mono text-[11px] leading-[18px] text-[var(--text-secondary)]"
    >
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.lineNo}
              data-changed={row.changed ? 'true' : undefined}
              className={row.changed ? 'bg-[rgba(59,130,246,0.08)]' : 'hover:bg-[var(--bg-raised)]'}
            >
              <td
                aria-hidden="true"
                className={`w-10 select-none border-r px-2 text-right tabular-nums ${
                  row.changed
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'border-[var(--border-hairline)] text-[var(--text-muted)]'
                }`}
              >
                {row.lineNo}
              </td>
              <td className="whitespace-pre px-3">
                {row.tokens
                  ? row.tokens.map((tok, idx) => (
                      <span key={idx} className={TONE_CLASS[tok.tone]}>
                        {tok.text}
                      </span>
                    ))
                  : row.raw}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
