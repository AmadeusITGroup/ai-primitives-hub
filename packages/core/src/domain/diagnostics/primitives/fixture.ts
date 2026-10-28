/**
 * Domain layer — the primitive diagnostics fixture repository.
 *
 * The whole fixture repository as data: repository-relative path → bytes
 * plus the intended file mode. It holds one collection per bundle
 * (`collections/<bundle id>.collection.yml`): a single-item collection per
 * kind (`aph-e2e-only-<kind>`), the mixed-kind collections and the invalid
 * Agent Plugin collections, plus the root `LICENSE`, `README.md` and
 * `package.json` that make `bundle build` take the governed release path.
 *
 * File contents are fixed: the core tests pin the SHA-256 of every
 * archived file, so bundle ids, archive bytes and reports stay comparable
 * across runs. Intended modes are data only: the diagnostics commit the
 * executable files as such (`commitFixtureRepository`).
 * @module domain/diagnostics/primitives/fixture
 */
import {
  dump as dumpYaml,
} from 'js-yaml';
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
} from '../../plugin/agent-plugin-spec';
import type {
  PrimitiveKind,
} from '../../primitive/types';

/** One fixture file: its bytes and its intended mode. */
export interface FixtureFile {
  bytes: Uint8Array;
  mode: 0o644 | 0o755;
}

/** Fixture remote; its `package.json` `repository.url` and git `origin`. */
export const PRIMITIVE_FIXTURE_REPOSITORY_URL = 'https://github.com/example/aph-e2e-fixture.git';

/** Components an Agent Plugin item declares, checked for projection on install. */
export interface PluginComponents {
  /** Skill names under `<plugin root>/skills/<name>/`. */
  skills: readonly string[];
  /** MCP server names in `<plugin root>/mcp.json`. */
  mcpServers: readonly string[];
}

/** Declaration of one item in the fixture repository. */
export interface PrimitiveFixtureItem {
  kind: PrimitiveKind;
  /** Collection item path (entry point). */
  path: string;
  /** Manifest id the item is expected to get. */
  expectedId: string;
  /** `directory`: the item is the whole tree under `dirname(path)`. */
  unit: 'file' | 'directory';
  /** Source-side prefix the placement oracle strips. */
  sourcePrefix: string;
  /** Plugin items only: the components the plugin ships. */
  plugin?: PluginComponents;
}

/** Placeholder an Agent Plugin uses for its installed root directory. */
export const PLUGIN_ROOT_PLACEHOLDER = '${PLUGIN_ROOT}';

/** Name of the fixture Agent Plugin's MCP server. */
const PLUGIN_MCP_SERVER = 'aph-e2e';

