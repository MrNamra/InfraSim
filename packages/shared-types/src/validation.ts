import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { Design } from './design.js';
import { designJsonSchema } from './generated/designSchema.js';

let cachedValidateFn: ValidateFunction<Design> | null = null;

function getValidateFn(): ValidateFunction<Design> {
  if (!cachedValidateFn) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidateFn = ajv.compile<Design>(designJsonSchema);
  }
  return cachedValidateFn;
}

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
  const validateFn = getValidateFn();
  const valid = validateFn(input);
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors = (validateFn.errors ?? []).map(formatAjvError);
  return { valid: false, errors };
}
