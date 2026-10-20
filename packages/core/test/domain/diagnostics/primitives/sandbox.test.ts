/**
 * Tests for the primitive diagnostics sandbox rules (design §3.7).
 */
import {
  createHash,
} from 'node:crypto';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  checkSandboxContainment,
  diffSnapshots,
  isBookkeepingLabel,
  isInside,
  labelSandboxPath,
  sha256Hex,
} from '../../../../src/domain/diagnostics/primitives';
import type {
  AppStoragePaths,
} from '../../../../src/ports/app-storage';
import type {
  PreparedSandbox,
  SnapshotRoot,
} from '../../../../src/ports/primitive-diagnostics-driver';

const CASE = '/w/cases/c1';
const HOME = `${CASE}/home`;
const WS = `${CASE}/ws`;

/** Most specific first, as the driver returns them. */
const ROOTS: SnapshotRoot[] = [
  { label: '$XDG_CONFIG_HOME', path: `${HOME}/.config` },
  { label: '$XDG_CACHE_HOME', path: `${HOME}/.cache` },
  { label: '$XDG_DATA_HOME', path: `${HOME}/.local/share` },
  { label: '$XDG_STATE_HOME', path: `${HOME}/.local/state` },
  { label: '$XDG_RUNTIME_DIR', path: `${HOME}/.run` },
  { label: '$TMPDIR', path: `${HOME}/tmp` },
  { label: '$HOME', path: HOME },
  { label: '<workspace>', path: WS },
  { label: '<case>', path: CASE }
];

const storageUnder = (root: string): AppStoragePaths => ({
  root,
  config: `${root}/config.json`,
  cache: `${root}/cache`,
  sourcesCache: `${root}/cache/sources`,
  bundlesCache: `${root}/cache/bundles`,
  installed: `${root}/installed`,
  userInstalled: `${root}/installed/user`,
  profilesInstalled: `${root}/installed/profiles`,
  profiles: `${root}/profiles`,
  logs: `${root}/logs`
});

const sandbox = (overrides: Partial<PreparedSandbox> = {}): PreparedSandbox => ({
  root: CASE,
  cwd: WS,
  home: HOME,
  roots: ROOTS,
  storage: storageUnder(`${HOME}/.local/share/ai-primitives-hub`),
  userDirs: { HOME, TMPDIR: `${HOME}/tmp`, XDG_CONFIG_HOME: `${HOME}/.config` },
  ...overrides
});

describe('isInside', () => {
  it('compares path segments, never a string prefix', () => {
    expect(isInside(HOME, HOME)).toBe(true);
    expect(isInside(HOME, `${HOME}/x`)).toBe(true);
    expect(isInside(HOME, `${CASE}/home-bak/x`)).toBe(false);
    expect(isInside('/w/cases/user', '/w/cases/user-other/x')).toBe(false);
    expect(isInside(HOME, CASE)).toBe(false);
  });
});

describe('labelSandboxPath', () => {
  it('uses the longest root that contains the path', () => {
    expect(labelSandboxPath(ROOTS, `${HOME}/.config/ai-primitives-hub/ai-primitives-hub.lock.json`))
      .toBe('$XDG_CONFIG_HOME/ai-primitives-hub/ai-primitives-hub.lock.json');
    expect(labelSandboxPath(ROOTS, `${HOME}/.kiro/steering/a.md`)).toBe('$HOME/.kiro/steering/a.md');
    expect(labelSandboxPath(ROOTS, `${WS}/.github/prompts/a.md`)).toBe('<workspace>/.github/prompts/a.md');
  });

  it('labels a path under the case root but outside home and ws as <case>/…', () => {
    expect(labelSandboxPath(ROOTS, `${CASE}/stray`)).toBe('<case>/stray');
    expect(labelSandboxPath(ROOTS, `${CASE}/home-bak/x`)).toBe('<case>/home-bak/x');
  });

  it('returns undefined outside every root (sibling prefixes included)', () => {
    expect(labelSandboxPath(ROOTS, '/w/cases/c1-other/x')).toBeUndefined();
    expect(labelSandboxPath(ROOTS, '/elsewhere')).toBeUndefined();
  });
});

describe('isBookkeepingLabel', () => {
  it.each([
    '$XDG_CONFIG_HOME/ai-primitives-hub/ai-primitives-hub.lock.json',
    '$XDG_DATA_HOME/ai-primitives-hub/installed/x.json',
    '$XDG_CACHE_HOME/ai-primitives-hub/cache/y',
    '$XDG_STATE_HOME/ai-primitives-hub/z',
    '$XDG_RUNTIME_DIR/anything',
    '$TMPDIR/tmp-123/file',
    '<workspace>/ai-primitives-hub.yml',
    '<workspace>/ai-primitives-hub.yaml',
    '<workspace>/.ai-primitives-hub/target-state.json',
    '$HOME/.ai-primitives-hub/state.json',
    '<workspace>/prompt-registry.lock.json',
    '<workspace>/prompt-registry.local.lock.json',
    '<workspace>/.git/index',
    '$HOME/repo/.git/config'
  ])('treats %s as bookkeeping', (label) => {
    expect(isBookkeepingLabel(label)).toBe(true);
  });

  it.each([
    '$XDG_CONFIG_HOME/opencode/x.md',
    '<case>/x',
    '<case>/.git/x',
    '$HOME/.kiro/steering/a.md',
    '<workspace>/.github/prompts/a.md',
    '<workspace>/sub/ai-primitives-hub.yml'
  ])('treats %s as a user-facing write', (label) => {
    expect(isBookkeepingLabel(label)).toBe(false);
  });
});

describe('diffSnapshots', () => {
  it('returns sorted added, modified and removed labels', () => {
    const before = new Map([['b', '1'], ['a', '1'], ['gone', '1']]);
    const after = new Map([['b', '2'], ['a', '1'], ['z', '1'], ['new', '1']]);
    expect(diffSnapshots(before, after)).toEqual({ added: ['new', 'z'], modified: ['b'], removed: ['gone'] });
  });
});

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex', () => {
    const bytes = new TextEncoder().encode('x');
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('checkSandboxContainment', () => {
  it('is empty for a contained sandbox', () => {
    expect(checkSandboxContainment(sandbox())).toEqual([]);
  });

  it('names every user dir and storage value outside the case root', () => {
    const escaped = sandbox({
      userDirs: { HOME, TMPDIR: '/w/cases/c1-other/tmp' },
      storage: { ...storageUnder(`${HOME}/.local/share/ai-primitives-hub`), logs: '/real/home/logs' }
    });
    expect(checkSandboxContainment(escaped)).toEqual(['TMPDIR', 'storage.logs']);
  });
});
