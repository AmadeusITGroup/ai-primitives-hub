/**
 * Coverage tests for domain/collection/validate.ts.
 *
 * Tests all validation functions: validateCollectionId, validateVersion,
 * validateItemKind, normalizeRepoRelativePath, isSafeRepoRelativePath,
 * validateCollectionObject.
 *
 * Ported unchanged from the reference branch's
 * `core/test/domain/collection-validate.test.ts`.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  DEFAULT_VALIDATION_RULES,
  isSafeRepoRelativePath,
  normalizeRepoRelativePath,
  validateCollectionId,
  validateCollectionObject,
  validateItemKind,
  validateVersion,
} from '../../../src/domain/collection/validate';

describe('validateCollectionId', () => {
  it('accepts valid collection ID', () => {
    expect(validateCollectionId('my-collection')).toEqual({ valid: true });
    expect(validateCollectionId('test-123')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateCollectionId('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects non-string', () => {
    const result = validateCollectionId(null as unknown as string);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects ID exceeding max length', () => {
    const longId = 'a'.repeat(101);
    const result = validateCollectionId(longId);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at most 100');
  });

  it('rejects ID with invalid characters', () => {
    expect(validateCollectionId('My_Collection').valid).toBe(false);
    expect(validateCollectionId('my.collection').valid).toBe(false);
    expect(validateCollectionId('my collection').valid).toBe(false);
  });
});

describe('validateVersion', () => {
  it('accepts valid semantic version', () => {
    expect(validateVersion('1.0.0')).toEqual({ valid: true, normalized: '1.0.0' });
    expect(validateVersion('2.3.1')).toEqual({ valid: true, normalized: '2.3.1' });
  });

  it('uses default version when undefined', () => {
    expect(validateVersion(undefined)).toEqual({ valid: true, normalized: '1.0.0' });
  });

  it('uses default version when null', () => {
    expect(validateVersion(null)).toEqual({ valid: true, normalized: '1.0.0' });
  });

  it('rejects non-string version', () => {
    const result = validateVersion(123 as unknown as string);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be a string');
  });

  it('rejects invalid version format', () => {
    expect(validateVersion('v1.0.0').valid).toBe(false);
    expect(validateVersion('1.0').valid).toBe(false);
    expect(validateVersion('1.0.0.0').valid).toBe(false);
  });
});

describe('validateItemKind', () => {
  it('accepts valid item kinds', () => {
    expect(validateItemKind('prompt')).toEqual({ valid: true });
    expect(validateItemKind('instruction')).toEqual({ valid: true });
    expect(validateItemKind('agent')).toEqual({ valid: true });
    expect(validateItemKind('skill')).toEqual({ valid: true });
    expect(validateItemKind('plugin')).toEqual({ valid: true });
    expect(validateItemKind('hook')).toEqual({ valid: true });
  });

  it('accepts uppercase kinds (normalizes)', () => {
    expect(validateItemKind('PROMPT')).toEqual({ valid: true });
    expect(validateItemKind('Agent')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateItemKind('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects non-string', () => {
    const result = validateItemKind(null as unknown as string);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects deprecated kind chatmode', () => {
    const result = validateItemKind('chatmode');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('deprecated');
    expect(result.replacement).toBe('agent');
  });

  it('accepts chat-mode as a valid kind', () => {
    const result = validateItemKind('chat-mode');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid kind', () => {
    const result = validateItemKind('invalid-kind');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid item kind');
  });
});

describe('normalizeRepoRelativePath', () => {
  it('normalizes simple paths', () => {
    expect(normalizeRepoRelativePath('prompts')).toBe('prompts');
    expect(normalizeRepoRelativePath('skills/my-skill')).toBe('skills/my-skill');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeRepoRelativePath('skills\\my-skill')).toBe('skills/my-skill');
  });

  it('removes leading slash', () => {
    expect(normalizeRepoRelativePath('/prompts')).toBe('prompts');
  });

  it('trims whitespace', () => {
    expect(normalizeRepoRelativePath('  prompts  ')).toBe('prompts');
  });

  it('throws on empty string', () => {
    expect(() => normalizeRepoRelativePath('')).toThrow('non-empty');
  });

  it('throws on non-string', () => {
    expect(() => normalizeRepoRelativePath(null as unknown as string)).toThrow('non-empty');
  });

  it('throws on path traversing outside repo', () => {
    expect(() => normalizeRepoRelativePath('../outside')).toThrow('outside repo');
    expect(() => normalizeRepoRelativePath('..')).toThrow('outside repo');
  });
});

describe('isSafeRepoRelativePath', () => {
  it('returns true for safe paths', () => {
    expect(isSafeRepoRelativePath('prompts')).toBe(true);
    expect(isSafeRepoRelativePath('skills/my-skill')).toBe(true);
  });

  it('returns true for absolute paths (normalized to relative)', () => {
    expect(isSafeRepoRelativePath('/prompts')).toBe(true);
  });

  it('returns false for unsafe paths', () => {
    expect(isSafeRepoRelativePath('../outside')).toBe(false);
    expect(isSafeRepoRelativePath('')).toBe(false);
  });
});

describe('validateCollectionObject', () => {
  it('accepts valid minimal collection', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      description: 'A collection',
      items: [{ path: 'prompts/hello.md', kind: 'prompt' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts valid collection with version', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      description: 'A collection',
      version: '1.0.0',
      items: [{ path: 'prompts/hello.md', kind: 'prompt' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(true);
  });

  it('accepts a collection with a nested README path', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      description: 'A collection',
      readme: { path: 'docs/collection-overview.md' },
      items: []
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a non-object README', 'README.md', 'readme must be an object with a "path" property'],
    ['a null README', null, 'readme must be an object with a "path" property'],
    ['an empty README object', {}, 'readme.path must be a non-empty string'],
    ['an empty README path', { path: '' }, 'readme.path must be a non-empty string'],
    ['a traversal README path', { path: '../README.md' }, 'readme.path has an invalid path']
  ])('rejects %s', (_label, readme, expectedError) => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      readme,
      items: []
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes(expectedError))).toBe(true);
  });

  it('rejects non-object', () => {
    const result = validateCollectionObject(null, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('test: YAML did not parse to an object');
  });

  it('rejects missing id', () => {
    const collection = {
      name: 'My Collection',
      items: []
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('test: Missing required field: id');
  });

  it('rejects invalid id', () => {
    const collection = {
      id: 'Invalid_ID',
      name: 'My Collection',
      items: []
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects missing name', () => {
    const collection = {
      id: 'my-collection',
      items: []
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('test: Missing required field: name');
  });

  it('rejects invalid version', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      version: 'invalid',
      items: []
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects missing items array', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection'
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('test: Missing required field: items (array)');
  });

  it('rejects non-array items', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      items: 'not-an-array'
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects item without path', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      items: [{ kind: 'prompt' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('test: items[0]: Missing required field: path');
  });

  it('rejects item with invalid path', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      items: [{ path: '../outside', kind: 'prompt' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects item without kind', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      items: [{ path: 'prompts/hello.md' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('test: items[0]: Missing required field: kind');
  });

  it('rejects item with deprecated kind', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      items: [{ path: 'prompts/hello.md', kind: 'chatmode' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('deprecated'))).toBe(true);
  });

  it('rejects item with invalid kind', () => {
    const collection = {
      id: 'my-collection',
      name: 'My Collection',
      items: [{ path: 'prompts/hello.md', kind: 'invalid-kind' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
  });

  it('accepts collection with all supported kinds including plugin and hook', () => {
    const collection = {
      id: 'all-kinds',
      name: 'All Kinds Collection',
      description: 'Every supported kind',
      items: [
        { path: 'prompts/hello.prompt.md', kind: 'prompt' },
        { path: 'instructions/style.instructions.md', kind: 'instruction' },
        { path: 'chatmodes/review.chatmode.md', kind: 'chat-mode' },
        { path: 'agents/coder.agent.md', kind: 'agent' },
        { path: 'skills/my-skill/SKILL.md', kind: 'skill' },
        { path: 'plugins/my-plugin/plugin.json', kind: 'plugin' },
        { path: 'hooks/format.json', kind: 'hook' }
      ]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('collects multiple errors', () => {
    const collection = {
      id: 'Invalid_ID',
      items: [{ path: '../outside', kind: 'invalid-kind' }]
    };
    const result = validateCollectionObject(collection, 'test');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('validateCollectionObject — published collection schema rules', () => {
  const L = 'collections/x.collection.yml';
  const I = `${L}: items[0]`;
  const base = (): Record<string, unknown> => ({
    id: 'x',
    name: 'X',
    description: 'A collection',
    items: [{ path: 'prompts/hello.prompt.md', kind: 'prompt' }]
  });
  const withRoot = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...base(), ...overrides });
  const withItem = (overrides: Record<string, unknown>): Record<string, unknown> =>
    withRoot({ items: [{ path: 'prompts/hello.prompt.md', kind: 'prompt', ...overrides }] });
  const withServer = (server: unknown, name = 'srv'): Record<string, unknown> => withRoot({ mcp: { items: { [name]: server } } });
  const withInput = (input: unknown): Record<string, unknown> => withRoot({ mcp: { inputs: [input] } });
  const withDisplay = (display: unknown): Record<string, unknown> => withRoot({ display });
  const S = `${L}: mcp.items.srv`;
  const IN = `${L}: mcp.inputs[0]`;
  const D = `${L}: display`;

  it('accepts a collection using every schema property without errors or warnings', () => {
    const collection = {
      id: 'full',
      name: 'Full Collection',
      description: 'Uses every property of the published schema',
      version: '1.2.3',
      author: 'Jane Doe',
      tags: ['testing', 'schema'],
      readme: { path: 'README.md' },
      items: [{
        path: 'prompts/hello.prompt.md',
        kind: 'prompt',
        title: 'Hello',
        description: 'Says hello',
        tags: ['greeting']
      }],
      mcp: {
        items: {
          'local-server': {
            type: 'stdio',
            command: 'node',
            args: ['${bundlePath}/server.js'],
            env: { LOG_LEVEL: 'debug' },
            envFile: '${bundlePath}/.env',
            disabled: false
          },
          remote_server: {
            type: 'http',
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer ${input:api-token}' }
          },
          implicit: { command: 'npx' }
        },
        inputs: [
          { id: 'api-token', type: 'promptString', description: 'API token', password: true, default: '' },
          { id: 'region', type: 'pickString', options: ['eu', 'us'] }
        ]
      },
      display: { color: '#336699', icon: 'book', ordering: 'alphabetical', show_badge: true }
    };
    const result = validateCollectionObject(collection, L);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('accepts a name of 100, a description of 500 characters and more than 50 items', () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ path: `prompts/p${i}.prompt.md`, kind: 'prompt' }));
    const result = validateCollectionObject(withRoot({ name: 'n'.repeat(100), description: 'd'.repeat(500), items }), L);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('counts name and description length in code points, as the schema does', () => {
    const accepted = validateCollectionObject(withRoot({ name: '😀'.repeat(100), description: '😀'.repeat(500) }), L);
    expect(accepted).toEqual({ ok: true, errors: [], warnings: [] });
    const rejected = validateCollectionObject(withRoot({ name: '😀'.repeat(101), description: '😀'.repeat(501) }), L);
    expect(rejected.errors).toEqual([
      `${L}: name must be at most 100 characters (got 101)`,
      `${L}: description must be at most 500 characters (got 501)`
    ]);
  });

  it('reports a cyclic value without throwing', () => {
    const type: unknown[] = [];
    type.push(type);
    const result = validateCollectionObject(withServer({ type, command: 'node' }), L);
    expect(result.errors).toEqual([`${S}: Invalid type '[object Array]'. Must be one of: stdio, http, sse`]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a null version', withRoot({ version: null }), `${L}: Version must be a string`],
    ['a missing description', withRoot({ description: undefined }), `${L}: Missing required field: description`],
    ['a non-string description', withRoot({ description: 42 }), `${L}: Missing required field: description`],
    ['an empty description', withRoot({ description: '' }), `${L}: Missing required field: description`],
    ['a name over 100 characters', withRoot({ name: 'n'.repeat(101) }), `${L}: name must be at most 100 characters (got 101)`],
    ['a description over 500 characters', withRoot({ description: 'd'.repeat(501) }),
      `${L}: description must be at most 500 characters (got 501)`],
    ['a non-string author', withRoot({ author: 42 }), `${L}: author must be a string`],
    ['non-array tags', withRoot({ tags: 'a,b' }), `${L}: tags must be an array`],
    ['a non-string tag', withRoot({ tags: ['ok', 7] }), `${L}: tags[1] must be a string`],
    ['a non-string item title', withItem({ title: 1 }), `${I}: title must be a string`],
    ['a non-string item description', withItem({ description: false }), `${I}: description must be a string`],
    ['non-array item tags', withItem({ tags: 'x' }), `${I}: tags must be an array of strings`],
    ['a non-string item tag', withItem({ tags: ['x', 2] }), `${I}: tags must be an array of strings`],
    ['a non-object mcp', withRoot({ mcp: [] }), `${L}: mcp must be an object`],
    ['a non-object mcp.items', withRoot({ mcp: { items: [] } }), `${L}: mcp.items must be an object`],
    ['an invalid server name', withServer({ command: 'node' }, 'bad name'),
      `${L}: mcp.items: invalid server name 'bad name' (letters, digits, '_' and '-' only)`],
    ['a non-object server', withServer('node'), `${S} must be an object`],
    ['an invalid server type', withServer({ type: 'ws', url: 'ws://x' }), `${S}: Invalid type 'ws'. Must be one of: stdio, http, sse`],
    ['a server without type or command', withServer({ args: ['a'] }), `${S}: Missing required field: command`],
    ['a stdio server without command', withServer({ type: 'stdio' }), `${S}: Missing required field: command`],
    ['an http server without url', withServer({ type: 'http' }), `${S}: Missing required field: url`],
    ['an sse server without url', withServer({ type: 'sse', headers: {} }), `${S}: Missing required field: url`],
    ['a non-string command', withServer({ command: 1 }), `${S}: command must be a string`],
    ['a non-string envFile', withServer({ command: 'node', envFile: 1 }), `${S}: envFile must be a string`],
    ['a non-string url', withServer({ type: 'http', url: 1 }), `${S}: url must be a string`],
    ['non-string args', withServer({ command: 'node', args: [1] }), `${S}: args must be an array of strings`],
    ['a non-string env value', withServer({ command: 'node', env: { A: 1 } }), `${S}: env must be an object of strings`],
    ['an array env', withServer({ command: 'node', env: ['A=1'] }), `${S}: env must be an object of strings`],
    ['a non-string header value', withServer({ type: 'http', url: 'http://x', headers: { A: true } }),
      `${S}: headers must be an object of strings`],
    ['a non-boolean disabled', withServer({ command: 'node', disabled: 'yes' }), `${S}: disabled must be a boolean`],
    ['non-array mcp.inputs', withRoot({ mcp: { inputs: {} } }), `${L}: mcp.inputs must be an array`],
    ['a non-object input', withInput('token'), `${IN} must be an object`],
    ['an input without id', withInput({ type: 'promptString' }), `${IN}: Missing required field: id`],
    ['an input without type', withInput({ id: 'tok' }), `${IN}: Missing required field: type`],
    ['an invalid input id', withInput({ id: 'my token', type: 'promptString' }),
      `${IN}: id must contain only letters, digits, '_' and '-'`],
    ['an invalid input type', withInput({ id: 'tok', type: 'secret' }),
      `${IN}: Invalid type 'secret'. Must be one of: promptString, pickString, command`],
    ['a non-string input description', withInput({ id: 'tok', type: 'promptString', description: 1 }), `${IN}: description must be a string`],
    ['a non-string input default', withInput({ id: 'tok', type: 'promptString', default: 1 }), `${IN}: default must be a string`],
    ['a non-boolean input password', withInput({ id: 'tok', type: 'promptString', password: 'yes' }), `${IN}: password must be a boolean`],
    ['non-string input options', withInput({ id: 'tok', type: 'pickString', options: [1] }), `${IN}: options must be an array of strings`],
    ['a non-object display', withDisplay('blue'), `${L}: display must be an object`],
    ['a non-string display color', withDisplay({ color: 1 }), `${D}: color must be a string`],
    ['a non-string display icon', withDisplay({ icon: 1 }), `${D}: icon must be a string`],
    ['an invalid display ordering', withDisplay({ ordering: 'random' }), `${D}: Invalid ordering 'random'. Must be one of: manual, alphabetical`],
    ['a non-boolean display show_badge', withDisplay({ show_badge: 'yes' }), `${D}: show_badge must be a boolean`]
  ])('rejects %s', (_label, collection, expectedError) => {
    const result = validateCollectionObject(collection, L);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expectedError]);
    expect(result.warnings).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['more than 10 tags', withRoot({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), `${L}: More than 10 tags (recommended max)`],
    ['a tag longer than 30 characters', withRoot({ tags: ['ok', 't'.repeat(31)] }), `${L}: tags[1] is longer than 30 characters`]
  ])('warns for %s without failing', (_label, collection, expectedWarning) => {
    const result = validateCollectionObject(collection, L);
    expect(result).toEqual({ ok: true, errors: [], warnings: [expectedWarning] });
  });

  const ROOT_ALLOWED = 'id, name, description, items, mcp, readme, version, author, tags, display';
  const unknownRoot = (key: string): string =>
    `${L}: unknown root property '${key}' is not in the collection schema; remove it or rename it to one of: ${ROOT_ALLOWED}`;
  const unknown = (prefix: string, key: string, allowed: string): string =>
    `${prefix}: unknown property '${key}' is not in the collection schema; remove it or rename it to one of: ${allowed}`;
  const SERVER_ALLOWED = 'type, command, args, env, envFile, url, headers, disabled';

  it.each<[string, Record<string, unknown>, string]>([
    ['an unknown root property', withRoot({ extra: true }), unknownRoot('extra')],
    ['a root mcpServers property', withRoot({ mcpServers: {} }), unknownRoot('mcpServers')],
    ['a root license property', withRoot({ license: 'MIT' }), unknownRoot('license')],
    ['an unknown item property', withItem({ name: 'Hello' }), unknown(I, 'name', 'path, kind, title, description, tags')],
    ['an unknown mcp property', withRoot({ mcp: { servers: {} } }), unknown(`${L}: mcp`, 'servers', 'items, inputs')],
    ['an unknown server property', withServer({ command: 'node', description: 'x' }), unknown(S, 'description', SERVER_ALLOWED)],
    ['an unknown input property', withInput({ id: 'tok', type: 'promptString', label: 'x' }),
      unknown(IN, 'label', 'id, type, description, password, default, options')],
    ['an unknown display property', withDisplay({ theme: 'dark' }), unknown(D, 'theme', 'color, icon, ordering, show_badge')]
  ])('warns for %s without failing', (_label, collection, expectedWarning) => {
    const result = validateCollectionObject(collection, L);
    expect(result).toEqual({ ok: true, errors: [], warnings: [expectedWarning] });
  });

  it('reports an unknown root property as a warning next to a missing description', () => {
    const result = validateCollectionObject(withRoot({ license: 'MIT', description: undefined }), L);
    expect(result).toEqual({
      ok: false,
      errors: [`${L}: Missing required field: description`],
      warnings: [unknownRoot('license')]
    });
  });

  it('reports an unknown server property as a warning next to a server error', () => {
    const result = validateCollectionObject(withServer({ type: 'http', extra: 1 }), L);
    expect(result).toEqual({
      ok: false,
      errors: [`${S}: Missing required field: url`],
      warnings: [unknown(S, 'extra', SERVER_ALLOWED)]
    });
  });

  it('keeps matching item kinds case-insensitively', () => {
    const result = validateCollectionObject(withItem({ kind: 'Prompt' }), L);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });
});

describe('DEFAULT_VALIDATION_RULES', () => {
  it('has expected structure', () => {
    expect(DEFAULT_VALIDATION_RULES.collectionId).toBeDefined();
    expect(DEFAULT_VALIDATION_RULES.collectionId.maxLength).toBe(100);
    expect(DEFAULT_VALIDATION_RULES.version).toBeDefined();
    expect(DEFAULT_VALIDATION_RULES.deprecatedKinds).toHaveProperty('chatmode');
  });

  it('itemKinds contains all 7 supported kinds', () => {
    const kinds = DEFAULT_VALIDATION_RULES.itemKinds;
    expect(kinds).toContain('prompt');
    expect(kinds).toContain('instruction');
    expect(kinds).toContain('chat-mode');
    expect(kinds).toContain('agent');
    expect(kinds).toContain('skill');
    expect(kinds).toContain('plugin');
    expect(kinds).toContain('hook');
  });

  it('chat-mode is a valid kind, not deprecated', () => {
    expect(DEFAULT_VALIDATION_RULES.itemKinds).toContain('chat-mode');
    expect(DEFAULT_VALIDATION_RULES.deprecatedKinds).not.toHaveProperty('chat-mode');
  });
});
