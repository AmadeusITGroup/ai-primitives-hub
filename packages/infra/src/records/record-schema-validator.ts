/**
 * Schema gate for install records (security layer 3, NFR1.1, BR1.9).
 *
 * Validates a record that already passed `parseRecord` (prototype-free, major
 * version 3) against the shared 3.0.0 schema from core with Ajv draft-07 and
 * `ajv-formats`. Any schema error becomes `RECORD.MALFORMED`; the detail names
 * the failing JSON pointers and rules, never the values found there.
 * @module records/record-schema-validator
 */
import {
  INSTALL_RECORD_SCHEMA,
  type InstallRecord,
  recordError,
  type UnvalidatedRecord,
} from '@ai-primitives-hub/core';
import Ajv, {
  type ErrorObject,
  type ValidateFunction,
} from 'ajv';
import addFormats from 'ajv-formats';

/** Most schema errors named in one `RECORD.MALFORMED` detail. */
const MAX_REPORTED_ERRORS = 3;

const describeError = (error: ErrorObject): string =>
  `${error.instancePath || '/'} ${error.message ?? `fails ${error.keyword}`}`;

/** Validates parsed records against the 3.0.0 install record schema. */
export class RecordSchemaValidator {
  private readonly validateSchema: ValidateFunction;

  public constructor() {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    this.validateSchema = ajv.compile(INSTALL_RECORD_SCHEMA);
  }

  /**
   * Check a parsed record against the schema.
   * @param record - Output of `parseRecord`.
   * @param file - Record file to name in the error, if any.
   * @returns The same object, typed as an `InstallRecord`.
   * @throws {RegistryError} `RECORD.MALFORMED` when the record does not match the schema.
   */
  public validate(record: UnvalidatedRecord, file?: string): InstallRecord {
    if (this.validateSchema(record)) {
      return record as unknown as InstallRecord;
    }
    const errors = this.validateSchema.errors ?? [];
    const shown = errors.slice(0, MAX_REPORTED_ERRORS).map((error) => describeError(error));
    const more = errors.length > MAX_REPORTED_ERRORS ? ` (and ${errors.length - MAX_REPORTED_ERRORS} more)` : '';
    throw recordError('RECORD.MALFORMED', {
      file,
      detail: `schema: ${shown.join('; ')}${more}`
    });
  }
}
