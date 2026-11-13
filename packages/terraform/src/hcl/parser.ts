import type { Design, EdgeInstance, NodeInstance } from '@infrasim/shared-types';
import { classifyTerraformResources } from '../importer/classifier.js';
import type { NormalizedPlanResource } from '../importer/types.js';
import { snakeCaseSlug } from '../naming.js';
import type { HclSyntaxError, HclValidationResult } from './validator.js';
import { validateHclSyntax } from './validator.js';

export interface ParsedHclBlock {
  type: string;
  labels: string[];
  attributes: Record<string, unknown>;
  nestedBlocks: Record<string, ParsedHclBlock[]>;
  line: number;
  column: number;
}

export interface ParsedHclDocument {
  valid: boolean;
  errors: HclSyntaxError[];
  blocks: ParsedHclBlock[];
  attributes: Record<string, unknown>;
}

interface Token {
  kind: 'ident' | 'string' | 'number' | 'punct' | 'newline' | 'eof';
  value: string;
  line: number;
  column: number;
}

function tokenize(source: string, filename: string): { tokens: Token[]; errors: HclSyntaxError[] } {
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

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }

    if (ch === '\n') {
      tokens.push({ kind: 'newline', value: '\n', line, column: col });
      advance();
      continue;
    }

    if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') {
        advance();
      }
      continue;
    }

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

    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      advance();
      let str = '';
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length) {
          str += source[i + 1]!;
          advance(2);
          continue;
        }
        if (source[i] === '"') {
          advance();
          closed = true;
          break;
        }
        if (source[i] === '\n') {
          break;
        }
        str += source[i]!;
        advance();
      }
      if (!closed) {
        errors.push({
          filename,
          line: startLine,
          column: startCol,
          message: 'Unterminated string literal',
        });
      }
      tokens.push({ kind: 'string', value: str, line: startLine, column: startCol });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let num = '';
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        num += source[i]!;
        advance();
      }
      tokens.push({ kind: 'number', value: num, line: startLine, column: startCol });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let ident = '';
      while (i < source.length && /[A-Za-z0-9_.-]/.test(source[i]!)) {
        ident += source[i]!;
        advance();
      }
      tokens.push({ kind: 'ident', value: ident, line: startLine, column: startCol });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (['=>', '==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
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

/** Parses full HCL document into structured blocks and attributes. */
export function parseHclDocument(source: string, filename = 'main.tf'): ParsedHclDocument {
  // First run the syntax validator to catch structural defects cleanly
  const validation: HclValidationResult = validateHclSyntax(source, filename);
  if (!validation.valid || validation.errors.length > 0) {
    return {
      valid: false,
      errors: validation.errors,
      blocks: [],
      attributes: {},
    };
  }

  const { tokens, errors } = tokenize(source, filename);
  if (errors.length > 0) {
    return { valid: false, errors, blocks: [], attributes: {} };
  }

  let pos = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const skipNewlines = () => {
    while (peek().kind === 'newline') next();
  };

  function parseExpr(): unknown {
    skipNewlines();
    const tok = next();
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'number') return Number(tok.value);
    if (tok.kind === 'ident') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return tok.value;
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const list: unknown[] = [];
      skipNewlines();
      while (peek().kind !== 'eof' && !(peek().kind === 'punct' && peek().value === ']')) {
        list.push(parseExpr());
        skipNewlines();
        if (peek().kind === 'punct' && peek().value === ',') {
          next();
          skipNewlines();
        }
      }
      if (peek().kind === 'punct' && peek().value === ']') next();
      return list;
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const map: Record<string, unknown> = {};
      skipNewlines();
      while (peek().kind !== 'eof' && !(peek().kind === 'punct' && peek().value === '}')) {
        const keyTok = next();
        const key = keyTok.value;
        skipNewlines();
        if (peek().kind === 'punct' && (peek().value === '=' || peek().value === ':')) {
          next();
        }
        skipNewlines();
        map[key] = parseExpr();
        skipNewlines();
        if (peek().kind === 'punct' && peek().value === ',') {
          next();
          skipNewlines();
        }
      }
      if (peek().kind === 'punct' && peek().value === '}') next();
      return map;
    }
    return tok.value;
  }

  function parseBlock(): ParsedHclBlock | null {
    const ident = next();
    const type = ident.value;
    const labels: string[] = [];
    while (peek().kind === 'ident' || peek().kind === 'string') {
      labels.push(next().value);
    }
    skipNewlines();
    if (peek().kind !== 'punct' || peek().value !== '{') {
      return null;
    }
    next(); // consume '{'

    const attributes: Record<string, unknown> = {};
    const nestedBlocks: Record<string, ParsedHclBlock[]> = {};

    while (peek().kind !== 'eof') {
      skipNewlines();
      if (peek().kind === 'punct' && peek().value === '}') {
        next(); // consume '}'
        break;
      }
      const itemIdent = peek();
      if (itemIdent.kind !== 'ident') {
        next();
        continue;
      }

      // Check if attribute or nested block
      const curPos = pos;
      next(); // consume identifier
      skipNewlines();
      if (peek().kind === 'punct' && peek().value === '=') {
        next(); // consume '='
        attributes[itemIdent.value] = parseExpr();
      } else {
        // Rewind and parse nested block
        pos = curPos;
        const childBlock = parseBlock();
        if (childBlock) {
          if (!nestedBlocks[childBlock.type]) {
            nestedBlocks[childBlock.type] = [];
          }
          nestedBlocks[childBlock.type]!.push(childBlock);
        } else {
          next();
        }
      }
    }

    return {
      type,
      labels,
      attributes,
      nestedBlocks,
      line: ident.line,
      column: ident.column,
    };
  }

  const blocks: ParsedHclBlock[] = [];
  const rootAttributes: Record<string, unknown> = {};

  while (peek().kind !== 'eof') {
    skipNewlines();
    if (peek().kind === 'eof') break;
    const first = peek();
    if (first.kind === 'ident') {
      const curPos = pos;
      next();
      skipNewlines();
      if (peek().kind === 'punct' && peek().value === '=') {
        next();
        rootAttributes[first.value] = parseExpr();
      } else {
        pos = curPos;
        const b = parseBlock();
        if (b) blocks.push(b);
        else next();
      }
    } else {
      next();
    }
  }

  return {
    valid: true,
    errors: [],
    blocks,
    attributes: rootAttributes,
  };
}

