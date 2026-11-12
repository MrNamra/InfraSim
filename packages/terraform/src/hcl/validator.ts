export interface HclSyntaxError {
  filename: string;
  line: number;
  column: number;
  message: string;
}

export interface HclValidationResult {
  valid: boolean;
  blockCount: number;
  errors: HclSyntaxError[];
}

interface Token {
  kind: 'ident' | 'string' | 'number' | 'punct' | 'newline' | 'eof';
  value: string;
  line: number;
  column: number;
}

function tokenizeHcl(
  source: string,
  filename: string,
): { tokens: Token[]; errors: HclSyntaxError[] } {
  const tokens: Token[] = [];
  const errors: HclSyntaxError[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (count = 1) => {
    for (let k = 0; k < count; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;

    // Horizontal whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }

    // Newline
    if (ch === '\n') {
      tokens.push({ kind: 'newline', value: '\n', line, column: col });
      advance();
      continue;
    }

    // Single-line # or // comment
    if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') {
        advance();
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      advance(2);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        advance();
      }
      if (i >= source.length) {
        errors.push({
          filename,
          line: startLine,
          column: startCol,
          message: 'Unterminated block comment /* ... */',
        });
        break;
      }
      advance(2);
      continue;
    }

    // Heredoc <<EOF or <<-EOF
    if (ch === '<' && source[i + 1] === '<') {
      const startLine = line;
      const startCol = col;
      advance(2);
      if (source[i] === '-') advance();
      let marker = '';
      while (i < source.length && /[A-Za-z0-9_-]/.test(source[i]!)) {
        marker += source[i]!;
        advance();
      }
      if (!marker) {
        errors.push({
          filename,
          line: startLine,
          column: startCol,
          message: 'Invalid heredoc delimiter',
        });
        continue;
      }
      while (i < source.length && source[i] !== '\n') advance();
      if (i < source.length) advance();
      let closed = false;
      while (i < source.length) {
        let row = '';
        while (i < source.length && source[i] !== '\n') {
          row += source[i]!;
          advance();
        }
        if (row.trim() === marker) {
          closed = true;
          break;
        }
        if (i < source.length && source[i] === '\n') advance();
      }
      if (!closed) {
        errors.push({
          filename,
          line: startLine,
          column: startCol,
          message: `Unterminated heredoc <<${marker}`,
        });
      } else {
        tokens.push({ kind: 'string', value: marker, line: startLine, column: startCol });
      }
      continue;
    }

    // Quoted string with nested ${ ... } interpolation brace tracking
    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      advance();
      let value = '';
      let interpDepth = 0;
      let closed = false;
      while (i < source.length) {
        const cur = source[i]!;
        if (cur === '\\') {
          if (i + 1 < source.length) {
            value += cur + source[i + 1]!;
            advance(2);
            continue;
          }
          break;
        }
        if (cur === '\n' && interpDepth === 0) {
          break;
        }
        if (cur === '$' && source[i + 1] === '{') {
          interpDepth++;
          value += '${';
          advance(2);
          continue;
        }
        if (interpDepth > 0) {
          if (cur === '{') interpDepth++;
          else if (cur === '}') interpDepth--;
          value += cur;
          advance();
          continue;
        }
        if (cur === '"') {
          advance();
          closed = true;
          break;
        }
        value += cur;
        advance();
      }
      if (!closed) {
        errors.push({
          filename,
          line: startLine,
          column: startCol,
          message: 'Unterminated string literal',
        });
      } else {
        tokens.push({ kind: 'string', value, line: startLine, column: startCol });
      }
      continue;
    }

    // Number
    if (/[0-9]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let num = '';
      while (i < source.length && /[0-9._eE+-]/.test(source[i]!)) {
        if ((source[i] === '+' || source[i] === '-') && !/[eE]/.test(num[num.length - 1] ?? '')) {
          break;
        }
        num += source[i]!;
        advance();
      }
      tokens.push({ kind: 'number', value: num, line: startLine, column: startCol });
      continue;
    }

    // Identifier
    if (/[A-Za-z_]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let ident = '';
      while (i < source.length && /[A-Za-z0-9_-]/.test(source[i]!)) {
        ident += source[i]!;
        advance();
      }
      tokens.push({ kind: 'ident', value: ident, line: startLine, column: startCol });
      continue;
    }

    // Multi-char operators or single-char punctuation
    const two = source.slice(i, i + 2);
    if (
      two === '=>' ||
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||'
    ) {
      tokens.push({ kind: 'punct', value: two, line, column: col });
      advance(2);
      continue;
    }
    if ('{}[]()=.,:?+-*/%!<>'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line, column: col });
      advance();
      continue;
    }

    errors.push({
      filename,
      line,
      column: col,
      message: `Unexpected character '${ch}'`,
    });
    advance();
  }

  tokens.push({ kind: 'eof', value: '', line, column: col });
  return { tokens, errors };
}

