/**
 * `doctor diagnostics` isolation and materialisation tests (PR-04, G12/O7).
 *
 * The diagnostics runner must never read or write the user's real
 * ai-primitives-hub state, and its archive materialiser must reproduce the
 * archive byte-for-byte (including executable bits) so binary plugin assets
 * and scripts survive the install/replay steps.
 */
import {
  execFileSync,
} from 'node:child_process';
import {
  createWriteStream,
} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultCacheDir,
  NodeFileSystem,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import archiver from 'archiver';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  DoctorDiagnosticsCommand,
} from '../../src/commands/doctor';
import {
  buildDiagnosticEnv,
  materializeBundleArchive,
} from '../../src/doctor/diagnostics';
import {
  createTestContext,
  runCommand,
} from '../../src/framework';

const SANDBOX_VARS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'TEMP',
  'TMP'
] as const;

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const listTree = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { recursive: true });
  return entries.map(String).toSorted();
};

describe('buildDiagnosticEnv', () => {
  const workspace = path.join(path.sep, 'diag', 'workspace');
  const parent = createTestContext({
    env: {
      HOME: path.join(path.sep, 'real', 'home'),
      USERPROFILE: path.join(path.sep, 'real', 'home'),
      TMPDIR: path.join(path.sep, 'real', 'tmp'),
      TEMP: path.join(path.sep, 'real', 'tmp'),
      TMP: path.join(path.sep, 'real', 'tmp'),
      // Ranked above XDG_CACHE_HOME by the cache resolver.
      AI_PRIMITIVES_HUB_CACHE: path.join(path.sep, 'real', 'cache'),
      // Ranked above HOME/XDG_CONFIG_HOME by git.
      GIT_CONFIG_GLOBAL: path.join(path.sep, 'real', 'home', '.gitconfig'),
      PATH: '/usr/bin'
    }
  });

  it('roots HOME, every XDG base dir and the temp dirs under the diagnostics workspace', () => {
    const env = buildDiagnosticEnv(parent, workspace);
    for (const name of SANDBOX_VARS) {
      expect(env[name], name).toBeDefined();
      expect(isInside(workspace, env[name] ?? ''), `${name}=${String(env[name])}`).toBe(true);
    }
    expect(env.PATH).toBe('/usr/bin');
  });

  it('resolves every AppStorage path inside the workspace, never the parent HOME', () => {
    const paths = new XdgAppStorage(buildDiagnosticEnv(parent, workspace)).getPaths();
    for (const [key, value] of Object.entries(paths)) {
      expect(isInside(workspace, value), `${key}=${value}`).toBe(true);
    }
  });

  it('drops parent AI_PRIMITIVES_HUB_CACHE and GIT_CONFIG_GLOBAL overrides so resolution stays inside the workspace', () => {
    const env = buildDiagnosticEnv(parent, workspace);
    expect(env).not.toHaveProperty('AI_PRIMITIVES_HUB_CACHE');
    expect(env).not.toHaveProperty('GIT_CONFIG_GLOBAL');
    const cache = defaultCacheDir(env);
    expect(isInside(workspace, cache), `cache=${cache}`).toBe(true);
  });

  it('drops every inherited GIT_* variable and keeps PATH, GITHUB_* and GH_*', () => {
    const gitVars = {
      GIT_DIR: path.join(path.sep, 'user', 'repo', '.git'),
      GIT_WORK_TREE: path.join(path.sep, 'user', 'repo'),
      GIT_INDEX_FILE: path.join(path.sep, 'user', 'repo', '.git', 'index'),
      GIT_OBJECT_DIRECTORY: path.join(path.sep, 'user', 'repo', '.git', 'objects'),
      GIT_COMMON_DIR: path.join(path.sep, 'user', 'repo', '.git'),
      GIT_CONFIG: path.join(path.sep, 'user', 'repo', '.git', 'config'),
      GIT_CONFIG_PARAMETERS: '\'commit.gpgsign\'=\'true\'',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.email',
      GIT_CONFIG_VALUE_0: 'user@example.com'
    };
    const env = buildDiagnosticEnv(
      createTestContext({
        env: {
          ...gitVars,
          PATH: '/usr/bin',
          GITHUB_REPOSITORY: 'example/repo',
          GH_TOKEN: 'token-placeholder'
        }
      }),
      workspace
    );

    expect(Object.keys(env).filter((name) => name.startsWith('GIT_'))).toEqual([]);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GITHUB_REPOSITORY).toBe('example/repo');
    expect(env.GH_TOKEN).toBe('token-placeholder');
  });
});