/** Extracts normalized plan resources from an HCL string for classification. */
export function extractResourcesFromHcl(
  source: string,
  filename = 'main.tf',
): {
  valid: boolean;
  errors: HclSyntaxError[];
  resources: NormalizedPlanResource[];
} {
  const doc = parseHclDocument(source, filename);
  if (!doc.valid || doc.errors.length > 0) {
    return { valid: false, errors: doc.errors, resources: [] };
  }

  const resources: NormalizedPlanResource[] = [];
  for (const b of doc.blocks) {
    if (b.type === 'resource' && b.labels.length >= 2) {
      const type = b.labels[0]!;
      const name = b.labels[1]!;
      const provider = type.startsWith('aws_')
        ? 'registry.terraform.io/hashicorp/aws'
        : type.startsWith('google_')
          ? 'registry.terraform.io/hashicorp/google'
          : type.startsWith('azurerm_')
            ? 'registry.terraform.io/hashicorp/azurerm'
            : 'registry.terraform.io/oracle/oci';

      // Flatten nested blocks like default_action or tags
      const values: Record<string, unknown> = { ...b.attributes };
      for (const [nbType, nbList] of Object.entries(b.nestedBlocks)) {
        if (nbList.length === 1 && Object.keys(nbList[0]!.attributes).length > 0) {
          values[nbType] = nbList[0]!.attributes;
        } else {
          values[nbType] = nbList.map((nb) => ({ ...nb.attributes }));
        }
      }

      resources.push({
        address: `${type}.${name}`,
        baseAddress: `${type}.${name}`,
        moduleAddress: '',
        mode: 'managed',
        type,
        name,
        providerName: provider,
        values,
        referencesByAttr: {},
        allReferences: [],
      });
    }
  }

  return { valid: true, errors: [], resources };
}

/**
 * Bi-directional sync: Applies user edits from Terraform HCL to the canvas Design.
 * If there are syntax or parsing errors, the Design is NOT modified, and errors are returned.
 */
