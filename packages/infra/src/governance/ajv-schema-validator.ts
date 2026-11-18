/**
 * Ajv adapter for the core SchemaValidator port. Shared by governance, the CLI and the VS Code extension.
 * @module governance/ajv-schema-validator
 */
import type {
  SchemaValidationOutcome,
  SchemaValidator,
} from '@ai-primitives-hub/core';
import Ajv, {
  type ValidateFunction,
} from 'ajv';
import addFormats from 'ajv-formats';

export interface AjvSchemaValidatorOptions {
  /** Ajv strict mode. Off by default to accept the repository's existing schemas. */
  strict?: boolean;
}

export class AjvSchemaValidator implements SchemaValidator {
  private readonly ajv: Ajv;
  private readonly compiled = new WeakMap<object, ValidateFunction>();

  public constructor(options: AjvSchemaValidatorOptions = {}) {
    this.ajv = new Ajv({ allErrors: true, strict: options.strict ?? false });
    addFormats(this.ajv);
    this.ajv.addFormat('semver', /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/);
  }

  public validate(schema: object, data: unknown): SchemaValidationOutcome {
    let validate = this.compiled.get(schema);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.compiled.set(schema, validate);
    }
    const valid = validate(data) === true;
    return {
      valid,
      issues: valid
        ? []
        : (validate.errors ?? []).map((error) => ({
          instancePath: error.instancePath,
          keyword: error.keyword,
          message: error.message ?? 'validation failed',
          params: error.params as Record<string, unknown>
        }))
    };
  }
}
