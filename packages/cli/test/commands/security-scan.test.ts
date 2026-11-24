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
  load,
} from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ALL_COMMAND_CLASSES,
} from '../../src/commands/registry';
import {
  SecurityScanCommand,
} from '../../src/commands/security-scan';
import {
  runCommand,
} from '../../src/framework';

describe('security scan command', () => {
  it('exposes security scan through the production command registry', async () => {
    const result = await runCommand(['security', 'scan', '--help'], { commandClasses: ALL_COMMAND_CLASSES });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--fail-on');
  });

  it.each(['--max-files', '--max-file-bytes', '--max-total-bytes', '--max-depth', '--max-findings'])(
    'rejects duration suffixes for %s', async (flag) => {
      const result = await runCommand(['security', 'scan', flag, '2s'], {
        commandClasses: [SecurityScanCommand],
        context: { fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain('positive integers');
    }
  );
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
      const initial = await runCommand(['security', 'scan', target, '-o', 'json'], {
        commandClasses: [SecurityScanCommand], context: { cwd: directory, fs: new NodeFileSystem() }
      });
      const envelope = JSON.parse(initial.stdout) as { data: { findings: { fingerprint: string }[] } };
      await writeFile(path.join(directory, '.markdown.ignore'), `${envelope.data.findings[0].fingerprint}\n`);
      const local = await runCommand(['security', 'scan', target], {
        commandClasses: [SecurityScanCommand], context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(local.exitCode).toBe(0);
      expect(local.stdout).toContain('Suppressed: 1');
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

  it.each(['json', 'yaml', 'ndjson'])('emits redacted %s output without weakening the hidden-finding policy', async (format) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const target = path.join(directory, 'secret.md');
      const syntheticSecret = 'sk-proj-abcdefghijklmnopqrstuvwxyz';
      await writeFile(target, `token = ${syntheticSecret}`);
      const result = await runCommand([
        'security', 'scan', target, '--severity', 'LOW', '--fail-on', 'HIGH', '-o', format
      ], { commandClasses: [SecurityScanCommand], context: { cwd: directory, fs: new NodeFileSystem() } });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain(syntheticSecret);
      if (format === 'ndjson') {
        const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; schemaVersion: number });
        expect(records.map((entry) => entry.type)).toEqual(['scan.header', 'scan.summary']);
        expect(records.every((entry) => entry.schemaVersion === 1)).toBe(true);
        expect(records.at(-1)).toMatchObject({ summary: { active: { total: 0 }, policy: { passed: false, blocking: ['CRITICAL'] } } });
      } else {
        const envelope: unknown = format === 'yaml' ? load(result.stdout) : JSON.parse(result.stdout);
        expect(envelope).toMatchObject({
          schemaVersion: 1, command: 'security.scan',
          data: { complete: true, findings: [], summary: { active: { total: 0 }, policy: { passed: false, blocking: ['CRITICAL'] } } }
        });
      }
      const visible = await runCommand(['security', 'scan', target, '-o', format], {
        commandClasses: [SecurityScanCommand], context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(visible.exitCode).toBe(1);
      expect(visible.stdout).toContain('SEC-001');
      expect(visible.stdout).toContain('[REDACTED]');
      expect(visible.stdout).not.toContain(syntheticSecret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts timeout units but reports malformed Claude settings as incomplete', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const target = path.join(directory, 'settings.json');
      await writeFile(target, '{invalid');
      const result = await runCommand(['security', 'scan', target, '--timeout', '2s', '--fail-on', 'none', '-o', 'json'], {
        commandClasses: [SecurityScanCommand], context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(65);
      expect(JSON.parse(result.stdout)).toMatchObject({ data: { complete: false, summary: { policy: { passed: false } } } });
      expect(result.stdout).not.toContain('{invalid');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('resolves input and report paths relative to the command context', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      await writeFile(path.join(directory, 'clean.md'), '# clean');
      const result = await runCommand(['security', 'scan', 'clean.md', '--report-json', 'report.json'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')).findings).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('honors an explicit failure policy with CI defaults', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const file = path.join(directory, 'secret.md');
      await writeFile(file, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz');
      const result = await runCommand(['security', 'scan', file, '--ci', '--fail-on', 'none'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Policy (none): passed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses only an explicitly selected trusted baseline in CI', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const file = path.join(directory, 'secret.md');
      const baseline = path.join(directory, 'trusted.ignore');
      await writeFile(file, 'token = sk-proj-abcdefghijklmnopqrstuvwxyz');
      await writeFile(baseline, 'secret.md');
      const result = await runCommand([
        'security', 'scan', file, '--ci', '--ignore-trust', 'baseline',
        '--baseline-file-ignore', baseline, '--allow-empty'
      ], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Scanned 0 file(s)');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves incomplete coverage and errors in saved reports', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const jsonReport = path.join(directory, 'report.json');
      const markdownReport = path.join(directory, 'report.md');
      const result = await runCommand([
        'security', 'scan', path.join(directory, 'missing.md'),
        '--report-json', jsonReport, '--report-markdown', markdownReport
      ], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(65);
      const report = JSON.parse(await readFile(jsonReport, 'utf8'));
      expect(report.complete).toBe(false);
      expect(report.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.INPUT_NOT_FOUND' }));
      expect(await readFile(markdownReport, 'utf8')).toContain('SECURITY.INPUT_NOT_FOUND');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps artifact-controlled titles and backticks inert in Markdown reports', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      const file = path.join(directory, 'settings.json');
      const report = path.join(directory, 'report.md');
      await writeFile(file, JSON.stringify({
        mcpServers: {
          'server`name [link](https://example.test) @reviewers': { url: 'https://example.test/`<img src=x>`' }
        }
      }));
      const result = await runCommand(['security', 'scan', file, '--report-markdown', report, '--fail-on', 'none'], {
        commandClasses: [SecurityScanCommand],
        context: { cwd: directory, fs: new NodeFileSystem() }
      });
      expect(result.exitCode).toBe(0);
      const markdown = await readFile(report, 'utf8');
      expect(markdown).not.toContain(' @reviewers');
      expect(markdown).toContain('server\\`name \\[link\\]');
      expect(markdown).toContain('&#64;reviewers');
      expect(markdown).toContain('- Vulnerable content: `` ');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid overwrite modes and durations that overflow Node timers', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-cli-'));
    try {
      for (const args of [['--report-overwrite', 'unknown'], ['--timeout', '2147483648ms']]) {
        const result = await runCommand(['security', 'scan', directory, ...args], {
          commandClasses: [SecurityScanCommand],
          context: { cwd: directory, fs: new NodeFileSystem() }
        });
        expect(result.exitCode).toBe(64);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
