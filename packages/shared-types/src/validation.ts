import { Ajv, type ErrorObject } from 'ajv';
import type { Design } from './design.js';
import { designJsonSchema } from './generated/designSchema.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile<Design>(designJsonSchema);

/** Validation result returned when checking a Design payload against the JSON Schema. */
export interface DesignValidationResult {
  valid: boolean;
  errors: string[];
}

function formatAjvError(err: ErrorObject): string {
  const location = err.instancePath || '/';
  return `${location}: ${err.message ?? 'invalid value'}`;
}

/** Validates an unknown payload against the canonical Design JSON Schema. */
export function validateDesign(input: unknown): DesignValidationResult {
  const valid = validateFn(input);
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors = (validateFn.errors ?? []).map(formatAjvError);
  return { valid: false, errors };
}