export function syncTerraformHclToDesign(
  currentDesign: Design,
  hclSource: string,
  filename = 'compute.tf',
): {
  design: Design;
  changed: boolean;
  errors: HclSyntaxError[];
  summary?: string;
} {
  const { valid, errors, resources } = extractResourcesFromHcl(hclSource, filename);

  if (!valid || errors.length > 0) {
    return {
      design: currentDesign,
      changed: false,
      errors,
      summary: errors[0]?.message ?? 'Terraform syntax error',
    };
  }

  // If no resource blocks are in this file (e.g. providers.tf or outputs.tf), return unchanged
  if (resources.length === 0) {
    return {
      design: currentDesign,
      changed: false,
      errors: [],
      summary: 'No resource definitions in file',
    };
  }

  const classified = classifyTerraformResources(resources);
  let changed = false;
  const nextNodes: NodeInstance[] = currentDesign.nodes.map((node) => ({ ...node }));
  const existingNodeIds = new Set(nextNodes.map((n) => n.id));
  const existingNodeSlugs = new Map(nextNodes.map((n) => [snakeCaseSlug(n.label), n]));
  const existingNodeIdMap = new Map(nextNodes.map((n) => [n.id, n]));

  // Match classified resources to existing nodes or add new ones
  for (const cr of classified) {
    const resName = cr.resource.name;
    // 1. Direct ID match
    let match = existingNodeIdMap.get(resName);
    if (!match) {
      // 2. Direct name match (e.g. 'api_server' -> 'api' or 'api_server')
      const targetSlug = resName.replace(/_/g, '-');
      match = nextNodes.find((n) => n.id === targetSlug || snakeCaseSlug(n.id) === resName);
    }
    if (!match) {
      // 3. Label match
      match = existingNodeSlugs.get(snakeCaseSlug(cr.label));
    }
    if (
      !match &&
      classified.length === 1 &&
      nextNodes.length === 1 &&
      cr.serviceId === nextNodes[0]?.serviceId
    ) {
      // Single node fallback only when service matches
      match = nextNodes[0];
    }

    if (match) {
      // Update label if changed
      if (cr.label && cr.label !== match.label) {
        match.label = cr.label;
        changed = true;
      }
      // Update config properties if present
      if (cr.nodeConfig) {
        if (
          cr.nodeConfig.instanceType &&
          match.config.instanceType !== cr.nodeConfig.instanceType
        ) {
          match.config = { ...match.config, instanceType: cr.nodeConfig.instanceType };
          changed = true;
        }
        if (cr.nodeConfig.instances && match.config.instances !== cr.nodeConfig.instances) {
          match.config = { ...match.config, instances: cr.nodeConfig.instances };
          changed = true;
        }
        if (cr.nodeConfig.vcpu && match.config.vcpu !== cr.nodeConfig.vcpu) {
          match.config = { ...match.config, vcpu: cr.nodeConfig.vcpu };
          changed = true;
        }
        if (cr.nodeConfig.memoryGb && match.config.memoryGb !== cr.nodeConfig.memoryGb) {
          match.config = { ...match.config, memoryGb: cr.nodeConfig.memoryGb };
          changed = true;
        }
      }
    } else {
      // New resource defined in HCL! Add as new node on canvas
      const newId = resName.replace(/_/g, '-');
      if (!existingNodeIds.has(newId)) {
        const xOffset = 180 + (nextNodes.length % 4) * 220;
        const yOffset = 160 + Math.floor(nextNodes.length / 4) * 160;
        const newNode: NodeInstance = {
          id: newId,
          serviceId: cr.serviceId ?? 'aws.ec2',
          label: cr.label,
          position: { x: xOffset, y: yOffset },
          config: cr.nodeConfig ?? { instances: 1, operations: {} },
        };
        nextNodes.push(newNode);
        existingNodeIds.add(newId);
        changed = true;
      }
    }
  }

  // Infer new edges if references exist in resource attributes
  const nextEdges: EdgeInstance[] = [...currentDesign.edges];
  for (const res of resources) {
    const fromId = res.name.replace(/_/g, '-');
    const valuesStr = JSON.stringify(res.values);
    for (const node of nextNodes) {
      if (node.id === fromId) continue;
      const targetSlug = snakeCaseSlug(node.id);
      const targetName = node.id.replace(/-/g, '_');
      if (
        (valuesStr.includes(`.${targetSlug}.`) ||
          valuesStr.includes(`.${targetName}.`) ||
          valuesStr.includes(`"${targetSlug}"`) ||
          valuesStr.includes(`"${targetName}"`)) &&
        !nextEdges.some((e) => e.from === fromId && e.to === node.id)
      ) {
        nextEdges.push({
          id: `edge-${fromId}-${node.id}`,
          from: fromId,
          to: node.id,
          protocol: 'http',
          callType: 'sync',
          weight: 1,
        });
        changed = true;
      }
    }
  }

  if (!changed) {
    return { design: currentDesign, changed: false, errors: [] };
  }

  return {
    design: {
      ...currentDesign,
      nodes: nextNodes,
      edges: nextEdges,
    },
    changed: true,
    errors: [],
    summary: `Synchronized ${classified.length} Terraform resource(s) to canvas`,
  };
}
