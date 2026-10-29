/**
 * Domain layer — Collection contribution eligibility, bundle-to-collection ID
 * resolution, primitive path/kind inference, semver bumping, and primitive
 * Markdown frontmatter parsing/serialization.
 *
 * Pure domain functions with zero filesystem or network IO.
 * @module domain/collection/contribution
 */
import * as yaml from 'js-yaml';
import {
  extractBundleIdentity,
} from '../bundle/version';
import {
  githubBundlePrefix,
  hasPathTraversal,
  isValidGitHubOwner,
  isValidGitHubRepo,
  parseGitHubOwnerRepo,
  skillsBundlePrefix,
} from '../hub/validate';
import {
  normalizePrimitiveKind,
  type PrimitiveKind,
} from '../primitive/types';
import {
  generateSanitizedId,
} from '../scaffold';
import type {
  RegistrySource,
} from '../source/types';
import {
  normalizeRepoRelativePath,
} from './validate';

/**
 * Result of checking whether a source qualifies for collection contribution
 * and visual editing.
 */
export interface CollectionContributionEligibility {
  contributable: boolean;
  repositorySlug?: string;
  collectionsPath: string;
  branch?: string;
  reason?: string;
}

const DEFAULT_COLLECTIONS_PATH = 'collections';

const normalizeCollectionsPath = (rawPath?: unknown): string => {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return DEFAULT_COLLECTIONS_PATH;
  }
  try {
    return normalizeRepoRelativePath(rawPath.trim()).replace(/\/+$/, '');
  } catch {
    return DEFAULT_COLLECTIONS_PATH;
  }
};

/**
 * Determine whether a configured registry source is eligible for the
 * Collection Contributor Workflow (`Fork -> Clone -> Branch -> Open PR`) and
 * Visual Collection Editor.
 *
 * Rules:
 * - `artifactory` sources are read-only replicas populated by promotion
 *   (ADR-0008) and are strictly rejected.
 * - `github` and `awesome-copilot` sources are eligible when their `url`
 *   points to a valid GitHub `owner/repo`.
 * - `local` and `local-awesome-copilot` sources are eligible when their local
 *   Git checkout has a valid GitHub `owner/repo` remote (`resolvedGitHubRemoteSlug`).
 * - Non-collection source types (`apm`, `local-apm`, `skills`, `local-skills`,
 *   `azure-devops`) are rejected with an explanatory message.
 * @param source Registry source descriptor.
 * @param source.type
 * @param source.url
 * @param source.config
 * @param resolvedGitHubRemoteSlug Optional `owner/repo` resolved from a local git checkout's remotes.
 * @returns Eligibility verdict, resolved `owner/repo` slug, and `collectionsPath`.
 */
export function isContributableCollectionSource(
  source: Pick<RegistrySource, 'type' | 'url' | 'config'> | undefined | null,
  resolvedGitHubRemoteSlug?: string
): CollectionContributionEligibility {
  const collectionsPath = normalizeCollectionsPath(source?.config?.collectionsPath);
  const branch = typeof source?.config?.branch === 'string' && source.config.branch.trim().length > 0
    ? source.config.branch.trim()
    : undefined;

  if (!source || !source.type) {
    return {
      contributable: false,
      collectionsPath,
      branch,
      reason: 'Source is missing a valid type.'
    };
  }

  if (source.type === 'artifactory') {
    return {
      contributable: false,
      collectionsPath,
      branch,
      reason: 'Artifactory sources are read-only replicas populated by the promotion pipeline and cannot be edited directly.'
    };
  }

  if (source.type === 'github' || source.type === 'awesome-copilot') {
    const parsed = parseGitHubOwnerRepo(source.url ?? '');
    if (
      !parsed
      || (parsed.host !== 'github.com' && !parsed.host.endsWith('.github.com') && !parsed.host.endsWith('.githubusercontent.com'))
      || !isValidGitHubOwner(parsed.owner)
      || !isValidGitHubRepo(parsed.repo)
    ) {
      return {
        contributable: false,
        collectionsPath,
        branch,
        reason: `Source URL '${source.url ?? ''}' is not a valid GitHub repository (expected owner/repo).`
      };
    }

    return {
      contributable: true,
      repositorySlug: `${parsed.owner}/${parsed.repo}`,
      collectionsPath,
      branch
    };
  }

  if (source.type === 'local' || source.type === 'local-awesome-copilot') {
    if (!resolvedGitHubRemoteSlug) {
      return {
        contributable: false,
        collectionsPath,
        branch,
        reason: 'Local collection source is not connected to a GitHub remote repository.'
      };
    }
    const parsed = parseGitHubOwnerRepo(resolvedGitHubRemoteSlug);
    if (!parsed || !isValidGitHubOwner(parsed.owner) || !isValidGitHubRepo(parsed.repo)) {
      return {
        contributable: false,
        collectionsPath,
        branch,
        reason: 'Local collection source does not have a valid GitHub remote (owner/repo).'
      };
    }
    return {
      contributable: true,
      repositorySlug: `${parsed.owner}/${parsed.repo}`,
      collectionsPath,
      branch
    };
  }

  return {
    contributable: false,
    collectionsPath,
    branch,
    reason: `Source type '${source.type}' does not use .collection.yml manifests for collection collaboration.`
  };
}

