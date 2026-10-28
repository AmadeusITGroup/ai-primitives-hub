/**
 * Install record error codes (contract C6) and the `recordError` helper.
 *
 * Record failures are ordinary `RegistryError`s in the `RECORD` namespace —
 * no new error class — so the CLI reports them through its usual handled-error
 * path (exit code 1) and the extension shows them like any other domain error
 * (BR4.2). The file path and detail travel in `context`, which reaches JSON
 * output. Messages never include file contents.
 * @module domain/install/record-errors
 */
import {
  RegistryError,
} from '../registry-error';

/** Stable `RECORD.*` codes. New codes may be added; none are renamed or removed. */
export const RECORD_ERROR_CODES = [
  'RECORD.MALFORMED',
  'RECORD.NEWER_FORMAT',
  'RECORD.PATH_OUTSIDE_ROOT',
  'RECORD.LEGACY_UNMIGRATED',
  'RECORD.UNKNOWN_TOOL',
  'RECORD.WRITE_FAILED',
  'RECORD.CLI_MANAGED',
  'RECORD.ENTRY_NOT_FOUND'
] as const;

/** One of the {@link RECORD_ERROR_CODES}. */
export type RecordErrorCode = typeof RECORD_ERROR_CODES[number];

/** Details attached to a record error. */
export interface RecordErrorDetails {
  /** Record or installed file the error is about, relative to the root where possible. */
  file?: string;
  /** Short reason, e.g. `forbidden key __proto__`; never file contents. */
  detail?: string;
  /** What the user can do next; defaults to a per-code hint. */
  hint?: string;
  /** Overrides the default per-code message. */
  message?: string;
  /** Underlying error, kept for logs (not serialized). */
  cause?: unknown;
  /** Extra context fields, merged after `file` and `detail`. */
  context?: Record<string, unknown>;
}

const DEFAULT_MESSAGES: Readonly<Record<RecordErrorCode, string>> = {
  'RECORD.MALFORMED': 'The install record is malformed and was left unchanged.',
  'RECORD.NEWER_FORMAT': 'The install record was written by a newer release and was left unchanged.',
  'RECORD.PATH_OUTSIDE_ROOT': 'The install record lists a path outside the repository; nothing was written or deleted.',
  'RECORD.LEGACY_UNMIGRATED': 'The install record uses an older format that this release cannot migrate yet.',
  'RECORD.UNKNOWN_TOOL': 'The tool is not a known install target.',
  'RECORD.WRITE_FAILED': 'The install record could not be written; the previous file was left intact.',
  'RECORD.CLI_MANAGED': 'This bundle was installed with the ai-primitives-hub CLI.',
  'RECORD.ENTRY_NOT_FOUND': 'The install record has no entry for this bundle and tool; nothing was removed.'
};

const DEFAULT_HINTS: Readonly<Record<RecordErrorCode, string>> = {
  'RECORD.MALFORMED': 'Fix or remove the file, then run the command again.',
  'RECORD.NEWER_FORMAT': 'Upgrade ai-primitives-hub to a release that reads this record format.',
  'RECORD.PATH_OUTSIDE_ROOT': 'Remove the offending entry from the record, then run the command again.',
  'RECORD.LEGACY_UNMIGRATED': 'Upgrade ai-primitives-hub to a release that migrates older records.',
  'RECORD.UNKNOWN_TOOL': 'Use one of the supported target types.',
  'RECORD.WRITE_FAILED': 'Check that the folder is writable and has free space, then run the command again.',
  'RECORD.CLI_MANAGED': 'Manage this bundle with the ai-primitives-hub CLI for now.',
  'RECORD.ENTRY_NOT_FOUND': 'Check the bundle id and target with `ai-primitives-hub list`, then run the command again.'
};

/**
 * Build a `RegistryError` for a record failure.
 * @param code - Stable `RECORD.*` code.
 * @param details - File, detail, hint and optional overrides.
 * @returns The error, ready to throw.
 */
export const recordError = (code: RecordErrorCode, details: RecordErrorDetails = {}): RegistryError => {
  const context: Record<string, unknown> = {};
  if (details.file !== undefined) {
    context.file = details.file;
  }
  if (details.detail !== undefined) {
    context.detail = details.detail;
  }
  for (const [key, value] of Object.entries(details.context ?? {})) {
    context[key] = value;
  }
  return new RegistryError({
    code,
    message: details.message ?? DEFAULT_MESSAGES[code],
    hint: details.hint ?? DEFAULT_HINTS[code],
    cause: details.cause,
    context: Object.keys(context).length > 0 ? context : undefined
  });
};

/**
 * Whether a value is a record error, optionally with a given code.
 * @param value - Anything thrown.
 * @param code - Code to match; any `RECORD.*` code when omitted.
 * @returns Whether `value` is a matching `RegistryError`.
 */
export const isRecordError = (value: unknown, code?: RecordErrorCode): value is RegistryError =>
  value instanceof RegistryError
  && (code === undefined ? (RECORD_ERROR_CODES as readonly string[]).includes(value.code) : value.code === code);
