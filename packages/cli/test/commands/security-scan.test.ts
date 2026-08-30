import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  SecurityScanCommand,
} from '../../src/commands/security-scan';
import {
  runCommand,
} from '../../src/framework';

describe('security scan command', () => {
  it('scans multiple positional files and returns a policy failure for a secret', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const first = path.join(directory, 'clean.md');
      const second = path.join(directory, 'secret.md');
      await writeFile(first, '# clean');
      await writeFile(second, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz');
      const result = await runCommand(['security', 'scan', first, second], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CRITICAL: 1');
      expect(result.stdout).toContain('Scanned 2 file(s)');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('emits the hub JSON envelope and writes requested reports', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const target = path.join(directory, 'clean.md');
      const reportDirectory = path.join(directory, 'reports');
      await mkdir(reportDirectory);
      await writeFile(target, '# clean');
      const result = await runCommand(['security', 'scan', target, '--report-json', path.join(reportDirectory, 'scan.json'), '-o', 'json'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { command: string; data: { complete: boolean } };
      expect(envelope.command).toBe('security.scan');
      expect(envelope.data.complete).toBe(true);
      expect(JSON.parse(await readFile(path.join(reportDirectory, 'scan.json'), 'utf8')).findings).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not honor repository suppressions in CI mode', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const target = path.join(directory, 'secret.md');
      await writeFile(target, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz');
      await writeFile(path.join(directory, '.markdown.ignore'), 'ffffffffffffffffffffffffffffffff\n');
      const result = await runCommand(['security', 'scan', '--ci', target], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CRITICAL: 1');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
