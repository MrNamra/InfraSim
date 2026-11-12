import type { HclAttribute, HclBlock, HclExpr, HclFileAst, HclStatement } from '../types.js';

/** Creates an HCL literal expression (string, number, boolean, or null). */
export function hclLit(value: string | number | boolean | null): HclExpr {
  return { kind: 'literal', value };
}

/** Creates an unquoted Terraform reference expression (e.g., `aws_vpc.main.id`). */
export function hclRef(path: string): HclExpr {
  return { kind: 'ref', path };
}

/** Creates an HCL list expression. */
export function hclList(items: HclExpr[]): HclExpr {
  return { kind: 'list', items };
}

/** Creates an HCL map/object expression preserving deterministic key order. */
export function hclMap(entries: Array<[string, HclExpr]>): HclExpr {
  return {
    kind: 'map',
    entries: entries.map(([key, value]) => ({ key, value })),
  };
}

/** Creates a raw HCL expression (such as `jsonencode(...)` or interpolated string). */
export function hclRaw(code: string): HclExpr {
  return { kind: 'raw', code };
}

/** Creates an HCL attribute. */
export function hclAttr(key: string, value: HclExpr, comment?: string): HclAttribute {
  return comment !== undefined ? { key, value, comment } : { key, value };
}

/** Creates an HCL block. */
export function hclBlock(
  type: string,
  options?: {
    labels?: string[];
    comments?: string[];
    attributes?: HclAttribute[];
    blocks?: HclBlock[];
  },
): HclBlock {
  return {
    type,
    ...(options?.labels ? { labels: options.labels } : {}),
    ...(options?.comments ? { comments: options.comments } : {}),
    ...(options?.attributes ? { attributes: options.attributes } : {}),
    ...(options?.blocks ? { blocks: options.blocks } : {}),
  };
}

/** Wraps a block in an HCL file statement. */
export function hclBlockStmt(block: HclBlock): HclStatement {
  return { kind: 'block', block };
}

/** Wraps a standalone comment in an HCL file statement. */
export function hclCommentStmt(text: string): HclStatement {
  return { kind: 'comment', text };
}

/** Creates an HCL file AST container. */
export function hclFile(
  filename: string,
  statements: HclStatement[],
  headerComments?: string[],
): HclFileAst {
  return {
    filename,
    ...(headerComments ? { headerComments } : {}),
    statements,
  };
}
