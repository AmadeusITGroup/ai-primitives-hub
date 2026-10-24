/**
 * Domain layer — the primitive diagnostics fixture repository.
 *
 * The whole fixture repository as data: repository-relative path → bytes
 * plus the intended file mode, including one single-item collection per
 * isolated kind (`collections/aph-e2e-only-<kind>.collection.yml`) and the
 * root `LICENSE`, `README.md` and `package.json` that make `bundle build`
 * take the governed release path.
 *
 * File contents are fixed: the core tests pin the SHA-256 of every
 * archived file, so bundle ids, archive bytes and reports stay comparable
 * across runs. Intended modes are data only: nothing here applies them on
 * disk.
 * @module domain/diagnostics/primitives/fixture
 */
import {
  dump as dumpYaml,
} from 'js-yaml';
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

/** Declaration of one isolated kind's item in the fixture repository. */
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
}

/** The isolated kinds, in `PRIMITIVE_KINDS` order without `plugin`. */
export const PRIMITIVE_FIXTURE_ITEMS: readonly PrimitiveFixtureItem[] = [
  { kind: 'prompt', path: 'prompts/hello-world.prompt.md', expectedId: 'hello-world', unit: 'file', sourcePrefix: 'prompts/' },
  { kind: 'instruction', path: 'instructions/code-style.instructions.md', expectedId: 'code-style', unit: 'file', sourcePrefix: 'instructions/' },
  { kind: 'chat-mode', path: 'chat-modes/review.chatmode.md', expectedId: 'review', unit: 'file', sourcePrefix: 'chat-modes/' },
  { kind: 'agent', path: 'agents/security.agent.md', expectedId: 'security', unit: 'file', sourcePrefix: 'agents/' },
  { kind: 'skill', path: 'skills/standalone-skill/SKILL.md', expectedId: 'standalone-skill', unit: 'directory', sourcePrefix: 'skills/' },
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
const EXECUTABLE_FILES: ReadonlySet<string> = new Set(['skills/standalone-skill/scripts/run.sh']);

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

/**
 * Render the single-item collection YAML of an isolated kind, with the key
 * order `id, name, description, version, author, tags, items`.
 * @param item - Isolated kind declaration.
 * @returns Collection YAML text.
 */
const renderCollection = (item: PrimitiveFixtureItem): string => {
  const id = isolatedBundleId(item.kind);
  const name = `APH e2e only ${item.kind}`;
  return dumpYaml({
    id,
    name,
    description: `${name} (APH plugin-support e2e fixture).`,
    version: '1.0.0',
    author: 'AI Primitives Hub e2e',
    tags: ['aph-e2e'],
    items: [{ path: item.path, kind: item.kind }]
  }, { lineWidth: 200 });
};

/**
 * Repository-relative paths of every item source file in the fixture, sorted.
 * @returns Item source paths.
 */
export const fixtureItemSourcePaths = (): string[] => ITEM_SOURCES.map(([p]) => p).toSorted();

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
  for (const item of PRIMITIVE_FIXTURE_ITEMS) {
    add(collectionFileFor(isolatedBundleId(item.kind)), renderCollection(item));
  }
  return files;
}
