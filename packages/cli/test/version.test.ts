import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  CLI_VERSION,
} from '../src/version';

describe('CLI version', () => {
  it('matches the published package version', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
    ) as { version: string };

    expect(CLI_VERSION).toBe(packageJson.version);
  });
});
