/** Browser-safe JSON Schema validation error describing path and constraint failure. */
export interface SchemaValidationError {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateNode(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: SchemaValidationError[],
): void {
  const rawType = schema.type;
  if (typeof rawType === 'string' || Array.isArray(rawType)) {
    const allowed = Array.isArray(rawType) ? rawType : [rawType];
    const matchesAny = allowed.some((expected) => {
      switch (expected) {
        case 'string':
          return typeof value === 'string';
        case 'number':
          return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
          return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
          return typeof value === 'boolean';
        case 'null':
          return value === null;
        case 'array':
          return Array.isArray(value);
        case 'object':
          return isPlainObject(value);
        default:
          return true;
      }
    });
    if (!matchesAny) {
      errors.push({
        path: path || '$',
        message: `Expected type ${allowed.join(' | ')}, received ${
          value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        }`,
      });
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    const found = schema.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    );
    if (!found) {
      errors.push({
        path: path || '$',
        message: `Value must match one of enum values (${schema.enum.map((e) => JSON.stringify(e)).join(', ')})`,
      });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({
        path: path || '$',
        message: `String length ${value.length} is shorter than minLength ${schema.minLength}`,
      });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({
        path: path || '$',
        message: `String length ${value.length} exceeds maxLength ${schema.maxLength}`,
      });
    }
    if (typeof schema.pattern === 'string') {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          errors.push({
            path: path || '$',
            message: `String does not match pattern /${schema.pattern}/`,
          });
        }
      } catch {
        // Ignore invalid regex if user schema wasn't validated separately
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({
        path: path || '$',
        message: `Number ${value} is less than minimum ${schema.minimum}`,
      });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({
        path: path || '$',
        message: `Number ${value} exceeds maximum ${schema.maximum}`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({
        path: path || '$',
        message: `Array length ${value.length} is smaller than minItems ${schema.minItems}`,
      });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({
        path: path || '$',
        message: `Array length ${value.length} exceeds maxItems ${schema.maxItems}`,
      });
    }
    if (isPlainObject(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        validateNode(schema.items, value[i], `${path || '$'}[${i}]`, errors);
      }
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (typeof reqKey === 'string' && !(reqKey in value)) {
          errors.push({
            path: path ? `${path}.${reqKey}` : `$.${reqKey}`,
            message: `Missing required property "${reqKey}"`,
          });
        }
      }
    }

    const props = isPlainObject(schema.properties) ? schema.properties : undefined;
    if (props) {
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in value && isPlainObject(propSchema)) {
          validateNode(propSchema, value[key], path ? `${path}.${key}` : `$.${key}`, errors);
        }
      }
    }

    if (schema.additionalProperties === false && props) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push({
            path: path ? `${path}.${key}` : `$.${key}`,
            message: `Additional property "${key}" is not allowed`,
          });
        }
      }
    }
  }
}

/** Validates whether an object is a supported JSON Schema structure before saving. */
export function validateJsonSchemaDefinition(raw: unknown): SchemaValidationResult {
  if (!isPlainObject(raw)) {
    return {
      valid: false,
      errors: [{ path: '$', message: 'Input schema must be a JSON object' }],
    };
  }
  const errors: SchemaValidationError[] = [];
  if (raw.type !== undefined) {
    const validTypes = new Set([
      'string',
      'number',
      'integer',
      'boolean',
      'null',
      'array',
      'object',
    ]);
    const list = Array.isArray(raw.type) ? raw.type : [raw.type];
    for (const item of list) {
      if (typeof item !== 'string' || !validTypes.has(item)) {
        errors.push({
          path: '$.type',
          message: `Unsupported JSON Schema type "${String(item)}"`,
        });
      }
    }
  }
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== 'string') {
      errors.push({ path: '$.pattern', message: 'Schema pattern must be a string' });
    } else {
      try {
        new RegExp(raw.pattern);
      } catch (err) {
        errors.push({
          path: '$.pattern',
          message: `Invalid regex pattern: ${err instanceof Error ? err.message : 'syntax error'}`,
        });
      }
    }
  }
  if (raw.required !== undefined && !Array.isArray(raw.required)) {
    errors.push({ path: '$.required', message: '"required" must be an array of strings' });
  }
  if (raw.properties !== undefined && !isPlainObject(raw.properties)) {
    errors.push({ path: '$.properties', message: '"properties" must be an object' });
  }
  return { valid: errors.length === 0, errors };
}

/** Validates a sample input value against a JSON Schema subset without dynamic code eval. */
export function validateJsonSchemaValue(
  schema: Record<string, unknown> | undefined,
  value: unknown,
): SchemaValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }
  const errors: SchemaValidationError[] = [];
  validateNode(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}
