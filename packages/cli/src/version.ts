/**
 * CLI version, read from `packages/cli/package.json`.
 * @module version
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- keeps package.json out of the tsc program; esbuild inlines it
const { version } = require('../package.json') as { version?: unknown };

if (typeof version !== 'string' || version.length === 0) {
  throw new Error('Unable to determine ai-primitives-hub CLI version from package.json');
}

/** Installed CLI version, e.g. `0.2.0`. */
export const CLI_VERSION: string = version;