describe('doctor diagnostics with inherited GIT_* variables', () => {
  let scratch: string;

  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: scratch, encoding: 'utf8', env: { PATH: process.env.PATH } });

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'cli-doctor-git-env-'));
    git(['init', '-q']);
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('never touches the repository named by GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE', async () => {
    const configBefore = await readFile(path.join(scratch, '.git', 'config'));
    const statusBefore = git(['status', '--porcelain']);

    const result = await runCommand(['doctor', 'diagnostics', '-o', 'json'], {
      commandClasses: [DoctorDiagnosticsCommand],
      context: {
        fs: new NodeFileSystem(),
        env: {
          ...process.env,
          AI_PRIMITIVES_HUB_SKIP_NETWORK: '1',
          GIT_DIR: path.join(scratch, '.git'),
          GIT_INDEX_FILE: path.join(scratch, '.git', 'index'),
          GIT_WORK_TREE: scratch,
          GIT_CONFIG_PARAMETERS: '\'commit.gpgsign\'=\'true\''
        }
      }
    });
    const envelope = JSON.parse(result.stdout) as {
      data: { steps: { name: string; exitCode: number }[] };
    };

    expect(envelope.data.steps.filter((step) => step.exitCode !== 0)).toEqual([]);
    expect(envelope.data.steps).toHaveLength(54);
    expect(await readFile(path.join(scratch, '.git', 'config'))).toEqual(configBefore);
    expect(git(['status', '--porcelain'])).toBe(statusBefore);
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

describe('materializeBundleArchive', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cli-doctor-materialize-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeZip = async (
    zipPath: string,
    entries: { name: string; bytes: Uint8Array; mode: number }[]
  ): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver('zip');
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      for (const entry of entries) {
        archive.append(Buffer.from(entry.bytes), { name: entry.name, mode: entry.mode });
      }
      void archive.finalize();
    });
  };

  it('writes exact bytes for non-UTF-8 content and preserves the executable bit', async () => {
    // PNG signature + lone continuation bytes: invalid UTF-8, so a
    // TextDecoder round-trip would replace them with U+FFFD.
    const binary = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x80, 0xC3, 0x28]);
    const script = new TextEncoder().encode('#!/bin/sh\necho ok\n');
    const zipPath = path.join(root, 'bundle.zip');
    await writeZip(zipPath, [
      { name: 'plugins/demo/assets/logo.png', bytes: binary, mode: 0o644 },
      { name: 'plugins/demo/scripts/run.sh', bytes: script, mode: 0o755 }
    ]);

    const destination = path.join(root, 'out');
    const written = await materializeBundleArchive(new NodeFileSystem(), zipPath, destination);

    expect(written).toEqual(['plugins/demo/assets/logo.png', 'plugins/demo/scripts/run.sh']);
    expect(new Uint8Array(await readFile(path.join(destination, 'plugins/demo/assets/logo.png')))).toEqual(binary);
    expect(new Uint8Array(await readFile(path.join(destination, 'plugins/demo/scripts/run.sh')))).toEqual(script);
    if (process.platform !== 'win32') {
      const permissions = async (file: string): Promise<string> =>
        ((await stat(path.join(destination, file))).mode % 0o1000).toString(8);
      expect(await permissions('plugins/demo/scripts/run.sh')).toBe('755');
      // No executable bit on the asset: every octal digit is even.
      expect(await permissions('plugins/demo/assets/logo.png')).toMatch(/^[0246]{3}$/);
    }
  });
});

describe('doctor diagnostics process-level isolation', () => {
  let sandbox: string;
  let processHome: string;
  let processTmp: string;
  const saved: Partial<Record<string, string>> = {};

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'cli-doctor-isolation-'));
    processHome = path.join(sandbox, 'home');
    processTmp = path.join(sandbox, 'tmp');
    await mkdir(processHome, { recursive: true });
    await mkdir(processTmp, { recursive: true });
    for (const name of SANDBOX_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    // A fresh, throwaway process HOME/temp dir with no XDG vars: every XDG
    // fallback (`os.homedir()`, `os.tmpdir()`) now points into `sandbox`.
    // `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows.
    process.env.HOME = processHome;
    process.env.USERPROFILE = processHome;
    process.env.TMPDIR = processTmp;
    process.env.TEMP = processTmp;
    process.env.TMP = processTmp;
  });

  afterEach(async () => {
    for (const name of SANDBOX_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  it('writes nothing outside its workspace when the process has no XDG vars set', async () => {
    const result = await runCommand(['doctor', 'diagnostics', '-o', 'json'], {
      commandClasses: [DoctorDiagnosticsCommand],
      context: {
        cwd: processHome,
        fs: new NodeFileSystem(),
        // Production passes process.env straight through as ctx.env.
        env: { ...process.env, AI_PRIMITIVES_HUB_SKIP_NETWORK: '1' }
      }
    });
    const envelope = JSON.parse(result.stdout) as {
      data: { ok: boolean; workspace: string; steps: { name: string; exitCode: number }[] };
    };

    expect(envelope.data.steps.filter((step) => step.exitCode !== 0)).toEqual([]);
    expect(envelope.data.ok).toBe(true);
    expect(isInside(processTmp, envelope.data.workspace)).toBe(true);
    expect(await listTree(processHome)).toEqual([]);
    expect(await listTree(processTmp)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