/** One item per kind, in `PRIMITIVE_KINDS` order: the isolated bundles, reused by the mixed bundles. */
export const PRIMITIVE_FIXTURE_ITEMS: readonly PrimitiveFixtureItem[] = [
  { kind: 'prompt', path: 'prompts/hello-world.prompt.md', expectedId: 'hello-world', unit: 'file', sourcePrefix: 'prompts/' },
  { kind: 'instruction', path: 'instructions/code-style.instructions.md', expectedId: 'code-style', unit: 'file', sourcePrefix: 'instructions/' },
  { kind: 'chat-mode', path: 'chat-modes/review.chatmode.md', expectedId: 'review', unit: 'file', sourcePrefix: 'chat-modes/' },
  { kind: 'agent', path: 'agents/security.agent.md', expectedId: 'security', unit: 'file', sourcePrefix: 'agents/' },
  { kind: 'skill', path: 'skills/standalone-skill/SKILL.md', expectedId: 'standalone-skill', unit: 'directory', sourcePrefix: 'skills/' },
  // A spec-compliant Agent Plugins 1.0.0 plugin: root plugin.json, a nested skill, a root mcp.json and an executable script.
  {
    kind: 'plugin',
    path: 'plugins/aph-e2e-plugin/plugin.json',
    expectedId: 'aph-e2e-plugin',
    unit: 'directory',
    sourcePrefix: 'plugins/',
    plugin: { skills: ['plugin-skill'], mcpServers: [PLUGIN_MCP_SERVER] }
  },
  { kind: 'hook', path: 'hooks/pre-commit.hook.json', expectedId: 'pre-commit', unit: 'file', sourcePrefix: 'hooks/' },
  { kind: 'mcp-server', path: 'mcp-servers/github.mcp.json', expectedId: 'github', unit: 'file', sourcePrefix: 'mcp-servers/' },
  { kind: 'steering', path: '.kiro/steering/api-standards.md', expectedId: 'api-standards', unit: 'file', sourcePrefix: '.kiro/steering/' },
  { kind: 'spec', path: '.kiro/specs/feature/requirements.md', expectedId: 'feature', unit: 'file', sourcePrefix: '.kiro/specs/' },
  { kind: 'command', path: '.claude/commands/deploy.md', expectedId: 'deploy', unit: 'file', sourcePrefix: '.claude/commands/' },
  { kind: 'rule', path: '.cursor/rules/backend.mdc', expectedId: 'backend', unit: 'file', sourcePrefix: '.cursor/rules/' },
  { kind: 'output-style', path: '.claude/output-styles/terse.md', expectedId: 'terse', unit: 'file', sourcePrefix: '.claude/output-styles/' },
  { kind: 'tool', path: '.opencode/tools/database.py', expectedId: 'database', unit: 'file', sourcePrefix: '.opencode/tools/' },
  // The power is a directory unit (POWER.md + steering/); the build drops it to POWER.md today (power-directory-unit gap).
  { kind: 'power', path: 'powers/stripe/POWER.md', expectedId: 'stripe', unit: 'directory', sourcePrefix: 'powers/' },
  { kind: 'knowledge', path: 'knowledge/onboarding.md', expectedId: 'onboarding', unit: 'file', sourcePrefix: 'knowledge/' },
  { kind: 'playbook', path: 'playbooks/bug-fix.md', expectedId: 'bug-fix', unit: 'file', sourcePrefix: 'playbooks/' }
];

/** A bundle of several `PRIMITIVE_FIXTURE_ITEMS`, one per listed kind, in `PRIMITIVE_KINDS` order. */
export interface PrimitiveMixedBundle {
  id: string;
  name: string;
  kinds: readonly PrimitiveKind[];
}

/** The mixed-kind bundles. */
export const PRIMITIVE_MIXED_BUNDLES: readonly PrimitiveMixedBundle[] = [
  { id: 'aph-e2e-mix-portable', name: 'APH e2e mix portable', kinds: ['prompt', 'instruction', 'agent', 'skill', 'plugin', 'hook'] },
  { id: 'aph-e2e-mix-all-kinds', name: 'APH e2e mix all kinds', kinds: PRIMITIVE_FIXTURE_ITEMS.map((item) => item.kind) }
];

/** An invalid Agent Plugin bundle: one plugin item that `collection validate` and `bundle build` must reject. */
export interface PrimitiveInvalidPluginBundle {
  id: string;
  name: string;
  item: PrimitiveFixtureItem;
  /** The documented validation message for the item (without the collection and item prefix). */
  issue: string;
}

