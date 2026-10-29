import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  KindRoutes,
} from '../../../src/domain/install/layout';
import {
  resolveContained,
  resolveRecordedLocation,
} from '../../../src/domain/install/recorded-location';

const WS = path.resolve('/workspace');
const GITHUB_ROOT = path.join(WS, '.github');
const KIRO_ROOT = path.join(WS, '.kiro');

const COPILOT_ROUTES: KindRoutes = {
  'prompts/': 'prompts/',
  'chat-modes/': 'agents/',
  'instructions/': 'instructions/',
  'agents/': 'agents/',
  'skills/': 'skills/',
  'hooks/': 'hooks/',
  'plugins/': 'plugins/'
};

const KIRO_ROUTES: KindRoutes = {
  '.kiro/steering/': 'steering/',
  '.kiro/specs/': 'specs/',
  'prompts/': 'steering/',
  'instructions/': 'steering/',
  'agents/': 'agents/',
  'skills/': 'skills/'
};

const CURSOR_ROUTES: KindRoutes = {
  '.cursor/rules/': '.cursor/rules/',
  'prompts/': '.cursor/rules/',
  'instructions/': '.cursor/rules/',
  'agents/': '.cursor/agents/',
  'skills/': '.cursor/skills/',
  'plugins/': '.cursor/plugins/'
};

const DEVIN_ROUTES: KindRoutes = {
  'knowledge/': '.devin/knowledge/',
  'prompts/': '.devin/rules/',
  'instructions/': '.devin/rules/',
  'agents/': '.devin/agents/',
  'skills/': '.devin/skills/',
  'plugins/': '.devin/plugins/'
};

describe('resolveContained', () => {
  it('joins a nested relative path below the root', () => {
    expect(resolveContained(GITHUB_ROOT, 'prompts/sub/a.prompt.md'))
      .toBe(path.join(GITHUB_ROOT, 'prompts', 'sub', 'a.prompt.md'));
  });

  it('accepts mixed separators', () => {
    expect(resolveContained(GITHUB_ROOT, 'skills\\demo/SKILL.md'))
      .toBe(path.join(GITHUB_ROOT, 'skills', 'demo', 'SKILL.md'));
  });

  it('keeps a path that goes up and back down inside the root', () => {
    expect(resolveContained(GITHUB_ROOT, 'prompts/../agents/a.md'))
      .toBe(path.join(GITHUB_ROOT, 'agents', 'a.md'));
  });

  it.each([
    ['..'],
    ['../x'],
    ['/abs'],
    ['C:\\x'],
    ['C:x'],
    ['\\\\host\\x'],
    ['//host/x'],
    ['a/../../x'],
    ['a\\..\\..\\x'],
    [''],
    ['.'],
    ['a/..']
  ])('refuses %j', (relative) => {
    expect(resolveContained(GITHUB_ROOT, relative)).toBeNull();
  });
});

describe('resolveRecordedLocation', () => {
  it('uses the recorded installedPath first', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: 'prompts/sub/a.prompt.md', installedPath: 'prompts/a.prompt.md' }
    })).toBe(path.join(GITHUB_ROOT, 'prompts', 'a.prompt.md'));
  });

  it('refuses an installedPath that leaves the root', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: 'prompts/a.prompt.md', installedPath: '../outside.md' }
    })).toBeNull();
  });

  it('places a routed bundle path through its route', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: 'chat-modes/review.chatmode.md' }
    })).toBe(path.join(GITHUB_ROOT, 'agents', 'review.chatmode.md'));
  });

  it('joins a route output without a trailing separator to the rest of the path', () => {
    expect(resolveRecordedLocation({
      root: KIRO_ROOT,
      routes: { 'prompts/': 'steering' },
      workspaceRoot: WS,
      file: { path: 'prompts/a.prompt.md' }
    })).toBe(path.join(KIRO_ROOT, 'steering', 'a.prompt.md'));
  });

  it('refuses a routed path whose tail leaves the root', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: 'prompts/../../../outside' }
    })).toBeNull();
  });

  it('finds a legacy workspace-relative entry below the root', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: '.github/prompts/x.prompt.md' }
    })).toBe(path.join(GITHUB_ROOT, 'prompts', 'x.prompt.md'));
  });

  it('gives one location for a kiro steering path through its route or the legacy rule', () => {
    const file = { path: '.kiro/steering/x.md' };
    const expected = path.join(KIRO_ROOT, 'steering', 'x.md');
    expect(resolveRecordedLocation({ root: KIRO_ROOT, routes: KIRO_ROUTES, workspaceRoot: WS, file })).toBe(expected);
    expect(resolveRecordedLocation({ root: KIRO_ROOT, routes: {}, workspaceRoot: WS, file })).toBe(expected);
  });

  it('routes a cursor rule when the base directory is the workspace root', () => {
    expect(resolveRecordedLocation({
      root: WS,
      routes: CURSOR_ROUTES,
      workspaceRoot: WS,
      file: { path: '.cursor/rules/x.mdc' }
    })).toBe(path.join(WS, '.cursor', 'rules', 'x.mdc'));
  });

  it('finds legacy cursor and devin entries in their own dot directory when the base directory is the workspace root', () => {
    expect(resolveRecordedLocation({
      root: WS,
      routes: CURSOR_ROUTES,
      workspaceRoot: WS,
      file: { path: '.cursor/hooks/x.json' }
    })).toBe(path.join(WS, '.cursor', 'hooks', 'x.json'));
    expect(resolveRecordedLocation({
      root: WS,
      routes: DEVIN_ROUTES,
      workspaceRoot: WS,
      file: { path: '.devin/rules/x.md' }
    })).toBe(path.join(WS, '.devin', 'rules', 'x.md'));
  });

  it('refuses a legacy entry in another host\'s dot directory', () => {
    expect(resolveRecordedLocation({
      root: WS,
      routes: DEVIN_ROUTES,
      workspaceRoot: WS,
      file: { path: '.cursor/rules/x.mdc' }
    })).toBeNull();
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: '.kiro/steering/x.md' }
    })).toBeNull();
  });

  it('prefers the route when a layout override moves a dot-directory route', () => {
    expect(resolveRecordedLocation({
      root: KIRO_ROOT,
      routes: { ...KIRO_ROUTES, '.kiro/steering/': 'custom/' },
      workspaceRoot: WS,
      file: { path: '.kiro/steering/x.md' }
    })).toBe(path.join(KIRO_ROOT, 'custom', 'x.md'));
  });

  it('never maps an unrouted path onto the workspace when the base directory is the workspace root', () => {
    expect(resolveRecordedLocation({
      root: WS,
      routes: CURSOR_ROUTES,
      workspaceRoot: WS,
      file: { path: 'docs/x.md' }
    })).toBeNull();
  });

  it('refuses an unrouted path outside the dot directories', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: 'README.md' }
    })).toBeNull();
  });

  it('refuses a cache entry outside the workspace', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: '../ext/global/bundles/x' }
    })).toBeNull();
  });

  it('refuses a legacy entry naming the root itself', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: WS,
      file: { path: '.github' }
    })).toBeNull();
  });

  it('disables the legacy rule without a workspace root', () => {
    expect(resolveRecordedLocation({
      root: GITHUB_ROOT,
      routes: COPILOT_ROUTES,
      workspaceRoot: null,
      file: { path: '.github/prompts/x.prompt.md' }
    })).toBeNull();
  });
});
