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
      expect(result.stdout).toContain('Findings:');
      expect(result.stdout).toContain('SEC-001');
      expect(result.stdout).toContain('secret.md:1');
      expect(result.stdout).toContain('Risk:');
      expect(result.stdout).toContain('Fix:');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports concise text output without changing the scan policy', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const target = path.join(directory, 'secret.md');
      await writeFile(target, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz');
      const result = await runCommand(['security', 'scan', target, '--quiet'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CRITICAL: 1');
      expect(result.stdout).not.toContain('Findings:');
      expect(result.stdout).not.toContain('SEC-001');
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

  it('writes actionable Markdown finding details and suppression suggestions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const target = path.join(directory, 'secret.md');
      const report = path.join(directory, 'security.md');
      await writeFile(target, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz');
      const result = await runCommand(['security', 'scan', target, '--report-markdown', report, '--fail-on', 'none'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(0);
      const markdown = await readFile(report, 'utf8');
      expect(markdown).toContain('Vulnerable content: `[REDACTED]`');
      expect(markdown).toContain('OWASP: [LLM06:2025 — Sensitive Information Disclosure]');
      expect(markdown).toContain('.markdown.ignore suggestions:');
      expect(markdown).toMatch(/[a-f0-9]{32} # Fingerprint — SEC-001/);
      expect(markdown).toMatch(/[a-f0-9]{32} # Canonical fingerprint — SEC-001/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails an empty selection unless allow-empty is explicit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const rejected = await runCommand(['security', 'scan', directory], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(rejected.exitCode).toBe(65);
      const allowed = await runCommand(['security', 'scan', directory, '--allow-empty'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(allowed.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports only findings at or above the minimum severity', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const target = path.join(directory, 'mixed.md');
      await writeFile(target, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz\n![insecure](http://example.com/image.png)');
      const result = await runCommand(['security', 'scan', target, '--minimum-severity', 'HIGH', '--fail-on', 'none', '-o', 'json'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { data: { findings: { severity: string }[] } };
      expect(envelope.data.findings.some((finding) => finding.severity === 'LOW')).toBe(false);
      expect(envelope.data.findings.some((finding) => finding.severity === 'CRITICAL')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid policy and output values as usage errors', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const invalidPolicy = await runCommand(['security', 'scan', directory, '--fail-on', 'unknown'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(invalidPolicy.exitCode).toBe(64);
      const invalidOutput = await runCommand(['security', 'scan', directory, '-o', 'xml'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(invalidOutput.exitCode).toBe(64);
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
