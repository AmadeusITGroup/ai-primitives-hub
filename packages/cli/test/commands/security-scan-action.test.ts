import {
  execFile,
} from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  load,
} from 'js-yaml';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const exec = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const selectionScript = async (): Promise<string> => {
  const action: unknown = load(await readFile(path.resolve(__dirname, '../../../../github-actions/security-scan/action.yml'), 'utf8'));
  if (!record(action) || !record(action.runs) || !Array.isArray(action.runs.steps)) {
    throw new Error('Invalid security action');
  }
  const step: unknown = action.runs.steps.find((value: unknown) => record(value) && value.id === 'targets');
  if (!record(step) || typeof step.run !== 'string') {
    throw new Error('Missing security action target selection');
  }
  return step.run;
};

describe('security scan action target selection', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hub-security-action-'));
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd: directory });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const select = async (base: string, head: string): Promise<string[]> => {
    await exec('bash', ['-c', await selectionScript()], {
      cwd: directory,
      env: {
        ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: path.join(directory, 'output'),
        INPUT_PATHS: '', EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head
      }
    });
    return (await readFile(path.join(directory, 'ai-primitives-security-targets.txt'), 'utf8')).split('\0').filter(Boolean);
  };

  it('preserves spaces, newlines and leading dashes in changed Markdown paths', async () => {
    const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: directory });
    const files = ['-flags.md', 'space name.md', 'line\nbreak.markdown'];
    await Promise.all(files.map((file) => writeFile(path.join(directory, file), '# text')));
    await exec('git', ['add', '--', ...files], { cwd: directory });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'files'], { cwd: directory });
    expect((await select(base.trim(), 'HEAD')).toSorted()).toEqual(files.toSorted());
  });

  it('fails when the comparison revision is unavailable instead of reporting no changes', async () => {
    await expect(select('missing-revision', 'HEAD')).rejects.toThrow();
  });

  it('reports a genuinely empty change set successfully', async () => {
    expect(await select('HEAD', 'HEAD')).toEqual([]);
    expect(await readFile(path.join(directory, 'output'), 'utf8')).toContain('has-targets=false');
  });
});
