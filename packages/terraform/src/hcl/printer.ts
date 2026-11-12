import type { HclAttribute, HclBlock, HclExpr, HclFileAst } from '../types.js';

function escapeHclString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
}

function isSimpleIdent(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key);
}

function formatMapKey(key: string): string {
  return isSimpleIdent(key) ? key : `"${escapeHclString(key)}"`;
}

/** Formats an HCL expression AST node with optional multiline indentation. */
export function formatHclExpr(expr: HclExpr, indentLevel = 0): string {
  const indent = '  '.repeat(indentLevel);
  const childIndent = '  '.repeat(indentLevel + 1);

  switch (expr.kind) {
    case 'literal': {
      if (expr.value === null) return 'null';
      if (typeof expr.value === 'boolean' || typeof expr.value === 'number') {
        return String(expr.value);
      }
      return `"${escapeHclString(expr.value)}"`;
    }
    case 'ref':
      return expr.path;
    case 'raw':
      return expr.code;
    case 'list': {
      if (expr.items.length === 0) return '[]';
      const formatted = expr.items.map((item) => formatHclExpr(item, indentLevel + 1));
      const inline = `[${formatted.join(', ')}]`;
      if (!inline.includes('\n') && inline.length <= 72) {
        return inline;
      }
      return `[\n${formatted.map((item) => `${childIndent}${item},`).join('\n')}\n${indent}]`;
    }
    case 'map': {
      if (expr.entries.length === 0) return '{}';
      if (expr.entries.length === 1) {
        const entry = expr.entries[0]!;
        const vStr = formatHclExpr(entry.value, indentLevel + 1);
        const inline = `{ ${formatMapKey(entry.key)} = ${vStr} }`;
        if (!inline.includes('\n') && inline.length <= 72) {
          return inline;
        }
      }
      const keyWidths = expr.entries.map((e) => formatMapKey(e.key).length);
      const maxKeyLen = Math.max(0, ...keyWidths);
      const lines = expr.entries.map((entry) => {
        const keyStr = formatMapKey(entry.key).padEnd(maxKeyLen, ' ');
        const valStr = formatHclExpr(entry.value, indentLevel + 1);
        return `${childIndent}${keyStr} = ${valStr}`;
      });
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
  }
}

function formatAttributesAligned(attrs: readonly HclAttribute[], indentLevel: number): string[] {
  if (attrs.length === 0) return [];
  const indent = '  '.repeat(indentLevel);
  const maxKeyLen = Math.max(...attrs.map((a) => a.key.length));
  const out: string[] = [];
  for (const attr of attrs) {
    if (attr.comment) {
      for (const line of attr.comment.split('\n')) {
        out.push(`${indent}# ${line}`);
      }
    }
    const paddedKey = attr.key.padEnd(maxKeyLen, ' ');
    out.push(`${indent}${paddedKey} = ${formatHclExpr(attr.value, indentLevel)}`);
  }
  return out;
}

/** Prints a single HCL block with 2-space indentation and `=` alignment. */
export function printHclBlock(block: HclBlock, indentLevel = 0): string {
  const indent = '  '.repeat(indentLevel);
  const lines: string[] = [];

  if (block.comments) {
    for (const comment of block.comments) {
      for (const line of comment.split('\n')) {
        lines.push(`${indent}# ${line}`);
      }
    }
  }

  const labelTokens = (block.labels ?? []).map((lbl) => `"${escapeHclString(lbl)}"`);
  const header = [block.type, ...labelTokens].join(' ');

  const hasAttrs = Boolean(block.attributes && block.attributes.length > 0);
  const hasBlocks = Boolean(block.blocks && block.blocks.length > 0);

  if (!hasAttrs && !hasBlocks) {
    lines.push(`${indent}${header} {}`);
    return lines.join('\n');
  }

  lines.push(`${indent}${header} {`);
  if (block.attributes && block.attributes.length > 0) {
    lines.push(...formatAttributesAligned(block.attributes, indentLevel + 1));
  }
  if (block.blocks && block.blocks.length > 0) {
    if (hasAttrs) {
      lines.push('');
    }
    block.blocks.forEach((child, idx) => {
      if (idx > 0) {
        lines.push('');
      }
      lines.push(printHclBlock(child, indentLevel + 1));
    });
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

/** Prints a complete HCL file AST deterministically in canonical `terraform fmt` style. */
export function printHclFile(file: HclFileAst): string {
  const chunks: string[] = [];

  if (file.headerComments && file.headerComments.length > 0) {
    chunks.push(file.headerComments.map((c) => `# ${c}`).join('\n'));
  }

  for (const stmt of file.statements) {
    if (stmt.kind === 'comment') {
      const commentLines = stmt.text
        .split('\n')
        .map((line) => (line.startsWith('#') ? line : `# ${line}`));
      chunks.push(commentLines.join('\n'));
    } else {
      chunks.push(printHclBlock(stmt.block, 0));
    }
  }

  return chunks.join('\n\n') + '\n';
}