/** The invalid Agent Plugin bundles, each with exactly one fatal manifest issue. */
export const PRIMITIVE_INVALID_PLUGIN_BUNDLES: readonly PrimitiveInvalidPluginBundle[] = [
  {
    id: 'aph-e2e-bad-plugin-no-schema',
    name: 'APH e2e invalid plugin no schema',
    item: { kind: 'plugin', path: 'plugins/aph-e2e-no-schema/plugin.json', expectedId: 'aph-e2e-no-schema', unit: 'directory', sourcePrefix: 'plugins/' },
    issue: 'missing required field "$schema"; set it to "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"'
  },
  {
    id: 'aph-e2e-bad-plugin-name',
    name: 'APH e2e invalid plugin name',
    item: { kind: 'plugin', path: 'plugins/aph-e2e--bad-name/plugin.json', expectedId: 'aph-e2e--bad-name', unit: 'directory', sourcePrefix: 'plugins/' },
    issue: '"name" must be 1-64 characters of lowercase letters, digits, "." or "-", start and end with a letter or digit, '
      + 'and contain no "--" or ".." (got "aph-e2e--bad-name")'
  },
  {
    id: 'aph-e2e-bad-plugin-author',
    name: 'APH e2e invalid plugin author',
    item: { kind: 'plugin', path: 'plugins/aph-e2e-string-author/plugin.json', expectedId: 'aph-e2e-string-author', unit: 'directory', sourcePrefix: 'plugins/' },
    issue: '"author" must be an object with optional string fields "name", "email", "url" (got a string)'
  },
  {
    // plugin.json is not at the plugin root: the item's directory is taken as the root and its name does not match.
    id: 'aph-e2e-bad-plugin-nested-manifest',
    name: 'APH e2e invalid plugin nested manifest',
    item: {
      kind: 'plugin',
      path: 'plugins/aph-e2e-nested-manifest/meta/plugin.json',
      expectedId: 'aph-e2e-nested-manifest',
      unit: 'directory',
      sourcePrefix: 'plugins/'
    },
    issue: 'plugin name "aph-e2e-nested-manifest" must match its directory "meta" (AI Primitives Hub packaging rule: '
      + 'the plugin root is the directory that contains plugin.json, and it is bundled and installed under that directory name). '
      + 'Rename the directory or the "name" field, and keep plugin.json at the plugin root'
  }
];

/**
 * Bundle (= collection) id of the isolated bundle for a kind.
 * @param kind - Isolated kind.
 * @returns `aph-e2e-only-<kind>`.
 */
export const isolatedBundleId = (kind: PrimitiveKind): string => `aph-e2e-only-${kind}`;

/**
 * Collection file of a bundle.
 * @param bundleId - Bundle id.
 * @returns `collections/<id>.collection.yml`.
 */
export const collectionFileFor = (bundleId: string): string => `collections/${bundleId}.collection.yml`;

const md = (title: string, body: string): string => `# ${title}\n\n${body.trim()}\n`;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Text file content from its lines (with a trailing newline).
 * @param lines - Lines of the file.
 * @returns The content.
 */
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