/**
 * Resolved collection identifier and relative `.collection.yml` manifest path.
 */
export interface ResolvedCollectionTarget {
  collectionId: string;
  collectionFilePath: string;
  collectionsPath: string;
}

/**
 * Resolve the canonical `<collectionId>` and repo-relative `.collection.yml`
 * path from a Marketplace or Registry Explorer bundle identifier.
 *
 * Examples:
 * - `github` source (`https://github.com/acme/my-prompts`):
 *   `acme-my-prompts-python-dev-1.2.0` -> `{ collectionId: 'python-dev', collectionFilePath: 'collections/python-dev.collection.yml' }`
 *   `acme-my-prompts-python-dev` -> `{ collectionId: 'python-dev', collectionFilePath: 'collections/python-dev.collection.yml' }`
 * - `awesome-copilot` source (`config.collectionsPath = 'collections'`):
 *   `python-dev` -> `{ collectionId: 'python-dev', collectionFilePath: 'collections/python-dev.collection.yml' }`
 * @param bundleId Marketplace or installed bundle identifier.
 * @param source Optional source descriptor providing `type`, `url`, and `config.collectionsPath`.
 * @param source.type
 * @param source.url
 * @param source.repository
 * @param source.config
 * @param source.config.collectionsPath
 * @returns Resolved collection ID and relative `.collection.yml` path, or `null` when `bundleId` is empty.
 */
export function resolveCollectionIdFromBundle(
  bundleId: string,
  source?: {
    type?: string;
    url?: string;
    repository?: string;
    config?: { collectionsPath?: string; [key: string]: unknown };
  }
): ResolvedCollectionTarget | null {
  if (typeof bundleId !== 'string' || bundleId.trim().length === 0) {
    return null;
  }

  const collectionsPath = normalizeCollectionsPath(source?.config?.collectionsPath);
  let candidate = bundleId.trim();

  // Strip trailing -vX.Y.Z or -X.Y.Z release suffix first
  candidate = extractBundleIdentity(candidate, 'github').replace(/-v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/i, '');

  const effectiveUrl = typeof source?.url === 'string' && source.url.length > 0
    ? source.url
    : (typeof source?.repository === 'string' && source.repository.length > 0
      ? `https://github.com/${source.repository}`
      : '');

  if (effectiveUrl) {
    const parsed = parseGitHubOwnerRepo(effectiveUrl);
    if (parsed) {
      const ghPrefix = `${parsed.owner}-${parsed.repo}-`;
      const skPrefix = skillsBundlePrefix(effectiveUrl) ?? `skills-${parsed.owner}-${parsed.repo}-`;
      if (candidate.toLowerCase().startsWith(skPrefix.toLowerCase()) && candidate.length > skPrefix.length) {
        candidate = candidate.slice(skPrefix.length);
      } else if (candidate.toLowerCase().startsWith(ghPrefix.toLowerCase()) && candidate.length > ghPrefix.length) {
        candidate = candidate.slice(ghPrefix.length);
      }
    } else {
      const fallbackPrefix = githubBundlePrefix(effectiveUrl);
      if (fallbackPrefix && candidate.toLowerCase().startsWith(fallbackPrefix.toLowerCase()) && candidate.length > fallbackPrefix.length) {
        candidate = candidate.slice(fallbackPrefix.length);
      }
    }
  }

  const sanitized = candidate
    .replace(/\.collection\.ya?ml$/i, '')
    .trim();
  if (!sanitized || hasPathTraversal(sanitized)) {
    return null;
  }

  return {
    collectionId: sanitized,
    collectionsPath,
    collectionFilePath: `${collectionsPath}/${sanitized}.collection.yml`
  };
}

