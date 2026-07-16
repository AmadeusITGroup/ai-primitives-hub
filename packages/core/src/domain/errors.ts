/**
 * Pure error categorization.
 *
 * Ported from the extension's `src/utils/error-handler.ts`
 * (`ErrorHandler.categorize` + its four private keyword-matching
 * predicates) — that file also pulls in `vscode` (for its `handle()`
 * method's user-facing notifications), so only this pure, side-effect-free
 * slice moves to `core`. The extension's `ErrorHandler.categorize`
 * delegates here; `app` use-cases that need the same classification
 * (e.g. deciding whether an update-enrichment failure is worth retrying)
 * call it directly.
 * @module domain/errors
 */

/**
 * Error categories for consistent error handling.
 */
export type ErrorCategory = 'network' | 'notfound' | 'validation' | 'authentication' | 'unexpected';

const NETWORK_KEYWORDS = ['network', 'timeout', 'econnrefused', 'enotfound', 'econnreset', 'etimedout', 'connection', 'dns', 'socket'];
const NOT_FOUND_KEYWORDS = ['not found', '404', 'does not exist', 'missing', 'unavailable'];
const VALIDATION_KEYWORDS = ['invalid', 'validation', 'schema', 'format', 'required', 'malformed'];
const AUTHENTICATION_KEYWORDS = ['unauthorized', 'forbidden', 'authentication', 'token', 'credentials', '401', '403'];

/**
 * Categorize an error based on keyword-matching its message.
 * @param error - The error to categorize.
 */
export function categorizeError(error: Error): ErrorCategory {
  const message = error.message.toLowerCase();

  if (NETWORK_KEYWORDS.some((keyword) => message.includes(keyword))) {
    return 'network';
  }
  if (NOT_FOUND_KEYWORDS.some((keyword) => message.includes(keyword))) {
    return 'notfound';
  }
  if (VALIDATION_KEYWORDS.some((keyword) => message.includes(keyword))) {
    return 'validation';
  }
  if (AUTHENTICATION_KEYWORDS.some((keyword) => message.includes(keyword))) {
    return 'authentication';
  }
  return 'unexpected';
}
