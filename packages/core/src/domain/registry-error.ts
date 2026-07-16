/**
 * Domain error — structured, machine-readable error type used across
 * all layers. Lives here (not in `cli`'s framework) so application and
 * infrastructure code can throw `RegistryError` without depending on
 * the CLI layer.
 *
 * Named `registry-error.ts` rather than `errors.ts` to avoid colliding
 * with this package's pre-existing `domain/errors.ts` (`categorizeError`,
 * a keyword-based classifier for generic `Error` objects, ported from the
 * extension's `ErrorHandler` — an unrelated concern that happens to want
 * the same filename in the reference branch this class is ported from).
 *
 * A `renderError()` helper (which needs a CLI `Context` for stderr) stays
 * in `cli`'s framework and is re-exported from its barrel for callers that
 * need both, matching the reference branch's own split.
 * @module domain/registry-error
 */

const NAMESPACES = [
  'BUNDLE', 'INDEX', 'HUB', 'PRIMITIVE',
  'CONFIG', 'NETWORK', 'AUTH', 'FS',
  'PLUGIN', 'USAGE', 'INTERNAL'
] as const;

/**
 * Valid error-code namespace prefixes.
 */
export type RegistryErrorNamespace = (typeof NAMESPACES)[number];

const CODE_PATTERN = /^([A-Z]+)\.[A-Z][A-Z0-9_]*$/;

/**
 * Construction options for {@link RegistryError}.
 */
export interface RegistryErrorOptions {
  code: string;
  message: string;
  hint?: string;
  docsUrl?: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

/**
 * JSON-serializable error shape produced by {@link RegistryError.toJSON}.
 */
export interface RegistryErrorJson {
  code: string;
  message: string;
  hint?: string;
  docsUrl?: string;
  context?: Record<string, unknown>;
}

/**
 * Domain-specific error class. All error paths in command and
 * application code should throw `RegistryError` so the renderer can
 * produce consistent output for both text and JSON modes.
 */
export class RegistryError extends Error {
  public readonly code: string;
  public readonly hint?: string;
  public readonly docsUrl?: string;
  public readonly context?: Record<string, unknown>;
  public readonly cause?: unknown;

  public constructor(opts: RegistryErrorOptions) {
    super(opts.message);
    validateCode(opts.code);
    this.name = 'RegistryError';
    this.code = opts.code;
    this.hint = opts.hint;
    this.docsUrl = opts.docsUrl;
    this.context = opts.context;
    this.cause = opts.cause;
  }

  /**
   * Serialize to the JSON shape consumed by the output envelope.
   * @returns Output-friendly representation.
   */
  public toJSON(): RegistryErrorJson {
    const out: RegistryErrorJson = {
      code: this.code,
      message: this.message
    };
    if (this.hint !== undefined) {
      out.hint = this.hint;
    }
    if (this.docsUrl !== undefined) {
      out.docsUrl = this.docsUrl;
    }
    if (this.context !== undefined) {
      out.context = this.context;
    }
    return out;
  }
}

const validateCode = (code: string): void => {
  const m = CODE_PATTERN.exec(code);
  if (m === null) {
    throw new TypeError(
      `Invalid RegistryError code "${code}": expected NAMESPACE.UPPER_SNAKE format`
    );
  }
  const ns = m[1];
  if (!(NAMESPACES as readonly string[]).includes(ns)) {
    throw new TypeError(
      `Invalid RegistryError namespace "${ns}" in code "${code}": expected one of ${NAMESPACES.join(', ')}`
    );
  }
};

/**
 * Type guard for RegistryError.
 * @param value Anything.
 * @returns Whether `value` is a RegistryError.
 */
export const isRegistryError = (value: unknown): value is RegistryError =>
  value instanceof RegistryError;