/**
 * Infer a canonical `PrimitiveKind` from a repository-relative file path.
 * @param relPath Repo-relative path (e.g. `prompts/review.prompt.md`, `skills/foo/SKILL.md`).
 * @returns Inferred `PrimitiveKind`, defaulting to `'prompt'` when ambiguous.
 */
export function inferPrimitiveKindFromPath(relPath: string): PrimitiveKind {
  const normalized = relPath.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  const lower = normalized.toLowerCase();

  if (lower.endsWith('/plugin.json') || lower === 'plugin.json' || lower.startsWith('plugins/')) {
    return 'plugin';
  }
  if (lower.endsWith('/skill.md') || lower.endsWith('.skill.md') || lower.startsWith('skills/')) {
    return 'skill';
  }
  if (lower.endsWith('.instructions.md') || lower.endsWith('.instruction.md') || lower.startsWith('instructions/')) {
    return 'instruction';
  }
  if (lower.endsWith('.agent.md') || lower.startsWith('agents/')) {
    return 'agent';
  }
  if (lower.endsWith('.chatmode.md') || lower.startsWith('chat-modes/') || lower.startsWith('chatmodes/')) {
    return 'chat-mode';
  }
  if (lower.endsWith('.hook.json') || lower.startsWith('hooks/')) {
    return 'hook';
  }
  if (lower.endsWith('.mcp.json') || lower.startsWith('mcp-servers/') || lower.startsWith('mcp/')) {
    return 'mcp-server';
  }
  if (lower.startsWith('.kiro/steering/') || lower.startsWith('steering/')) {
    return 'steering';
  }
  if (lower.startsWith('.kiro/specs/') || lower.startsWith('specs/')) {
    return 'spec';
  }
  if (lower.startsWith('.claude/output-styles/') || lower.startsWith('output-styles/')) {
    return 'output-style';
  }
  if (lower.startsWith('.claude/commands/') || lower.startsWith('.cursor/commands/') || lower.startsWith('commands/')) {
    return 'command';
  }
  if (lower.endsWith('.mdc') || lower.startsWith('.cursor/rules/') || lower.startsWith('rules/')) {
    return 'rule';
  }
  if (lower.startsWith('.opencode/tools/') || lower.startsWith('tools/')) {
    return 'tool';
  }
  if (lower.endsWith('/power.md') || lower.startsWith('powers/')) {
    return 'power';
  }
  if (lower.startsWith('knowledge/') || lower.startsWith('.devin/knowledge/')) {
    return 'knowledge';
  }
  if (lower.startsWith('playbooks/') || lower.startsWith('.devin/playbooks/')) {
    return 'playbook';
  }
  return 'prompt';
}

/**
 * Generate the canonical repository-relative path for a newly created primitive
 * of a given `kind` and human name/slug.
 * @param kind Target primitive kind.
 * @param rawName Human-readable name or slug.
 * @returns Canonical repo-relative file path.
 */
export function defaultPathForPrimitiveKind(kind: string, rawName: string): string {
  const slug = generateSanitizedId(rawName) || 'example';
  const normalizedKind = normalizePrimitiveKind(kind) ?? 'prompt';

  switch (normalizedKind) {
    case 'prompt': {
      return `prompts/${slug}.prompt.md`;
    }
    case 'instruction': {
      return `instructions/${slug}.instructions.md`;
    }
    case 'agent': {
      return `agents/${slug}.agent.md`;
    }
    case 'chat-mode': {
      return `chat-modes/${slug}.chatmode.md`;
    }
    case 'skill': {
      return `skills/${slug}/SKILL.md`;
    }
    case 'plugin': {
      return `plugins/${slug}/plugin.json`;
    }
    case 'hook': {
      return `hooks/${slug}.hook.json`;
    }
    case 'mcp-server': {
      return `mcp-servers/${slug}.mcp.json`;
    }
    case 'steering': {
      return `.kiro/steering/${slug}.md`;
    }
    case 'spec': {
      return `.kiro/specs/${slug}/requirements.md`;
    }
    case 'command': {
      return `.claude/commands/${slug}.md`;
    }
    case 'rule': {
      return `.cursor/rules/${slug}.mdc`;
    }
    case 'output-style': {
      return `.claude/output-styles/${slug}.md`;
    }
    case 'tool': {
      return `.opencode/tools/${slug}.ts`;
    }
    case 'power': {
      return `powers/${slug}/POWER.md`;
    }
    case 'knowledge': {
      return `knowledge/${slug}.md`;
    }
    case 'playbook': {
      return `playbooks/${slug}.md`;
    }
  }
}

