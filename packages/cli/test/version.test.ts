/**
 * The CLI reports the version in `packages/cli/package.json` (FR1, FR4.1).
 *
 * The expected value is read from package.json at test time, never
 * hardcoded, so these tests keep passing across releases.
 */
import {
  readFileSync,
} from 'node:fs';
import * as path from 'node:path';
import * as semver from 'semver';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ALL_COMMAND_CLASSES,
} from '../src/commands/registry';
import {
  createTestContext,
  runCli,
} from '../src/framework';
import {
  CLI_VERSION,
  readCliVersion,
} from '../src/version';

const PACKAGE_ROOT = path.resolve(__dirname, '..');

const readPackageVersion = (): string => {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
};

describe('CLI_VERSION', () => {
  it('equals packages/cli/package.json#version and is valid semver', () => {
    expect(CLI_VERSION).toBe(readPackageVersion());
    expect(semver.valid(CLI_VERSION)).toBe(CLI_VERSION);
  });

  it.each([
    ['missing version', { name: 'x' }],
    ['empty version', { version: '' }],
    ['non-string version', { version: 2 }],
    ['non-object package.json', null]
  ])('fails fast on %s', (_label, pkg) => {
    expect(() => readCliVersion(pkg)).toThrow('Unable to determine ai-primitives-hub CLI version from package.json');
  });
});

describe('ai-primitives-hub --version', () => {
  it('prints ai-primitives-hub <package.json version>', async () => {
    const ctx = createTestContext();

    const exitCode = await runCli(['--version'], {
      ctx,
      name: 'ai-primitives-hub',
      version: CLI_VERSION,
      commands: [],
      commandClasses: ALL_COMMAND_CLASSES
    });

    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured().trim()).toBe(`ai-primitives-hub ${readPackageVersion()}`);
  });
});

describe('no hardcoded CLI version literal', () => {
  // Matches a semver literal passed as the CLI's binary version next to its
  // name (the shape runCli receives), e.g. `name: 'ai-primitives-hub', version: '1.0.0'`.
  // Other `version: 'x.y.z'` literals (synthetic fixtures) are not the CLI version.
  const CLI_VERSION_LITERAL = /name:\s*['"]ai-primitives-hub['"],\s*version:\s*['"]\d+\.\d+\.\d+/;

  it.each(['src/main.ts', 'src/doctor/diagnostics.ts'])('%s passes CLI_VERSION, not a literal', (file) => {
    const source = readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');

    expect(source).not.toMatch(CLI_VERSION_LITERAL);
    expect(source).toMatch(/name:\s*['"]ai-primitives-hub['"],\s*version:\s*CLI_VERSION\b/);
  });
});
