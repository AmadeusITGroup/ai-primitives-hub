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
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  SecurityRateCommand,
} from '../../src/commands/security-rate';
import {
  runCommand,
} from '../../src/framework';

const collection = (id: string, skill: string): string =>
  `id: ${id}\nname: ${id}\nversion: 1.0.0\nauthor: Team\ntags: [demo]\nitems:\n  - path: skills/${skill}/SKILL.md\n    kind: skill\n`;

const finding = (file: string, ruleId: string, severity: string) => ({
  ruleId, title: `${ruleId} title`, severity, confidence: 'HIGH', file, line: 2
});

describe('security rate command', () => {
  let directory: string;
  let findings: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'aph-rate-cli-'));
    await mkdir(path.join(directory, 'collections'));
    await mkdir(path.join(directory, 'skills', 'bad'), { recursive: true });
    await mkdir(path.join(directory, 'skills', 'good'), { recursive: true });
    await writeFile(path.join(directory, 'collections', 'bad.collection.yml'), collection('bad', 'bad'));
    await writeFile(path.join(directory, 'collections', 'good.collection.yml'), collection('good', 'good'));
    await writeFile(path.join(directory, 'skills', 'bad', 'SKILL.md'), '# bad\n');
    await writeFile(path.join(directory, 'skills', 'good', 'SKILL.md'), '# good\n');
    findings = path.join(directory, 'findings.json');
    await writeFile(findings, JSON.stringify({ findings: [finding('skills/bad/SKILL.md', 'SEC-001', 'CRITICAL')] }));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const rate = async (args: string[], env: Record<string, string> = {}) => runCommand(['security', 'rate', directory, ...args], {
    commandClasses: [SecurityRateCommand],
    context: { cwd: directory, fs: new NodeFileSystem(), env }
  });

  it('rates each collection and fails when one is below the gate', async () => {
    const result = await rate(['--findings', findings]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Gate (CRITICAL): failed');
    expect(result.stdout).toMatch(/FAIL\s+bad\s+\d+\/100\s+critical\s+1C/);
    expect(result.stdout).toMatch(/ok\s+good\s+100\/100/);
    expect(result.stdout).toContain('[CRITICAL] SEC-001 skills/bad/SKILL.md:2');
  });

  it('passes when the gate is off or the level is above the worst bundle', async () => {
    expect((await rate(['--findings', findings, '--fail-on', 'none'])).exitCode).toBe(0);
    await writeFile(findings, JSON.stringify([finding('skills/bad/SKILL.md', 'MD-002', 'LOW')]));
    expect((await rate(['--findings', findings])).exitCode).toBe(0);
  });

  it('writes the JSON and Markdown reports and refuses to replace them without --overwrite', async () => {
    const json = path.join(directory, 'out', 'quality-report.json');
    const markdown = path.join(directory, 'out', 'quality-report.md');
    const args = ['--findings', findings, '--report-json', json, '--report-markdown', markdown, '--scanner-name', 'demo'];
    const result = await rate(args, { GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc123' });
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(await readFile(json, 'utf8')) as {
      schemaVersion: number; scanner: { name: string }; source: { repository: string; commit: string; mode: string };
      repo: { basis: string; score: number }; bundles: { id: string; score: number; metadata: { author: string; labels: string[] } }[];
      gate: { failOn: string; passed: boolean };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.scanner).toEqual({ name: 'demo' });
    expect(report.source).toMatchObject({ repository: 'o/r', commit: 'abc123', mode: 'collections' });
    expect(report.bundles.map((bundle) => [bundle.id, bundle.score])).toEqual([['bad', 37], ['good', 100]]);
    expect(report.repo).toMatchObject({ basis: 'bundles-average', score: 69 });
    expect(report.bundles[0].metadata).toMatchObject({ author: 'Team', labels: ['demo'] });
    expect(report.gate).toEqual({ failOn: 'CRITICAL', passed: false });
    expect(await readFile(markdown, 'utf8')).toContain('Quality scan: failed');

    const again = await rate(args);
    expect(again.exitCode).toBe(74);
    expect(again.stderr).toContain('already exists');
    expect((await rate([...args, '--overwrite'])).exitCode).toBe(1);
  });

  it('emits the JSON envelope', async () => {
    const result = await rate(['--findings', findings, '-o', 'json', '--fail-on', 'none']);
    const envelope = JSON.parse(result.stdout) as { command: string; data: { report: { bundles: unknown[] }; skippedFindings: number } };
    expect(envelope.command).toBe('security.rate');
    expect(envelope.data.report.bundles).toHaveLength(2);
    expect(envelope.data.skippedFindings).toBe(0);
  });

  it('warns about findings that cannot be read', async () => {
    await writeFile(findings, JSON.stringify([{ ruleId: 'X-1' }, finding('skills/good/SKILL.md', 'MD-002', 'LOW')]));
    const result = await rate(['--findings', findings]);
    expect(result.stdout).toContain('1 finding(s) without a rule id, file or severity were skipped');
  });

  it('rejects invalid options and unreadable findings', async () => {
    expect((await rate([])).exitCode).toBe(64);
    expect((await rate(['--findings', findings, '--fail-on', 'bogus'])).exitCode).toBe(64);
    expect((await rate(['--findings', findings, '-o', 'xml'])).exitCode).toBe(64);
    expect((await rate(['--findings', path.join(directory, 'missing.json')])).exitCode).toBe(65);
    await writeFile(findings, '{"unrelated": true}');
    expect((await rate(['--findings', findings])).exitCode).toBe(65);
  });
});
