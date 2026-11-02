import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  countManifestItemsByKind,
  manifestItems,
} from '../../../src';

const pluginOnlyRelease = {
  formatVersion: 1,
  id: 'demo-bundle',
  version: '1.0.0',
  items: [{ path: 'plugins/demo/plugin.json', kind: 'plugin', id: 'demo' }],
  // Legacy projection of the same item; must not be counted twice.
  prompts: [{ id: 'demo', file: 'plugins/demo/plugin.json', type: 'plugin' }]
};

describe('manifestItems', () => {
  it('reads only canonical items[] for a formatVersion 1 manifest', () => {
    expect(manifestItems(pluginOnlyRelease)).toEqual([
      { file: 'plugins/demo/plugin.json', type: 'plugin', id: 'demo' }
    ]);
  });

  it('concatenates items and the legacy lists in writer order without formatVersion', () => {
    const manifest = {
      items: [{ path: 'prompts/a.prompt.md', kind: 'prompt', id: 'a' }],
      prompts: [
        { id: 'p', file: 'plugins/p/plugin.json', type: 'plugin' },
        { id: 'i', file: 'instructions/i.instructions.md', type: 'instructions' }
      ],
      agents: [{ id: 'ag', file: 'agents/ag.agent.md', type: 'agent' }],
      instructions: [{ id: 'cm', file: 'chatmodes/cm.chatmode.md', type: 'chatmode' }],
      hooks: [{ id: 'h', file: 'hooks/h.json', type: 'hook' }],
      plugins: [{ id: 'pl', file: 'plugins/pl/plugin.json', type: 'plugin' }],
      skills: [{ id: 'sk', file: 'skills/sk/SKILL.md', type: 'skill' }]
    };
    expect(manifestItems(manifest)).toEqual([
      { file: 'prompts/a.prompt.md', type: 'prompt', id: 'a' },
      { file: 'plugins/p/plugin.json', type: 'plugin', id: 'p' },
      { file: 'instructions/i.instructions.md', type: 'instructions', id: 'i' },
      { file: 'agents/ag.agent.md', type: 'agent', id: 'ag' },
      { file: 'chatmodes/cm.chatmode.md', type: 'chatmode', id: 'cm' },
      { file: 'hooks/h.json', type: 'hook', id: 'h' },
      { file: 'plugins/pl/plugin.json', type: 'plugin', id: 'pl' },
      { file: 'skills/sk/SKILL.md', type: 'skill' }
    ]);
  });

  it('gives an untyped legacy entry the kind of its list', () => {
    const manifest = {
      prompts: [{ id: 'p', file: 'prompts/p.prompt.md' }],
      plugins: [{ id: 'pl', file: 'plugins/pl/plugin.json' }],
      instructions: [{ file: 'instructions/i.instructions.md' }]
    };
    expect(manifestItems(manifest)).toEqual([
      { file: 'prompts/p.prompt.md', type: 'prompt', id: 'p' },
      { file: 'instructions/i.instructions.md', type: 'instruction' },
      { file: 'plugins/pl/plugin.json', type: 'plugin', id: 'pl' }
    ]);
  });

  it('ignores malformed lists and entries without throwing', () => {
    const manifest = {
      hooks: { pre_install: ['x'] },
      prompts: 'oops',
      agents: [null, 'agent', { id: 'no-file', type: 'agent' }, { file: 42 }, { file: 'agents/ok.agent.md' }],
      items: [{ kind: 'plugin' }, { path: 'plugins/no-kind/plugin.json' }]
    };
    expect(manifestItems(manifest)).toEqual([{ file: 'agents/ok.agent.md', type: 'agent' }]);
    for (const input of [undefined, null, 'str', 42, []]) {
      expect(manifestItems(input)).toEqual([]);
    }
  });
});

describe('countManifestItemsByKind', () => {
  it('counts a plugin-only release once', () => {
    expect(countManifestItemsByKind(pluginOnlyRelease)).toEqual({ plugin: 1 });
  });

  it('counts a mixed release by kind', () => {
    expect(countManifestItemsByKind({
      formatVersion: 1,
      items: [
        { path: 'plugins/demo/plugin.json', kind: 'plugin', id: 'demo' },
        { path: 'prompts/hello.prompt.md', kind: 'prompt', id: 'hello' }
      ]
    })).toEqual({ plugin: 1, prompt: 1 });
  });

  it('normalizes legacy kind aliases', () => {
    expect(countManifestItemsByKind({
      prompts: [
        { file: 'instructions/a.instructions.md', type: 'instructions' },
        { file: 'chatmodes/b.chatmode.md', type: 'chatmode' },
        { file: 'prompts/c.prompt.md' }
      ],
      plugins: [{ file: 'plugins/d/plugin.json' }]
    })).toEqual({ instruction: 1, 'chat-mode': 1, prompt: 1, plugin: 1 });
  });

  it('does not count unknown kinds', () => {
    const manifest = { prompts: [{ file: 'widgets/w.md', type: 'widget' }] };
    expect(manifestItems(manifest)).toHaveLength(1);
    expect(countManifestItemsByKind(manifest)).toEqual({});
  });

  it('returns no counts for an empty or malformed manifest', () => {
    expect(countManifestItemsByKind({})).toEqual({});
    expect(countManifestItemsByKind(undefined)).toEqual({});
    expect(countManifestItemsByKind({ hooks: { pre_bundle: ['x'] } })).toEqual({});
  });
});