/** Item source files (path → content). */
const ITEM_SOURCES: readonly (readonly [string, string])[] = [
  ['prompts/hello-world.prompt.md', text(
    '---', 'description: Greet the user and summarise the open file.', 'agent: agent', '---', '# Hello world prompt', '',

    'Say hello and summarise ${file} in three bullet points.'
  )],
  ['instructions/code-style.instructions.md', text(
    '---', 'description: House code style.', 'applyTo: "**/*.ts"', '---', '# Code style instructions', '',
    '- Prefer named exports.', '- Keep functions under 40 lines.'
  )],
  ['chat-modes/review.chatmode.md', text(
    '---', 'description: Strict reviewer chat mode.', 'tools: [\'codebase\', \'search\']', '---', '# Review chat mode', '',
    'You are a strict code reviewer. Ask for tests.'
  )],
  ['agents/security.agent.md', text(
    '---', 'name: security', 'description: Security-focused review agent.', 'tools: [\'codebase\']', '---', '# Security agent', '',
    'Look for injection, secrets in code and missing authz checks.'
  )],
  ['skills/standalone-skill/SKILL.md', text(
    '---', 'name: standalone-skill',
    'description: Standalone (non-plugin) skill used to compare skill vs plugin handling. Use when asked to run the APH e2e skill.',
    '---', '# Standalone skill', '', 'Run `scripts/run.sh` and read [the guide](references/guide.md).'
  )],
  ['skills/standalone-skill/scripts/run.sh', text('#!/usr/bin/env sh', '# standalone-skill', 'echo "standalone skill ran"')],
  ['skills/standalone-skill/references/guide.md', md('Standalone skill guide', 'Nothing to see here — fixture reference file.')],
  ['plugins/aph-e2e-plugin/plugin.json', json({
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
    name: 'aph-e2e-plugin',
    version: '1.0.0',
    description: 'Agent Plugin used by the APH e2e diagnostics: a nested skill, an MCP server and a launch script.',
    author: { name: 'AI Primitives Hub e2e' },
    license: 'MIT',
    keywords: ['aph-e2e']
  })],
  ['plugins/aph-e2e-plugin/mcp.json', json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      [PLUGIN_MCP_SERVER]: {
        type: 'stdio',
        command: './scripts/launch.sh',
        args: ['--root', PLUGIN_ROOT_PLACEHOLDER],
        env: { APH_E2E_PLUGIN_ROOT: PLUGIN_ROOT_PLACEHOLDER },
        cwd: PLUGIN_ROOT_PLACEHOLDER
      }
    }
  })],
  ['plugins/aph-e2e-plugin/scripts/launch.sh', text(
    '#!/usr/bin/env sh', '# Launch the APH e2e MCP server from the plugin root.', `exec echo "aph-e2e plugin root: ${PLUGIN_ROOT_PLACEHOLDER}"`
  )],
  ['plugins/aph-e2e-plugin/skills/plugin-skill/SKILL.md', text(
    '---', 'name: plugin-skill',
    'description: Skill shipped inside the APH e2e Agent Plugin. Use when asked to run the APH e2e plugin skill.',
    '---', '# Plugin skill', '', 'Run the plugin\'s `scripts/launch.sh`.'
  )],
  ['plugins/aph-e2e-no-schema/plugin.json', json({ name: 'aph-e2e-no-schema', description: 'Invalid: no $schema.' })],
  ['plugins/aph-e2e--bad-name/plugin.json', json({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI, name: 'aph-e2e--bad-name' })],
  ['plugins/aph-e2e-string-author/plugin.json', json({
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI, name: 'aph-e2e-string-author', author: 'AI Primitives Hub e2e'
  })],
  ['plugins/aph-e2e-nested-manifest/meta/plugin.json', json({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI, name: 'aph-e2e-nested-manifest' })],
  ['plugins/aph-e2e-nested-manifest/skills/nested-skill/SKILL.md', text(
    '---', 'name: nested-skill', 'description: Skill of an invalid plugin whose plugin.json is not at its root. Use when testing.', '---',
    '# Nested skill'
  )],
  ['hooks/pre-commit.hook.json', json({
    name: 'pre-commit',
    description: 'Run the formatter before commit.',
    version: 1,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npx prettier --check .' }] }] }
  })],
  ['mcp-servers/github.mcp.json', json({
    name: 'github',
    description: 'GitHub MCP server item.',
    servers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } }
  })],
  ['.kiro/steering/api-standards.md', text(
    '---', 'inclusion: always', '---', '# API standards steering', '', 'All endpoints return RFC 7807 problem details on error.'
  )],
  ['.kiro/specs/feature/requirements.md', md('Feature requirements (spec)', '## Requirement 1\n\nWHEN a user uploads a bundle THEN the system SHALL validate it.')],
  ['.claude/commands/deploy.md', text(
    '---', 'description: Deploy the current branch.', '---', '# Deploy command', '', 'Run the deploy pipeline for $ARGUMENTS.'
  )],
  ['.cursor/rules/backend.mdc', text(
    '---', 'description: Backend rules', 'globs: ["src/server/**"]', 'alwaysApply: false', '---', '# Backend rule', '',
    'Use the repository pattern for data access.'
  )],
  ['.claude/output-styles/terse.md', text(
    '---', 'name: terse', 'description: Terse answers.', '---', '# Terse output style', '', 'Answer in at most three sentences.'
  )],
  ['.opencode/tools/database.py', text(
    '# database tool (opencode)', '"""Query the fixture database."""', '', 'def run(query: str) -> str:', '    return f"would run: {query}"'
  )],
  ['powers/stripe/POWER.md', text(
    '---', 'name: stripe', 'displayName: Stripe power', 'description: Stripe payments power.', 'keywords: [payments]', '---',
    '# Stripe power', '', 'Use the Stripe MCP server for payments.'
  )],
  ['powers/stripe/steering/payments.md', md('Stripe power steering', 'Always use idempotency keys.')],
  ['knowledge/onboarding.md', md('Onboarding knowledge', 'The fixture repo has one service and one database.')],
  ['playbooks/bug-fix.md', md('Bug-fix playbook', '1. Reproduce. 2. Write a failing test. 3. Fix. 4. Verify.')]
];

