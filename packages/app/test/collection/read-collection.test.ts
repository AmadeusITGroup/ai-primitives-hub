import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  generateMarkdown,
  resolveCollectionReadmePath,
  validateAllCollections,
  validateCollectionFile,
} from '../../src/collection/read-collection';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-collection-test-'));
  fs.mkdirSync(path.join(tempDir, 'collections'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'prompts', 'hello.prompt.md'), '# Hello\n');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const writeCollection = (content: string): string => {
  const collectionFile = path.join('collections', 'foo.collection.yml');
  fs.writeFileSync(path.join(tempDir, collectionFile), content);
  return collectionFile;
};

describe('collection README handling', () => {
  it('resolves a normalized nested README path', () => {
    expect(resolveCollectionReadmePath({ readme: { path: 'docs\\collection-overview.md' } })).toBe('docs/collection-overview.md');
  });

  it('validates an existing README without warnings', () => {
    fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'docs', 'collection-overview.md'), '# Overview\n');
    const collectionPath = writeCollection(`id: foo
name: Foo
readme:
  path: docs/collection-overview.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`);

    const result = validateCollectionFile(tempDir, collectionPath);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a declared README that does not exist', () => {
    const collectionPath = writeCollection(`id: foo
name: Foo
readme:
  path: docs/missing.md
items: []
`);

    const result = validateCollectionFile(tempDir, collectionPath);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('collections/foo.collection.yml: readme referenced file not found: docs/missing.md');
  });

  it('collects an invalid README path without aborting validation of other collections', () => {
    const invalidCollection = writeCollection(`id: foo
name: Foo
readme:
  path: ../README.md
items: []
`);
    const validCollection = path.join('collections', 'bar.collection.yml');
    fs.writeFileSync(path.join(tempDir, validCollection), `id: bar
name: Bar
items: []
`);

    const result = validateAllCollections(tempDir, [invalidCollection, validCollection]);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('readme.path'))).toBe(true);
    expect(result.fileResults).toHaveLength(2);
    expect(result.fileResults[1].collection?.id).toBe('bar');
  });

  it('warns when no README is declared and includes it in markdown output', () => {
    const collectionPath = writeCollection(`id: foo
name: Foo
items: []
`);

    const result = validateAllCollections(tempDir, [collectionPath]);

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('collections/foo.collection.yml: Collection has no readme. Consider adding a readme to help users understand this collection.');
    expect(generateMarkdown(result, 1)).toContain('### Warnings');
  });
});
describe('plugin items', () => {
  const SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  const PREFIX = 'collections/foo.collection.yml: items[0] plugin';
  const validManifest = (name: string): Record<string, unknown> => ({
    $schema: SCHEMA_URI,
    name,
    version: '1.0.0',
    description: 'Test plugin.',
    author: { name: 'Test' }
  });
  const writePlugin = (relDir: string, manifest: unknown): string => {
    fs.mkdirSync(path.join(tempDir, relDir), { recursive: true });
    fs.writeFileSync(path.join(tempDir, relDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
    return `${relDir}/plugin.json`;
  };
  const writeReadme = (): void => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Foo\n');
  };
  const pluginCollection = (itemPath: string, kind = 'plugin', file = 'foo'): string => {
    const content = `id: ${file}
name: ${file}
readme:
  path: README.md
items:
  - path: ${itemPath}
    kind: ${kind}
`;
    const collectionFile = path.join('collections', `${file}.collection.yml`);
    fs.writeFileSync(path.join(tempDir, collectionFile), content);
    return collectionFile;
  };
  beforeEach(writeReadme);

  it('accepts a spec-compliant root plugin manifest without warnings', () => {
    const itemPath = writePlugin('plugins/aph-e2e-plugin', validManifest('aph-e2e-plugin'));
    const result = validateCollectionFile(tempDir, pluginCollection(itemPath));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports a string author as an error prefixed with the item', () => {
    const itemPath = writePlugin('plugins/aph-e2e-plugin', { ...validManifest('aph-e2e-plugin'), author: 'someone' });
    const result = validateCollectionFile(tempDir, pluginCollection(itemPath));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining(`${PREFIX} plugins/aph-e2e-plugin/plugin.json: "author" must be an object`)
    ]);
  });

  it('reports an unknown top-level field as a warning only', () => {
    const itemPath = writePlugin('plugins/aph-e2e-plugin', { ...validManifest('aph-e2e-plugin'), hooks: 'hooks.json' });
    const result = validateCollectionFile(tempDir, pluginCollection(itemPath));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(`${PREFIX} plugins/aph-e2e-plugin/plugin.json: unknown top-level field "hooks"`)
    ]);
  });

  it('rejects a nested manifest that is not at the plugin root', () => {
    const itemPath = writePlugin('plugins/aph-e2e-legacy-nested/.github/plugin', {
      name: 'aph-e2e-legacy-nested',
      version: '1.0.0',
      items: [{ kind: 'skill', path: 'skills/x/SKILL.md' }]
    });
    const result = validateCollectionFile(tempDir, pluginCollection(itemPath));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('missing required field "$schema"'),
      expect.stringContaining('must match its directory "plugin"')
    ]));
    expect(result.warnings).toEqual([expect.stringContaining('unknown top-level field "items"')]);
  });

  it('rejects a manifest whose name differs from its directory', () => {
    const itemPath = writePlugin('plugins', validManifest('aph-scaffolded'));
    const result = validateCollectionFile(tempDir, pluginCollection(itemPath));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining(`${PREFIX} plugins/plugin.json: plugin name "aph-scaffolded" must match its directory "plugins"`)
    ]);
  });

  it('reports only the missing-file error when plugin.json does not exist', () => {
    const result = validateCollectionFile(tempDir, pluginCollection('plugins/missing/plugin.json'));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'collections/foo.collection.yml: items[0] referenced file not found: plugins/missing/plugin.json'
    ]);
  });

  it('reports a directory item path as a manifest-path error without throwing', () => {
    writePlugin('plugins/aph-e2e-plugin', validManifest('aph-e2e-plugin'));
    const result = validateCollectionFile(tempDir, pluginCollection('plugins/aph-e2e-plugin'));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining(`${PREFIX} plugins/aph-e2e-plugin: plugin item path must point to the plugin's root plugin.json`)
    ]);
  });

  it('reports a plugin.json directory as unreadable without throwing', () => {
    fs.mkdirSync(path.join(tempDir, 'plugins', 'odd', 'plugin.json'), { recursive: true });
    const result = validateCollectionFile(tempDir, pluginCollection('plugins/odd/plugin.json'));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('plugin.json is not a readable file')]);
  });

  it('validates plugin items regardless of kind casing', () => {
    const itemPath = writePlugin('plugins/aph-e2e-plugin', { ...validManifest('aph-e2e-plugin'), author: 'someone' });
    const result = validateCollectionFile(tempDir, pluginCollection(itemPath, 'Plugin'));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('"author" must be an object')]);
  });

  it('validates plugin items declared with the plugins kind alias, as bundle build does', () => {
    const itemPath = writePlugin('plugins/aph-e2e-plugin', { ...validManifest('aph-e2e-plugin'), author: 'someone' });
    const result = validateCollectionFile(tempDir, pluginCollection(itemPath, 'plugins'));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('Invalid item kind \'plugins\''),
      expect.stringContaining('plugin plugins/aph-e2e-plugin/plugin.json: "author" must be an object')
    ]);
  });

  it('aggregates plugin warnings across collections', () => {
    const good = writePlugin('plugins/good', validManifest('good'));
    const extra = writePlugin('plugins/extra', { ...validManifest('extra'), hooks: 'hooks.json' });
    const result = validateAllCollections(tempDir, [
      pluginCollection(good, 'plugin', 'one'),
      pluginCollection(extra, 'plugin', 'two')
    ]);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining('collections/two.collection.yml: items[0] plugin plugins/extra/plugin.json: unknown top-level field "hooks"')
    ]);
  });
});
describe('kind/route mismatch', () => {
  const COLLECTION = 'collections/foo.collection.yml';
  const NESTED_SKILL = 'plugins/p/skills/s/SKILL.md';
  const mismatch = (itemPath: string, declaredKind: string, routeKind: string, routePrefix: string): string =>
    `${COLLECTION}: items[0] ${itemPath}: kind "${declaredKind}" differs from the kind "${routeKind}" `
    + `of the install route "${routePrefix}" that this path matches`;
  const writeItem = (itemPath: string): void => {
    fs.mkdirSync(path.dirname(path.join(tempDir, itemPath)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, itemPath), '# Item\n');
  };
  const collectionWith = (itemPath: string, kind: string): string => {
    writeItem(itemPath);
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Foo\n');
    return writeCollection(`id: foo
name: Foo
readme:
  path: README.md
items:
  - path: ${itemPath}
    kind: ${kind}
`);
  };

  it.fails('warns when a skill sits below the plugin route', () => {
    const result = validateCollectionFile(tempDir, collectionWith(NESTED_SKILL, 'skill'));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([mismatch(NESTED_SKILL, 'skill', 'plugin', 'plugins/')]);
  });

  it.fails('warns for a kind that differs only in case, quoting the declared spelling', () => {
    const result = validateCollectionFile(tempDir, collectionWith(NESTED_SKILL, 'Skill'));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([mismatch(NESTED_SKILL, 'Skill', 'plugin', 'plugins/')]);
  });

  it.each([
    ['prompts/x.prompt.md', 'prompt'],
    ['chatmodes/x.chatmode.md', 'chat-mode'],
    ['.kiro/steering/x.md', 'steering']
  ])('does not warn when %s matches its kind %s', (itemPath, kind) => {
    const result = validateCollectionFile(tempDir, collectionWith(itemPath, kind));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['mcp-servers/x.mcp.json', 'mcp-server'],
    ['.github/prompts/x.prompt.md', 'prompt']
  ])('does not warn for the unrouted path %s', (itemPath, kind) => {
    const result = validateCollectionFile(tempDir, collectionWith(itemPath, kind));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['skills', 'Invalid item kind \'skills\''],
    ['chatmode', 'Item kind \'chatmode\' is deprecated']
  ])('reports only the existing error for the invalid kind %s', (kind, error) => {
    const result = validateCollectionFile(tempDir, collectionWith(NESTED_SKILL, kind));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining(error)]);
    expect(result.warnings).toEqual([]);
  });
});
