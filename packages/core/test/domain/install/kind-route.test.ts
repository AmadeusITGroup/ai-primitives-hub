import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  findKindRouteMismatch,
  formatKindRouteMismatch,
  isKindRouteMismatchWarning,
  matchKindRoute,
  ROUTE_PREFIX_KINDS,
  routeKindOf,
} from '../../../src';

describe('routeKindOf', () => {
  it.each(Object.entries(ROUTE_PREFIX_KINDS))('maps the nested route %s to %s', (prefix, kind) => {
    expect(routeKindOf(prefix)).toBe(kind);
  });

  it.each([
    ['prompts/', 'prompt'],
    ['instructions/', 'instruction'],
    ['chat-modes/', 'chat-mode'],
    ['agents/', 'agent'],
    ['skills/', 'skill'],
    ['hooks/', 'hook'],
    ['plugins/', 'plugin'],
    ['powers/', 'power'],
    ['knowledge/', 'knowledge'],
    ['playbooks/', 'playbook'],
    ['mcp/', 'mcp-server']
  ])('maps the single-segment route %s to %s', (prefix, kind) => {
    expect(routeKindOf(prefix)).toBe(kind);
  });

  it('accepts a prefix without a trailing slash', () => {
    expect(routeKindOf('prompts')).toBe('prompt');
    expect(routeKindOf('.kiro/steering')).toBe('steering');
  });

  it('returns null for an unknown route', () => {
    expect(routeKindOf('docs/')).toBeNull();
    expect(routeKindOf('.github/prompts/')).toBeNull();
  });
});

describe('matchKindRoute', () => {
  const routes = {
    'prompts/': '.github/prompts/',
    'chat-modes/': '.github/agents/',
    '.kiro/steering/': 'steering/',
    '.kiro/': 'other/'
  };

  it('picks the longest matching prefix and returns the tail', () => {
    expect(matchKindRoute('.kiro/steering/a/b.md', routes)).toEqual({
      prefix: '.kiro/steering/',
      outPrefix: 'steering/',
      tail: 'a/b.md'
    });
  });

  it('routes chatmodes/ through the chat-modes/ key', () => {
    expect(matchKindRoute('chatmodes/x.chatmode.md', routes)).toEqual({
      prefix: 'chat-modes/',
      outPrefix: '.github/agents/',
      tail: 'x.chatmode.md'
    });
  });

  it('returns null when no route matches', () => {
    expect(matchKindRoute('mcp-servers/x.json', routes)).toBeNull();
  });
});

describe('findKindRouteMismatch', () => {
  const routes = {
    'prompts/': '.github/prompts/',
    'chat-modes/': '.github/agents/',
    'plugins/': '.github/plugins/',
    'skills/': '.github/skills/',
    'docs/': 'docs/'
  };

  it('returns null when the route kind matches the declared kind', () => {
    expect(findKindRouteMismatch('prompts/x.prompt.md', 'prompt', routes)).toBeNull();
  });

  it('reports the route kind and key when they differ', () => {
    expect(findKindRouteMismatch('plugins/p/skills/s/SKILL.md', 'skill', routes))
      .toEqual({ routeKind: 'plugin', routePrefix: 'plugins/' });
  });

  it('reports the chat-modes/ key for a chatmodes/ path', () => {
    expect(findKindRouteMismatch('chatmodes/x.md', 'agent', routes))
      .toEqual({ routeKind: 'chat-mode', routePrefix: 'chat-modes/' });
  });

  it('returns null for an unrouted path', () => {
    expect(findKindRouteMismatch('mcp-servers/x.json', 'mcp-server', routes)).toBeNull();
  });

  it('returns null for a route key that names no kind', () => {
    expect(findKindRouteMismatch('docs/x.md', 'prompt', routes)).toBeNull();
  });
});

describe('formatKindRouteMismatch / isKindRouteMismatchWarning', () => {
  const message = formatKindRouteMismatch(
    'collections/x.collection.yml',
    2,
    'plugins/p/skills/s/SKILL.md',
    'Skill',
    { routeKind: 'plugin', routePrefix: 'plugins/' }
  );

  it('formats the item, the declared spelling and the route', () => {
    expect(message).toBe('collections/x.collection.yml: items[2] plugins/p/skills/s/SKILL.md: kind "Skill" differs '
      + 'from the kind "plugin" of the install route "plugins/" that this path matches');
  });

  it('recognises its own messages only', () => {
    expect(isKindRouteMismatchWarning(message)).toBe(true);
    expect(isKindRouteMismatchWarning(
      'collections/x.collection.yml: Collection has no readme. Consider adding a readme to help users understand this collection.'
    )).toBe(false);
  });
});
