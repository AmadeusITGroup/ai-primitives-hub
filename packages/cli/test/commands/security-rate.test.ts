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

const SECRET = 'token = sk-proj-abcdefghijklmnopqrstuvwxyz';

const collection = (id: string, skill: string): string =>
  `id: ${id}\nname: ${id}\nversion: 1.0.0\nauthor: Team\ntags: [demo]\nitems:\n  - path: skills/${skill}/SKILL.md\n    kind: skill\n`;

const skillFile = (body: string): string => `---\nname: helper\ndescription: helper skill\n---\n# Instructions\n${body}\n`;

describe('security rate command', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hub-rate-cli-'));
    await mkdir(path.join(directory, 'collections'));
    await mkdir(path.join(directory, 'skills', 'bad'), { recursive: true });
    await mkdir(path.join(directory, 'skills', 'good'), { recursive: true });
    await writeFile(path.join(directory, 'collections', 'bad.collection.yml'), collection('bad', 'bad'));
    await writeFile(path.join(directory, 'collections', 'good.collection.yml'), collection('good', 'good'));
    await writeFile(path.join(directory, 'skills', 'bad', 'SKILL.md'), skillFile(SECRET));
    await writeFile(path.join(directory, 'skills', 'good', 'SKILL.md'), skillFile('Be helpful.'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const rate = async (args: string[], env: Record<string, string> = {}) => runCommand(['security', 'rate', directory, ...args], {
    commandClasses: [SecurityRateCommand],
    context: { cwd: directory, fs: new NodeFileSystem(), env }
  });

  it('rates each collection and fails when one is below the gate', async () => {
    const result = await rate([]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Quality rating complete');
    expect(result.stdout).toContain('Gate (CRITICAL): failed');
    expect(result.stdout).toMatch(/FAIL\s+bad\s+\d+\/100\s+critical\s+1C/);
    expect(result.stdout).toMatch(/ok\s+good\s+\d+\/100/);
    expect(result.stdout).toMatch(/Source score: \d+\/100/);
    expect(result.stdout).toContain('[CRITICAL] SEC-001 skills/bad/SKILL.md:');
    expect(result.stdout).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
  });

  it('passes when the gate is off and when the level is above the worst bundle', async () => {
    expect((await rate(['--fail-on', 'none'])).exitCode).toBe(0);
    await writeFile(path.join(directory, 'skills', 'bad', 'SKILL.md'), skillFile('Be helpful.'));
    expect((await rate([])).exitCode).toBe(0);
  });

  it('writes the quality report the hub reads, without the secret', async () => {
    const json = path.join(directory, 'out', 'quality-report.json');
    const markdown = path.join(directory, 'out', 'quality-report.md');
    const result = await rate(['--report-json', json, '--report-markdown', markdown], { GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc123' });
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(await readFile(json, 'utf8')) as {
      schemaVersion: number; source: { repository: string; commit: string; mode: string };
      repo: { basis: string; score: number }; bundles: { id: string; score: number; metadata: { author: string; labels: string[] } }[];
      gate: { failOn: string; passed: boolean };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.source).toMatchObject({ repository: 'o/r', commit: 'abc123', mode: 'collections' });
    // File-mode findings depend on the platform, so the scores are checked by relation, not by value.
    expect(report.bundles.map((bundle) => bundle.id)).toEqual(['bad', 'good']);
    const [bad, good] = report.bundles;
    expect(bad.score).toBeLessThanOrEqual(37);
    expect(good.score).toBeGreaterThan(bad.score);
    expect(report.repo.basis).toBe('bundles-average');
    expect(report.repo.score).toBe(Math.floor((2 * (bad.score + good.score) + 2) / 4));
    expect(report.bundles[0].metadata).toMatchObject({ author: 'Team', labels: ['demo'] });
    expect(report.gate).toEqual({ failOn: 'CRITICAL', passed: false });
    expect(JSON.stringify(report)).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
    const text = await readFile(markdown, 'utf8');
    expect(text).toContain('Quality scan: failed');
    expect(text).toContain('Needs attention (1 below the gate limit)');
  });

  it('emits the hub JSON envelope', async () => {
    const result = await rate(['-o', 'json', '--fail-on', 'none']);
    const envelope = JSON.parse(result.stdout) as { command: string; data: { report: { bundles: unknown[] } } };
    expect(envelope.command).toBe('security.rate');
    expect(envelope.data.report.bundles).toHaveLength(2);
  });

  it('reports nothing to rate as an error unless allowed', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'hub-rate-empty-'));
    try {
      const run = async (extra: string[]) => runCommand(['security', 'rate', empty, ...extra], {
        commandClasses: [SecurityRateCommand], context: { cwd: empty, fs: new NodeFileSystem(), env: {} }
      });
      expect((await run([])).exitCode).toBe(65);
      expect((await run(['--allow-empty'])).exitCode).toBe(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('rejects invalid options', async () => {
    expect((await rate(['--fail-on', 'bogus'])).exitCode).toBe(64);
    expect((await rate(['-o', 'xml'])).exitCode).toBe(64);
  });
});
