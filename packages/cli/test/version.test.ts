import {
  readFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createTestContext,
  runCli,
} from '../src/framework';
import {
  CLI_VERSION,
} from '../src/version';

const { version } = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };

describe('CLI version', () => {
  it('matches package.json', () => {
    expect(CLI_VERSION).toBe(version);
  });

  it('is printed by --version', async () => {
    const ctx = createTestContext();

    const exitCode = await runCli(['--version'], {
      ctx,
      name: 'ai-primitives-hub',
      version: CLI_VERSION,
      commands: [],
      commandClasses: []
    });

    expect(exitCode).toBe(0);
    expect(ctx.stdout.captured().trim()).toBe(`ai-primitives-hub ${version}`);
  });
});
