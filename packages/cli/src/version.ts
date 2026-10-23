/**
 * The ai-primitives-hub CLI's released version, read from
 * `packages/cli/package.json` - the only file the release workflow bumps.
 *
 * Why a runtime `require` and not `import`:
 * - `import pkg from '../package.json'` (or `import = require`) would pull the
 *   JSON into the `tsc` program and break `rootDir: ./src`.
 * - `../package.json` resolves to the package root from both `src/version.ts`
 *   (vitest, esbuild) and `dist/version.js` (npm install; npm always ships
 *   `package.json`).
 * - esbuild inlines a static `require` of a JSON file, so the standalone SEA
 *   binary carries the version and needs no file on disk at runtime.
 * @module version
 */

/**
 * Validate the parsed `package.json` and return its `version`.
 * @param pkg Parsed `package.json` contents.
 * @returns The non-empty `version` string.
 * @throws {Error} When `version` is missing, not a string, or empty.
 */
export function readCliVersion(pkg: unknown): string {
  const version = typeof pkg === 'object' && pkg !== null
    ? (pkg as { version?: unknown }).version
    : undefined;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('Unable to determine ai-primitives-hub CLI version from package.json');
  }
  return version;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a static require keeps package.json out of the tsc program (rootDir: ./src) and lets esbuild inline it into the SEA bundle
const packageJson: unknown = require('../package.json');

/** Version of the installed ai-primitives-hub CLI, e.g. `0.2.0`. */
export const CLI_VERSION: string = readCliVersion(packageJson);
