import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  applyCollectionYamlMutation,
  indexCollectionYamlRanges,
  locateCollectionYamlCursor,
  summarizeCollectionYamlChanges,
} from '../../src/collection/collection-yaml-document';
import {
  validateCollectionYaml,
} from '../../src/collection/validate-collection-yaml';

const SAMPLE_COLLECTION_YAML = [
  '# yaml-language-server: $schema=../schemas/collection.schema.json',
  '# Python Development Collection',
  'id: python-development',
  'name: Python Development Suite',
  'description: Prompts and skills for Python development',
  'version: 1.2.0',
  'author: Python Team',
  'tags:',
  '  - python',
  '  - testing',
  'readme:',
  '  path: docs/python-development/README.md',
  'display:',
  '  color: "#3776AB"',
  '  icon: python',
  '  ordering: manual',
  '  show_badge: true',
  '# Core items',
  'items:',
  '  - path: prompts/write-tests.prompt.md',
  '    kind: prompt',
  '    title: Test Writer',
  '    description: Generates unit tests',
  '  - path: instructions/standards.instructions.md',
  '    kind: instruction',
  'mcp:',
  '  inputs:',
  '    - id: apiToken',
  '      type: promptString',
  '      description: API token',
  '      password: true',
  '  items:',
  '    python-analyzer:',
  '      type: stdio',
  '      command: python',
  '      args:',
  '        - "${bundlePath}/server.py"'
].join('\n');

