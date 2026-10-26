/**
 * Tests for domain/plugin/agent-plugin-spec.ts — the pure Agent Plugins 1.0.0
 * manifest validator and the AI Primitives Hub plugin-root packaging rule.
 *
 * Spec variants follow the study fixture set (02 §6.4); root-rule cases
 * follow 03 §4.3.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AGENT_PLUGIN_AUTHOR_FIELDS,
  AGENT_PLUGIN_MANIFEST_FIELDS,
  AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
  AGENT_PLUGIN_NAME_MAX_LENGTH,
  AGENT_PLUGIN_NAME_PATTERN,
  type AgentPluginIssueCode,
  type AgentPluginValidationResult,
  validateAgentPluginItem,
  validateAgentPluginManifest,
  validateAgentPluginName,
} from '../../../src/domain/plugin/agent-plugin-spec';
import vendoredSchema from '../../../src/public/schemas/agent-plugins/1.0.0/plugin.schema.json';

const BASE_MANIFEST: Record<string, unknown> = {
  $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
  name: 'aph-e2e-plugin',
  version: '1.0.0',
  description: 'E2E fixture plugin for AI Primitives Hub.',
  author: {
    name: 'AI Primitives Hub',
    url: 'https://github.com/AmadeusITGroup/ai-primitives-hub'
  },
  homepage: 'https://agent-plugins.org/specification',
  repository: 'https://github.com/AmadeusITGroup/ai-primitives-hub',
  license: 'MIT',
  keywords: ['aph', 'e2e', 'fixture', 'agent-plugins'],
  extensions: {
    'com.example.client': { hooksEnabled: true }
  }
};
const BASE_PATH = 'plugins/aph-e2e-plugin/plugin.json';
const NESTED_PATH = 'plugins/aph-e2e-legacy-nested/.github/plugin/plugin.json';
const LEGACY_NESTED_MANIFEST = {
  name: 'aph-e2e-legacy-nested',
  description: 'Nested-manifest plugin.',
  version: '1.0.0',
  items: [{ kind: 'skill', path: 'skills/legacy-skill/SKILL.md' }]
};

const withFields = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...BASE_MANIFEST, ...fields });
const without = (field: string): Record<string, unknown> => {
  const copy = { ...BASE_MANIFEST };
  delete copy[field];
  return copy;
};
/**
 * Build a manifest with the given name whose path directory matches it.
 * @param name - Manifest name (also used as the plugin directory name)
 */
const named = (name: unknown): { itemPath: string; manifest: Record<string, unknown> } => ({
  itemPath: `plugins/${String(name)}/plugin.json`,
  manifest: withFields({ name })
});

interface Row {
  case: string;
  itemPath?: string;
  manifest?: unknown;
  manifestText?: string | null;
  valid: boolean;
  fatalCodes?: AgentPluginIssueCode[];
  nonFatalCodes?: AgentPluginIssueCode[];
}

const run = (row: Row): AgentPluginValidationResult => {
  const manifestText = row.manifestText === undefined
    ? JSON.stringify(row.manifest ?? BASE_MANIFEST)
    : row.manifestText;
  return validateAgentPluginItem({ itemPath: row.itemPath ?? BASE_PATH, manifestText });
};
const codes = (result: AgentPluginValidationResult, severity: 'fatal' | 'non-fatal'): string[] =>
  result.issues.filter((i) => i.severity === severity).map((i) => i.code).toSorted();