/**
 * Parses and validates HCL2 syntax structurally (top-level blocks, nested blocks, attributes,
 * maps, lists, expressions, strings, and balanced delimiters) without calling Terraform CLI.
 */
export function validateHclSyntax(source: string, filename = 'main.tf'): HclValidationResult {
  const { tokens, errors } = tokenizeHcl(source, filename);
  let pos = 0;
  let blockCount = 0;

  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const skipNewlines = () => {
    while (peek().kind === 'newline') {
      next();
    }
  };

  function parseExpression(): boolean {
    const first = peek();
    if (
      first.kind === 'eof' ||
      first.kind === 'newline' ||
      (first.kind === 'punct' && first.value === '}')
    ) {
      errors.push({
        filename,
        line: first.line,
        column: first.column,
        message: 'Expected expression value',
      });
      return false;
    }

    // Support prefix unary ! or -
    if (first.kind === 'punct' && (first.value === '!' || first.value === '-')) {
      next();
      return parseExpression();
    }

    const tok = next();
    if (tok.kind === 'punct' && tok.value === '[') {
      skipNewlines();
      while (peek().kind !== 'eof' && !(peek().kind === 'punct' && peek().value === ']')) {
        if (!parseExpression()) return false;
        skipNewlines();
        if (peek().kind === 'punct' && peek().value === ',') {
          next();
          skipNewlines();
        }
      }
      if (peek().kind !== 'punct' || peek().value !== ']') {
        errors.push({
          filename,
          line: tok.line,
          column: tok.column,
          message: 'Unclosed list literal `[`',
        });
        return false;
      }
      next();
    } else if (tok.kind === 'punct' && tok.value === '{') {
      skipNewlines();
      while (peek().kind !== 'eof' && !(peek().kind === 'punct' && peek().value === '}')) {
        const keyTok = peek();
        if (keyTok.kind !== 'ident' && keyTok.kind !== 'string') {
          errors.push({
            filename,
            line: keyTok.line,
            column: keyTok.column,
            message: `Expected map key, got '${keyTok.value || keyTok.kind}'`,
          });
          return false;
        }
        next();
        const sep = peek();
        if (sep.kind !== 'punct' || (sep.value !== '=' && sep.value !== ':')) {
          errors.push({
            filename,
            line: sep.line,
            column: sep.column,
            message: `Expected '=' after map key '${keyTok.value}'`,
          });
          return false;
        }
        next();
        if (!parseExpression()) return false;
        if (peek().kind === 'punct' && peek().value === ',') {
          next();
        }
        skipNewlines();
      }
      if (peek().kind !== 'punct' || peek().value !== '}') {
        errors.push({
          filename,
          line: tok.line,
          column: tok.column,
          message: 'Unclosed map literal `{`',
        });
        return false;
      }
      next();
    } else if (tok.kind === 'punct' && tok.value === '(') {
      if (!parseExpression()) return false;
      if (peek().kind !== 'punct' || peek().value !== ')') {
        errors.push({
          filename,
          line: tok.line,
          column: tok.column,
          message: 'Unclosed parenthesized expression `(`',
        });
        return false;
      }
      next();
    } else if (tok.kind !== 'ident' && tok.kind !== 'string' && tok.kind !== 'number') {
      errors.push({
        filename,
        line: tok.line,
        column: tok.column,
        message: `Unexpected token '${tok.value}' in expression`,
      });
      return false;
    }

    // Postfix chains: .field, [index], (args), binary operators
    while (true) {
      const p = peek();
      if (p.kind === 'punct' && p.value === '.') {
        next();
        const member = peek();
        if (
          member.kind !== 'ident' &&
          member.kind !== 'number' &&
          !(member.kind === 'punct' && member.value === '*')
        ) {
          errors.push({
            filename,
            line: member.line,
            column: member.column,
            message: 'Expected attribute name after `.`',
          });
          return false;
        }
        next();
        continue;
      }
      if (p.kind === 'punct' && p.value === '[') {
        next();
        if (peek().kind !== 'punct' || peek().value !== ']') {
          if (!parseExpression()) return false;
        }
        if (peek().kind !== 'punct' || peek().value !== ']') {
          errors.push({
            filename,
            line: p.line,
            column: p.column,
            message: 'Unclosed index operator `[`',
          });
          return false;
        }
        next();
        continue;
      }
      if (p.kind === 'punct' && p.value === '(') {
        next();
        skipNewlines();
        while (peek().kind !== 'eof' && !(peek().kind === 'punct' && peek().value === ')')) {
          if (!parseExpression()) return false;
          skipNewlines();
          if (peek().kind === 'punct' && peek().value === ',') {
            next();
            skipNewlines();
          }
        }
        if (peek().kind !== 'punct' || peek().value !== ')') {
          errors.push({
            filename,
            line: p.line,
            column: p.column,
            message: 'Unclosed function call `(`',
          });
          return false;
        }
        next();
        continue;
      }
      if (
        p.kind === 'punct' &&
        ['+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '?'].includes(
          p.value,
        )
      ) {
        const op = next();
        if (!parseExpression()) return false;
        if (op.value === '?') {
          if (peek().kind !== 'punct' || peek().value !== ':') {
            errors.push({
              filename,
              line: op.line,
              column: op.column,
              message: 'Expected `:` in conditional expression',
            });
            return false;
          }
          next();
          if (!parseExpression()) return false;
        }
        continue;
      }
      break;
    }

    return true;
  }

  function parseBlockBody(): boolean {
    while (true) {
      skipNewlines();
      const cur = peek();
      if (cur.kind === 'eof') {
        errors.push({
          filename,
          line: cur.line,
          column: cur.column,
          message: 'Unexpected end of file inside block (missing `}`)',
        });
        return false;
      }
      if (cur.kind === 'punct' && cur.value === '}') {
        next();
        return true;
      }
      if (!parseBodyItem()) {
        return false;
      }
    }
  }

  function parseBodyItem(): boolean {
    const first = peek();
    if (first.kind !== 'ident') {
      errors.push({
        filename,
        line: first.line,
        column: first.column,
        message: `Expected block or attribute identifier, got '${first.value || first.kind}'`,
      });
      next();
      return false;
    }
    next();

    const after = peek();
    if (after.kind === 'punct' && after.value === '=') {
      next();
      if (!parseExpression()) return false;
      if (
        peek().kind !== 'newline' &&
        peek().kind !== 'eof' &&
        !(peek().kind === 'punct' && peek().value === '}')
      ) {
        const bad = peek();
        errors.push({
          filename,
          line: bad.line,
          column: bad.column,
          message: `Unexpected trailing token '${bad.value}' after attribute assignment`,
        });
        return false;
      }
      return true;
    }

    // Block labels followed by `{`
    while (peek().kind === 'ident' || peek().kind === 'string') {
      next();
    }
    if (peek().kind !== 'punct' || peek().value !== '{') {
      const bad = peek();
      errors.push({
        filename,
        line: bad.line,
        column: bad.column,
        message: `Expected '=' or '{' after '${first.value}'`,
      });
      return false;
    }
    next();
    blockCount++;
    return parseBlockBody();
  }

  while (true) {
    skipNewlines();
    if (peek().kind === 'eof') break;
    if (!parseBodyItem()) {
      // Advance to next newline to collect further diagnostics cleanly without spinning
      while (peek().kind !== 'newline' && peek().kind !== 'eof') {
        next();
      }
    }
  }

  return {
    valid: errors.length === 0,
    blockCount,
    errors,
  };
}
