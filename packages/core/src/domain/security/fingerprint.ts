/**
 * Stable finding identities compatible with MD Security Scanner v1.
 * @module domain/security/fingerprint
 */
import {
  createHash,
} from 'node:crypto';

const snippetForFingerprint = (snippet: string): string =>
  Array.from(snippet.trim()).slice(0, 200).join('');

const basename = (filepath: string): string => {
  const normalized = filepath.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
};

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);

/**
 * Generate the exact-occurrence fingerprint used by the reference scanner.
 * Unicode slicing is performed by code point to match Python semantics.
 * @param ruleId
 * @param filepath
 * @param line
 * @param snippet
 */
export const legacyInstanceFingerprint = (
  ruleId: string,
  filepath: string,
  line: number | undefined,
  snippet: string
): string => digest(`${ruleId}:${basename(filepath)}:${line === undefined ? 'None' : String(line)}:${snippetForFingerprint(snippet)}`);

/**
 * Generate the cross-file rule/content fingerprint used by the reference scanner.
 * @param ruleId
 * @param snippet
 */
export const legacyCanonicalFingerprint = (ruleId: string, snippet: string): string =>
  digest(`${ruleId}:${snippetForFingerprint(snippet)}`);

/** Backward-compatible alias for the instance fingerprint. */
export const legacyFingerprint = legacyInstanceFingerprint;
