import {
  mkdir,
  readFile,
  stat,
  symlink,
} from 'node:fs/promises';
import {
  join,
} from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  SecureAtomicSecurityReportStore,
} from '../../src/security';
import {
  createTempDir,
} from '../helpers/temp-dir';

describe('SecureAtomicSecurityReportStore', () => {
  let directory: string;
  let cleanup: () => void;

  beforeEach(() => {
    [directory, cleanup] = createTempDir('security-report-');
  });

  afterEach(() => cleanup());

  it('writes a report atomically with owner-only permissions', async () => {
    const destination = join(directory, 'report.json');
    await new SecureAtomicSecurityReportStore().write({ destination, contents: '{"ok":true}', overwrite: 'never' });

    expect(await readFile(destination, 'utf8')).toBe('{"ok":true}');
    expect((await stat(destination)).mode % 0o100).toBe(0);
  });

  it('rejects replacement unless explicitly enabled', async () => {
    const destination = join(directory, 'report.json');
    const store = new SecureAtomicSecurityReportStore();
    await store.write({ destination, contents: 'one', overwrite: 'never' });
    await expect(store.write({ destination, contents: 'two', overwrite: 'never' })).rejects.toThrow();
    await store.write({ destination, contents: 'two', overwrite: 'replace' });
    expect(await readFile(destination, 'utf8')).toBe('two');
  });

  it('rejects a symlink destination', async () => {
    const real = join(directory, 'real.json');
    const linked = join(directory, 'linked.json');
    await readFile(real, 'utf8').catch(async () => {
      await (await import('node:fs/promises')).writeFile(real, 'real');
    });
    await symlink(real, linked);
    await expect(new SecureAtomicSecurityReportStore().write({ destination: linked, contents: 'bad', overwrite: 'replace' })).rejects.toThrow();
    expect(await readFile(real, 'utf8')).toBe('real');
  });

  it('creates missing parent directories only when explicitly requested by composition', async () => {
    const destination = join(directory, 'nested', 'report.md');
    await mkdir(join(directory, 'nested'));
    await new SecureAtomicSecurityReportStore().write({ destination, contents: 'report', overwrite: 'never' });
    expect(await readFile(destination, 'utf8')).toBe('report');
  });
});