const ROWS: Row[] = [
  // Spec variants (02 §6.4)
  { case: 'valid-full', valid: true },
  { case: 'valid-minimal', manifest: { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI, name: 'aph-e2e-plugin' }, valid: true },
  { case: 'bad-name', itemPath: 'plugins/APH_E2E/plugin.json', manifest: withFields({ name: 'APH_E2E' }), valid: false, fatalCodes: ['name-invalid'] },
  { case: 'author-string', manifest: withFields({ author: 'someone' }), valid: false, fatalCodes: ['author-invalid'] },
  { case: 'no-schema', manifest: without('$schema'), valid: false, fatalCodes: ['schema-missing'] },
  { case: 'unknown-field', manifest: withFields({ hooks: 'hooks.json' }), valid: true, nonFatalCodes: ['unknown-field'] },
  // $schema
  { case: 'schema-1.1.0', manifest: withFields({ $schema: 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json' }), valid: false, fatalCodes: ['schema-unsupported'] },
  { case: 'schema-non-string', manifest: withFields({ $schema: 1 }), valid: false, fatalCodes: ['schema-unsupported'] },
  // name
  { case: 'name-missing', manifest: without('name'), valid: false, fatalCodes: ['name-missing'] },
  { case: 'name-empty', manifest: withFields({ name: '' }), valid: false, fatalCodes: ['name-invalid'] },
  { case: 'name-number', manifest: withFields({ name: 7 }), valid: false, fatalCodes: ['name-invalid'] },
  ...['a--b', 'a..b', '-ab', 'ab-', 'ab.', 'Ab', 'a'.repeat(65)].map((name): Row => ({
    case: `name-invalid ${name.length > 10 ? `${name.length} chars` : name}`,
    ...named(name),
    valid: false,
    fatalCodes: ['name-invalid']
  })),
  ...['a', 'acme.tools', 'a1-b2.c3', 'a'.repeat(64)].map((name): Row => ({
    case: `name-valid ${name.length > 10 ? `${name.length} chars` : name}`,
    ...named(name),
    valid: true
  })),
  // author
  { case: 'author-extra-field', manifest: withFields({ author: { name: 'x', twitter: '@x' } }), valid: false, fatalCodes: ['author-invalid'] },
  { case: 'author-member-type', manifest: withFields({ author: { name: 1 } }), valid: false, fatalCodes: ['author-invalid'] },
  { case: 'author-array', manifest: withFields({ author: ['x'] }), valid: false, fatalCodes: ['author-invalid'] },
  // field types
  { case: 'version-number', manifest: withFields({ version: 1 }), valid: false, fatalCodes: ['field-type'] },
  { case: 'license-object', manifest: withFields({ license: { id: 'MIT' } }), valid: false, fatalCodes: ['field-type'] },
  { case: 'keywords-string', manifest: withFields({ keywords: 'aph' }), valid: false, fatalCodes: ['field-type'] },
  { case: 'keywords-mixed', manifest: withFields({ keywords: ['a', 1] }), valid: false, fatalCodes: ['field-type'] },
  // extensions (non-fatal)
  { case: 'extensions-array', manifest: withFields({ extensions: [] }), valid: true, nonFatalCodes: ['extensions-not-object'] },
  { case: 'extensions-string', manifest: withFields({ extensions: 'x' }), valid: true, nonFatalCodes: ['extensions-not-object'] },
  { case: 'extension-value-not-object', manifest: withFields({ extensions: { 'com.example.client': true } }), valid: true, nonFatalCodes: ['extension-not-object'] },
  // parsing
  { case: 'invalid-json', manifestText: '{', valid: false, fatalCodes: ['manifest-json'] },
  { case: 'top-level-array', manifestText: '[]', valid: false, fatalCodes: ['manifest-not-object'] },
  { case: 'top-level-null', manifestText: 'null', valid: false, fatalCodes: ['manifest-not-object'] },
  { case: 'unreadable', manifestText: null, valid: false, fatalCodes: ['manifest-unreadable'] },
  // Plugin-root rule (03 §4.3)
  { case: 'nested-no-schema', itemPath: NESTED_PATH, manifest: LEGACY_NESTED_MANIFEST, valid: false, fatalCodes: ['name-directory-mismatch', 'schema-missing'], nonFatalCodes: ['unknown-field'] },
  { case: 'nested-with-schema', itemPath: NESTED_PATH, manifest: withFields({ name: 'aph-e2e-legacy-nested' }), valid: false, fatalCodes: ['name-directory-mismatch'] },
  { case: 'scaffold-flat', itemPath: 'plugins/plugin.json', manifest: withFields({ name: 'aph-scaffolded' }), valid: false, fatalCodes: ['name-directory-mismatch'] },
  { case: 'path-is-directory', itemPath: 'plugins/aph-e2e-plugin', valid: false, fatalCodes: ['manifest-path'] },
  { case: 'path-other-file', itemPath: 'plugins/aph-e2e-plugin/manifest.json', valid: false, fatalCodes: ['manifest-path'] },
  { case: 'path-traversal', itemPath: '../x/plugin.json', valid: false, fatalCodes: ['manifest-path'] },
  { case: 'repo-root', itemPath: 'plugin.json', valid: false, fatalCodes: ['manifest-root'] },
  { case: 'backslash-path', itemPath: 'plugins\\aph-e2e-plugin\\plugin.json', valid: true }
];

describe('validateAgentPluginItem', () => {
  it.each(ROWS)('$case', (row) => {
    const result = run(row);
    expect(result.valid).toBe(row.valid);
    expect(codes(result, 'fatal')).toEqual([...(row.fatalCodes ?? [])].toSorted());
    expect(codes(result, 'non-fatal')).toEqual([...(row.nonFatalCodes ?? [])].toSorted());
  });

  it('returns the plugin root and parsed manifest for a valid plugin', () => {
    const result = run({ case: 'valid', valid: true });
    expect(result.pluginRoot).toBe('plugins/aph-e2e-plugin');
    expect(result.manifest).toEqual(BASE_MANIFEST);
  });

  it('reports the nested manifest directory as the plugin root', () => {
    const result = run({ case: 'nested', itemPath: NESTED_PATH, manifest: LEGACY_NESTED_MANIFEST, valid: false });
    expect(result.pluginRoot).toBe('plugins/aph-e2e-legacy-nested/.github/plugin');
  });

  it('returns a null plugin root when the item path is not a plugin.json', () => {
    const result = run({ case: 'dir', itemPath: 'plugins/aph-e2e-plugin', valid: false });
    expect(result.pluginRoot).toBeNull();
    expect(result.manifest).toBeUndefined();
  });

  it('explains the name/directory mismatch as an APH packaging rule', () => {
    const result = run({ case: 'nested', itemPath: NESTED_PATH, manifest: withFields({ name: 'aph-e2e-legacy-nested' }), valid: false });
    const [issue] = result.issues;
    expect(issue.field).toBe('name');
    expect(issue.message).toContain('plugin name "aph-e2e-legacy-nested" must match its directory "plugin"');
    expect(issue.message).toContain('AI Primitives Hub packaging rule');
  });

  it('names the exact $schema URI when it is missing', () => {
    const result = run({ case: 'no-schema', manifest: without('$schema'), valid: false });
    expect(result.issues[0].message).toContain(`"${AGENT_PLUGIN_MANIFEST_SCHEMA_URI}"`);
  });

  it('keeps root-rule messages generic (no legacy layout names, no item path)', () => {
    const rootRows = ROWS.filter((r) => ['nested-no-schema', 'nested-with-schema', 'scaffold-flat', 'repo-root'].includes(r.case));
    for (const row of rootRows) {
      for (const issue of run(row).issues) {
        // The echoed manifest name is author data (the fixture's name contains "legacy").
        const name = (row.manifest as { name?: string } | undefined)?.name ?? '';
        const ownText = name ? issue.message.replaceAll(`"${name}"`, '"<name>"') : issue.message;
        expect(ownText).not.toContain('.github');
        expect(ownText.toLowerCase()).not.toContain('legacy');
        // A bare "plugin.json" (repo-root row) is the file name itself, not a path echo.
        if (row.itemPath?.includes('/')) {
          expect(ownText).not.toContain(row.itemPath);
        }
      }
    }
  });
});

describe('validateAgentPluginManifest', () => {
  it('returns no issues for a spec-compliant manifest', () => {
    expect(validateAgentPluginManifest(BASE_MANIFEST)).toEqual([]);
  });

  it('never applies the name/directory packaging rule', () => {
    const issues = validateAgentPluginManifest(LEGACY_NESTED_MANIFEST);
    expect(issues.map((i) => i.code)).not.toContain('name-directory-mismatch');
  });

  it('rejects a non-object manifest', () => {
    expect(validateAgentPluginManifest([]).map((i) => i.code)).toEqual(['manifest-not-object']);
  });
});

describe('validateAgentPluginName', () => {
  it.each(['a', 'acme.tools', 'my-plugin', 'a'.repeat(AGENT_PLUGIN_NAME_MAX_LENGTH)])('accepts %j', (name) => {
    expect(validateAgentPluginName(name)).toBeNull();
  });

  it.each<unknown>(['My_Plugin', '', 'a--b', 'a..b', '-ab', 'a'.repeat(AGENT_PLUGIN_NAME_MAX_LENGTH + 1), 7])(
    'rejects %j as a fatal name-invalid issue',
    (name) => {
      expect(validateAgentPluginName(name)).toMatchObject({ severity: 'fatal', code: 'name-invalid', field: 'name' });
    }
  );

  it('quotes the rejected value in the message', () => {
    expect(validateAgentPluginName('My_Plugin')?.message).toContain('got "My_Plugin"');
  });

  it('is the rule validateAgentPluginManifest applies to "name"', () => {
    const issue = validateAgentPluginName('My_Plugin');
    const fromManifest = validateAgentPluginManifest({ ...BASE_MANIFEST, name: 'My_Plugin' })
      .find((i) => i.field === 'name');
    expect(fromManifest).toEqual(issue);
  });
});

describe('vendored schema parity', () => {
  const props = vendoredSchema.properties;

  it('matches the $schema URI', () => {
    expect(props.$schema.const).toBe(AGENT_PLUGIN_MANIFEST_SCHEMA_URI);
  });

  it('matches the name pattern and length bounds', () => {
    expect(props.name.pattern).toBe(AGENT_PLUGIN_NAME_PATTERN.source);
    expect(props.name.maxLength).toBe(AGENT_PLUGIN_NAME_MAX_LENGTH);
    expect(props.name.minLength).toBe(1);
  });

  it('matches the allowed top-level and author fields', () => {
    expect(new Set(Object.keys(props))).toEqual(new Set(AGENT_PLUGIN_MANIFEST_FIELDS));
    expect(new Set(Object.keys(props.author.properties))).toEqual(new Set(AGENT_PLUGIN_AUTHOR_FIELDS));
    expect(props.author.additionalProperties).toBe(false);
  });

  it('matches required fields and closed top level', () => {
    expect(vendoredSchema.required).toEqual(['$schema', 'name']);
    expect(vendoredSchema.additionalProperties).toBe(false);
  });
});
