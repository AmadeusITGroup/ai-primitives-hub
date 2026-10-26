import {
  describe,
  expect,
  it,
} from 'vitest';
import {
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
