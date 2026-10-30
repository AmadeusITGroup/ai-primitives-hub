/**
 * JSON Schema validation behind a port, so core and delivery layers share one validator.
 * @module ports/schema-validator
 */

export interface SchemaValidationIssue {
  /** JSON Pointer to the offending value; empty for the root. */
  instancePath: string;
  /** Schema keyword that failed, for example `required` or `pattern`. */
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface SchemaValidationOutcome {
  valid: boolean;
  issues: SchemaValidationIssue[];
}

export interface SchemaValidator {
  /**
   * Validate data against a JSON Schema object. Implementations cache compiled schemas by identity.
   * @param schema JSON Schema document.
   * @param data Value to validate.
   */
  validate(schema: object, data: unknown): SchemaValidationOutcome;
}
