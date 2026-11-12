import type { Provider } from '@infrasim/shared-types';

/** Maximum accepted size for client-side Terraform plan/state JSON imports (5 MB). */
export const TERRAFORM_MAX_INPUT_BYTES = 5 * 1024 * 1024;

/** Maximum execution time budget for client-side Terraform import parsing (10 s). */
export const TERRAFORM_IMPORT_TIMEOUT_MS = 10_000;

/** HCL expression AST node rendered deterministically by the HCL printer. */
export type HclExpr =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ref'; path: string }
  | { kind: 'list'; items: HclExpr[] }
  | { kind: 'map'; entries: Array<{ key: string; value: HclExpr }> }
  | { kind: 'raw'; code: string };

/** Key-value attribute inside an HCL block. */
export interface HclAttribute {
  key: string;
  value: HclExpr;
  comment?: string;
}

/** Nested or top-level HCL block (`terraform`, `provider`, `resource`, `variable`, etc.). */
export interface HclBlock {
  type: string;
  labels?: string[];
  comments?: string[];
  attributes?: HclAttribute[];
  blocks?: HclBlock[];
}

/** Top-level statement inside an HCL file. */
export type HclStatement = { kind: 'comment'; text: string } | { kind: 'block'; block: HclBlock };

/** Virtual `.tf` file AST ready for deterministic formatting. */
export interface HclFileAst {
  filename: string;
  headerComments?: string[];
  statements: HclStatement[];
}

/** Options controlling Terraform HCL generation from an InfraSim Design. */
export interface TerraformExportOptions {
  /** Subset of cloud providers to export; defaults to all cloud providers present in the design. */
  providers?: Provider[];
  /** Prefix used in resource names and tags. Defaults to sanitized `design.name`. */
  namePrefix?: string;
  /** Default region per provider (falls back to node/group region or standard provider default). */
  regions?: Partial<Record<'aws' | 'gcp' | 'azure' | 'oci', string>>;
  /** Include educational explanatory comments above blocks. Defaults to `true`. */
  includeComments?: boolean;
}

/** Generated Terraform artifact file. */
export interface TerraformGeneratedFile {
  filename: string;
  content: string;
  language: 'hcl' | 'markdown';
}

/** Unsupported node record surfaced in comments, README, and UI warnings. */
export interface UnsupportedNodeNotice {
  nodeId: string;
  serviceId: string;
  label: string;
  reason: string;
}

/** Complete deterministic result of exporting a Design to Terraform HCL. */
export interface TerraformExportResult {
  files: TerraformGeneratedFile[];
  providersIncluded: Array<'aws' | 'gcp' | 'azure' | 'oci'>;
  resourceCount: number;
  unsupportedNodes: UnsupportedNodeNotice[];
  warnings: string[];
  /** Machine-readable mapping from InfraSim node/group ID to emitted Terraform resource addresses. */
  resourceAddresses: Record<string, string[]>;
}
