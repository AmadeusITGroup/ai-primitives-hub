/**
 * "Did you mean?" command suggestion.
 *
 * When a user types an unknown command, compute the Levenshtein distance
 * against all registered command paths and suggest the closest match
 * if the distance is within a tight threshold.
 * @module framework/suggest
 */
import type {
  Cli,
} from 'clipanion';

/**
 * Compute Levenshtein edit distance between two strings.
 * @param a — first string.
 * @param b — second string.
 * @returns Minimum number of single-character edits needed.
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Suggest a command when the user types an unknown one.
 * @param argv       — the original argv vector.
 * @param cli        — clipanion Cli with all commands already registered.
 * @param binaryName — e.g. "ai-primitives-hub".
 * @returns The suggested command path, or `undefined` if nothing is close enough.
 */
export const suggestCommand = (
  argv: string[],
  cli: Cli,
  binaryName: string
): string | undefined => {
  // Reconstruct candidate command prefixes from argv (stop at first flag).
  const candidates: string[] = [];
  const prefix: string[] = [];
  for (const token of argv) {
    if (token.startsWith('-')) {
      break;
    }
    prefix.push(token);
    candidates.push(prefix.join(' '));
  }
  if (candidates.length === 0) {
    return undefined;
  }

  // Collect all known command paths (without binary prefix).
  const knownPaths: string[] = [];
  for (const def of cli.definitions()) {
    if (!def.description) {
      continue;
    }
    const binaryPrefix = `${binaryName} `;
    const path = def.path.startsWith(binaryPrefix)
      ? def.path.slice(binaryPrefix.length)
      : def.path;
    if (path === '--help' || path === '-h' || path === '--version') {
      continue;
    }
    knownPaths.push(path);
  }

  // Find the closest match across all candidate prefixes.
  let bestPath: string | undefined;
  let bestDist = Infinity;
  let bestLen = 0;
  for (const candidate of candidates) {
    const threshold = Math.min(2, Math.floor(candidate.length * 0.4));
    for (const path of knownPaths) {
      const dist = levenshtein(candidate, path);
      if (dist <= threshold && (dist < bestDist || (dist === bestDist && candidate.length > bestLen))) {
        bestDist = dist;
        bestPath = path;
        bestLen = candidate.length;
      }
    }
  }

  if (bestPath !== undefined && bestPath !== candidates.at(-1)) {
    return bestPath;
  }

  return undefined;
};