describe('collection-yaml-document and validate-collection-yaml', () => {
  it('indexes ranges and locates cursor positions across metadata, readme, display, items, and mcp', () => {
    const ranges = indexCollectionYamlRanges(SAMPLE_COLLECTION_YAML);
    expect(ranges.get('id')?.startLine).toBe(2);
    expect(ranges.get('readme.path')?.startLine).toBe(11);
    expect(ranges.get('display.ordering')?.startLine).toBe(15);
    expect(ranges.get('items.0.path')?.startLine).toBe(19);
    expect(ranges.get('items.1.kind')?.startLine).toBe(24);
    expect(ranges.get('mcp.inputs.0.id')?.startLine).toBe(27);
    expect(ranges.get('mcp.items.python-analyzer')?.startLine).toBe(32);

    expect(locateCollectionYamlCursor(SAMPLE_COLLECTION_YAML, 2)).toEqual({ section: 'metadata' });
    expect(locateCollectionYamlCursor(SAMPLE_COLLECTION_YAML, 11)).toEqual({ section: 'readme' });
    expect(locateCollectionYamlCursor(SAMPLE_COLLECTION_YAML, 15)).toEqual({ section: 'display' });
    expect(locateCollectionYamlCursor(SAMPLE_COLLECTION_YAML, 20)).toEqual({
      section: 'item',
      index: 0,
      path: 'prompts/write-tests.prompt.md',
      kind: 'prompt'
    });
    expect(locateCollectionYamlCursor(SAMPLE_COLLECTION_YAML, 28)).toEqual({
      section: 'mcp-input',
      index: 0,
      id: 'apiToken'
    });
    expect(locateCollectionYamlCursor(SAMPLE_COLLECTION_YAML, 33)).toEqual({
      section: 'mcp-server',
      key: 'python-analyzer'
    });
  });

  it('preserves comments and $schema headers across CRUD mutations', () => {
    let updated = applyCollectionYamlMutation(SAMPLE_COLLECTION_YAML, {
      kind: 'update-metadata',
      metadata: {
        name: 'Python Dev Pro',
        tags: ['python', 'pytest', 'clean-code']
      }
    });
    expect(updated).toContain('# yaml-language-server: $schema=../schemas/collection.schema.json');
    expect(updated).toContain('# Core items');
    expect(updated).toContain('name: Python Dev Pro');

    updated = applyCollectionYamlMutation(updated, {
      kind: 'bump-version',
      bump: 'minor'
    });
    expect(updated).toContain('version: 1.3.0');

    updated = applyCollectionYamlMutation(updated, {
      kind: 'add-item',
      item: {
        path: 'skills/python-refactor/SKILL.md',
        kind: 'skill',
        title: 'Python Refactor'
      }
    });
    expect(updated).toContain('skills/python-refactor/SKILL.md');

    updated = applyCollectionYamlMutation(updated, {
      kind: 'move-item',
      fromIndex: 2,
      toIndex: 0
    });
    const rangesAfterMove = indexCollectionYamlRanges(updated);
    const lines = updated.split('\n');
    expect(lines[rangesAfterMove.get('items.0.path')!.startLine]).toContain('skills/python-refactor/SKILL.md');

    updated = applyCollectionYamlMutation(updated, {
      kind: 'upsert-mcp-server',
      key: 'remote-linter',
      server: {
        type: 'http',
        url: 'https://api.example.com/mcp'
      }
    });
    expect(updated).toContain('remote-linter:');
    expect(updated).toContain('https://api.example.com/mcp');

    const summary = summarizeCollectionYamlChanges(SAMPLE_COLLECTION_YAML, updated);
    expect(summary.collectionId).toBe('python-development');
    expect(summary.metadataChanged).toBe(true);
    expect(summary.itemsAdded).toEqual(['skills/python-refactor/SKILL.md']);
    expect(summary.mcpServersAdded).toEqual(['remote-linter']);
    expect(summary.suggestedCommitMessage).toContain('python-development');
  });

  it('replaces multi-line folded/literal scalar descriptions and quotes YAML-sensitive scalars cleanly', () => {
    const multiLineYaml = [
      'id: multi-line-col',
      'name: Multi Line Collection',
      'description: >-',
      '  First line of folded description',
      '  Second line of folded description',
      'version: 1.0.0',
      'items: []'
    ].join('\n');

    const ranges = indexCollectionYamlRanges(multiLineYaml);
    expect(ranges.get('description')?.startLine).toBe(2);
    expect(ranges.get('description')?.endLine).toBe(4);

    const updated = applyCollectionYamlMutation(multiLineYaml, {
      kind: 'update-metadata',
      metadata: {
        name: 'true',
        description: 'Line 1\nLine 2',
        author: '2026'
      }
    });
    expect(updated).not.toContain('Second line of folded description');
    expect(updated).toContain('name: "true"');
    expect(updated).toContain('author: "2026"');
    expect(updated).toContain('description: "Line 1\\nLine 2"');
  });

  it('produces range-mapped diagnostics, quick fixes, and inline decorations in validateCollectionYaml', () => {
    const invalidYaml = [
      'id: Invalid_ID',
      'name: Duplicate Name',
      'description: Some description',
      'version: v1.0',
      'items:',
      '  - path: prompts/missing.prompt.md',
      '    kind: chatmode',
      '  - path: plugins/my-plugin/SKILL.md',
      '    kind: skill'
    ].join('\n');

    const result = validateCollectionYaml(invalidYaml, {
      fileLabel: 'collections/invalid.collection.yml',
      checkFile: (relPath) => ({
        exists: relPath === 'plugins/my-plugin/SKILL.md',
        isFile: true
      }),
      siblingCollections: [
        {
          file: 'collections/other.collection.yml',
          id: 'other-id',
          name: 'Duplicate Name'
        }
      ]
    });

    expect(result.valid).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('COLLECTION_INVALID_ID');
    expect(codes).toContain('COLLECTION_DUPLICATE_NAME');
    expect(codes).toContain('COLLECTION_INVALID_VERSION');
    expect(codes).toContain('COLLECTION_DEPRECATED_ITEM_KIND');
    expect(codes).toContain('COLLECTION_KIND_ROUTE_MISMATCH');
    expect(codes).toContain('COLLECTION_README_MISSING');

    // Apply quick fixes for ID, version, deprecated kind, and route mismatch
    let fixed = invalidYaml;
    for (const diag of result.diagnostics) {
      if (
        diag.quickFix
        && (
          diag.quickFix.kind === 'sanitize-collection-id'
          || diag.quickFix.kind === 'fix-version'
          || diag.quickFix.kind === 'fix-deprecated-kind'
          || diag.quickFix.kind === 'fix-kind-route'
        )
      ) {
        fixed = applyCollectionYamlMutation(fixed, {
          kind: 'apply-quick-fix',
          quickFix: diag.quickFix
        });
      }
    }

    expect(fixed).toContain('id: invalid-id');
    expect(fixed).toContain('version: 1.0.0');
    expect(fixed).toContain('kind: agent');
    expect(fixed).toContain('kind: plugin');
  });
});