/** Item source files whose intended mode is executable. */
const EXECUTABLE_FILES: ReadonlySet<string> = new Set([
  'plugins/aph-e2e-plugin/scripts/launch.sh',
  'skills/standalone-skill/scripts/run.sh'
]);

/** Repository root files that make `bundle build` take the governed path. */
const ROOT_FILES: readonly (readonly [string, string])[] = [
  ['LICENSE', 'MIT License\n\nCopyright (c) 2026 AI Primitives Hub — aph-e2e fixture repository root\n'],
  ['README.md', md(
    'APH e2e fixture repository',
    'Generated by `ai-primitives-hub doctor diagnostics --primitives`. Do not edit by hand.'
  )],
  ['package.json', json({
    name: 'aph-e2e-fixture',
    private: true,
    version: '1.0.0',
    repository: { type: 'git', url: PRIMITIVE_FIXTURE_REPOSITORY_URL }
  })]
];

/** One fixture collection: its id, display name and items. */
export interface PrimitiveFixtureCollection {
  id: string;
  name: string;
  items: readonly PrimitiveFixtureItem[];
}

/**
 * Items of a mixed bundle.
 * @param bundle - Mixed bundle declaration.
 * @returns The fixture item of each listed kind, in `PRIMITIVE_FIXTURE_ITEMS` order.
 */
export const mixedBundleItems = (bundle: PrimitiveMixedBundle): PrimitiveFixtureItem[] =>
  PRIMITIVE_FIXTURE_ITEMS.filter((item) => bundle.kinds.includes(item.kind));

/**
 * Every fixture collection, in catalogue order: the isolated bundles, the
 * mixed bundles, then the invalid plugin bundles.
 * @returns Collections.
 */
export const primitiveFixtureCollections = (): PrimitiveFixtureCollection[] => [
  ...PRIMITIVE_FIXTURE_ITEMS.map((item) => ({ id: isolatedBundleId(item.kind), name: `APH e2e only ${item.kind}`, items: [item] })),
  ...PRIMITIVE_MIXED_BUNDLES.map((bundle) => ({ id: bundle.id, name: bundle.name, items: mixedBundleItems(bundle) })),
  ...PRIMITIVE_INVALID_PLUGIN_BUNDLES.map((bundle) => ({ id: bundle.id, name: bundle.name, items: [bundle.item] }))
];

/**
 * Render a collection YAML, with the key order
 * `id, name, description, version, author, tags, items`.
 * @param collection - Collection declaration.
 * @returns Collection YAML text.
 */
const renderCollection = (collection: PrimitiveFixtureCollection): string => dumpYaml({
  id: collection.id,
  name: collection.name,
  description: `${collection.name} (APH plugin-support e2e fixture).`,
  version: '1.0.0',
  author: 'AI Primitives Hub e2e',
  tags: ['aph-e2e'],
  items: collection.items.map((item) => ({ path: item.path, kind: item.kind }))
}, { lineWidth: 200 });

/**
 * Repository-relative paths of every item source file in the fixture, sorted.
 * @returns Item source paths.
 */
export const fixtureItemSourcePaths = (): string[] => ITEM_SOURCES.map(([p]) => p).toSorted();

/**
 * Item source files whose intended mode is executable, sorted.
 * @returns Executable item source paths.
 */
export const fixtureExecutablePaths = (): string[] => [...EXECUTABLE_FILES].toSorted();

/**
 * Build the whole fixture repository, including `collections/*.yml`.
 * @returns Repository-relative path → file. A fresh map on each call.
 */
export function buildPrimitiveFixture(): ReadonlyMap<string, FixtureFile> {
  const encoder = new TextEncoder();
  const files = new Map<string, FixtureFile>();
  const add = (filePath: string, content: string): void => {
    files.set(filePath, { bytes: encoder.encode(content), mode: EXECUTABLE_FILES.has(filePath) ? 0o755 : 0o644 });
  };
  for (const [filePath, content] of ROOT_FILES) {
    add(filePath, content);
  }
  for (const [filePath, content] of ITEM_SOURCES) {
    add(filePath, content);
  }
  for (const collection of primitiveFixtureCollections()) {
    add(collectionFileFor(collection.id), renderCollection(collection));
  }
  return files;
}