/**
 * Bump a collection semantic version (`X.Y.Z`) by `'patch'`, `'minor'`, or `'major'`.
 * Falls back to bumping from `'1.0.0'` if the input is undefined or non-semver.
 * @param currentVersion Current version string.
 * @param bump Bump level.
 * @returns Incremented `X.Y.Z` string.
 */
export function bumpCollectionVersion(
  currentVersion: string | undefined,
  bump: 'patch' | 'minor' | 'major'
): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec((currentVersion ?? '').trim());
  if (!match) {
    switch (bump) {
      case 'major': {
        return '2.0.0';
      }
      case 'minor': {
        return '1.1.0';
      }
      case 'patch': {
        return '1.0.1';
      }
    }
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  switch (bump) {
    case 'major': {
      return `${major + 1}.0.0`;
    }
    case 'minor': {
      return `${major}.${minor + 1}.0`;
    }
    case 'patch': {
      return `${major}.${minor}.${patch + 1}`;
    }
  }
}

/**
 * Parsed Markdown primitive content (YAML frontmatter + Markdown body).
 */
export interface ParsedPrimitiveFrontmatter {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  rawFrontmatter?: string;
  parseError?: string;
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/**
 * Parse a Markdown primitive file (`.prompt.md`, `.instructions.md`, `.agent.md`,
 * `SKILL.md`, etc.) into its structured YAML frontmatter object and Markdown body.
 * @param content Raw file content.
 * @returns Parsed frontmatter and body.
 */
export function parsePrimitiveFrontmatter(content: string): ParsedPrimitiveFrontmatter {
  const match = FRONTMATTER_REGEX.exec(content);
  if (!match) {
    return {
      hasFrontmatter: false,
      frontmatter: {},
      body: content
    };
  }

  const [, rawYaml, body] = match;
  let parseError: string | undefined;
  try {
    const parsed = yaml.load(rawYaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        hasFrontmatter: true,
        frontmatter: { ...(parsed as Record<string, unknown>) },
        body,
        rawFrontmatter: rawYaml
      };
    }
    parseError = 'Frontmatter is not a YAML mapping';
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  return {
    hasFrontmatter: true,
    frontmatter: {},
    body,
    rawFrontmatter: rawYaml,
    parseError
  };
}

/**
 * Serialize structured frontmatter fields and a Markdown body back into a
 * well-formed Markdown primitive file.
 *
 * Empty/undefined frontmatter values are pruned; if no frontmatter keys remain
 * and `forceFrontmatter` is false, only the Markdown body is returned.
 * @param frontmatter Frontmatter key-value map (`name`, `description`, `applyTo`, `tools`, `model`, etc.).
 * @param body Markdown body content.
 * @param options Serialization options.
 * @param options.forceFrontmatter Keep `---\n---` even when frontmatter is empty.
 * @returns Formatted Markdown string.
 */
export function serializePrimitiveFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  options?: { forceFrontmatter?: boolean }
): string {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    cleaned[key] = value;
  }

  const normalizedBody = body.replace(/^\r?\n/, '');
  if (Object.keys(cleaned).length === 0 && !options?.forceFrontmatter) {
    return normalizedBody.endsWith('\n') ? normalizedBody : `${normalizedBody}\n`;
  }

  const dumpedFrontmatter = Object.keys(cleaned).length > 0
    ? yaml.dump(cleaned, { indent: 2, lineWidth: -1, noRefs: true }).trimEnd()
    : '';

  const header = dumpedFrontmatter.length > 0
    ? `---\n${dumpedFrontmatter}\n---\n\n`
    : `---\n---\n\n`;

  const full = `${header}${normalizedBody}`;
  return full.endsWith('\n') ? full : `${full}\n`;
}
