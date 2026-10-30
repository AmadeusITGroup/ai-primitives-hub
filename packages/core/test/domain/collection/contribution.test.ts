import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  bumpCollectionVersion,
  defaultPathForPrimitiveKind,
  inferPrimitiveKindFromPath,
  isContributableCollectionSource,
  parsePrimitiveFrontmatter,
  resolveCollectionIdFromBundle,
  serializePrimitiveFrontmatter,
} from '../../../src/domain/collection/contribution';

describe('collection contribution domain rules', () => {
  describe('isContributableCollectionSource', () => {
    it('qualifies github and awesome-copilot sources with valid GitHub URLs (including dots in repo names)', () => {
      const gh = isContributableCollectionSource({
        type: 'github',
        url: 'https://github.com/Amadeus-xDLC/genai.collections-library'
      });
      expect(gh.contributable).toBe(true);
      expect(gh.repositorySlug).toBe('Amadeus-xDLC/genai.collections-library');
      expect(gh.collectionsPath).toBe('collections');

      const ac = isContributableCollectionSource({
        type: 'awesome-copilot',
        url: 'https://github.com/github/awesome-copilot',
        config: {
          branch: 'develop',
          collectionsPath: 'custom/collections/'
        }
      });
      expect(ac.contributable).toBe(true);
      expect(ac.repositorySlug).toBe('github/awesome-copilot');
      expect(ac.collectionsPath).toBe('custom/collections');
      expect(ac.branch).toBe('develop');
    });

    it('rejects artifactory sources as read-only promoted replicas (ADR-0008)', () => {
      const res = isContributableCollectionSource({
        type: 'artifactory',
        url: 'https://artifactory.example.com/artifactory/ai-primitives'
      });
      expect(res.contributable).toBe(false);
      expect(res.reason).toContain('read-only');
    });

    it('qualifies local and local-awesome-copilot sources only when backed by a GitHub remote slug', () => {
      const withoutRemote = isContributableCollectionSource({
        type: 'local-awesome-copilot',
        url: '/tmp/local-collections'
      });
      expect(withoutRemote.contributable).toBe(false);

      const withRemote = isContributableCollectionSource(
        {
          type: 'local-awesome-copilot',
          url: '/tmp/local-collections'
        },
        'AmadeusITGroup/ai-primitives-hub'
      );
      expect(withRemote.contributable).toBe(true);
      expect(withRemote.repositorySlug).toBe('AmadeusITGroup/ai-primitives-hub');
    });

    it('rejects non-collection source types and malformed URLs', () => {
      expect(
        isContributableCollectionSource({
          type: 'apm',
          url: 'https://github.com/acme/apm-pkg'
        }).contributable
      ).toBe(false);

      expect(
        isContributableCollectionSource({
          type: 'github',
          url: 'https://gitlab.com/acme/repo'
        }).contributable
      ).toBe(false);
    });
  });

  describe('resolveCollectionIdFromBundle', () => {
    it('strips owner-repo prefix and release version suffix for github sources', () => {
      const resolved = resolveCollectionIdFromBundle(
        'AmadeusITGroup-prompt-library-python-dev-v1.2.3',
        {
          type: 'github',
          url: 'https://github.com/AmadeusITGroup/prompt-library'
        }
      );
      expect(resolved).toEqual({
        collectionId: 'python-dev',
        collectionsPath: 'collections',
        collectionFilePath: 'collections/python-dev.collection.yml'
      });
    });

    it('handles repository names containing dots when stripping prefix', () => {
      const resolved = resolveCollectionIdFromBundle(
        'Amadeus-xDLC-genai.prompt-collections-clean-arch-2.0.0',
        {
          type: 'github',
          url: 'https://github.com/Amadeus-xDLC/genai.prompt-collections'
        }
      );
      expect(resolved).toEqual({
        collectionId: 'clean-arch',
        collectionsPath: 'collections',
        collectionFilePath: 'collections/clean-arch.collection.yml'
      });
    });

    it('resolves awesome-copilot bundle IDs with custom collectionsPath', () => {
      const resolved = resolveCollectionIdFromBundle(
        'java-microservices',
        {
          type: 'awesome-copilot',
          url: 'https://github.com/acme/copilot-collections',
          config: { collectionsPath: 'src/collections' }
        }
      );
      expect(resolved).toEqual({
        collectionId: 'java-microservices',
        collectionsPath: 'src/collections',
        collectionFilePath: 'src/collections/java-microservices.collection.yml'
      });
    });

    it('returns null for empty or path-traversal bundle IDs', () => {
      expect(resolveCollectionIdFromBundle('')).toBeNull();
      expect(resolveCollectionIdFromBundle('../secret')).toBeNull();
    });
  });

  describe('inferPrimitiveKindFromPath and defaultPathForPrimitiveKind', () => {
    it('infers all canonical primitive kinds from file paths', () => {
      expect(inferPrimitiveKindFromPath('prompts/write-tests.prompt.md')).toBe('prompt');
      expect(inferPrimitiveKindFromPath('instructions/coding.instructions.md')).toBe('instruction');
      expect(inferPrimitiveKindFromPath('agents/reviewer.agent.md')).toBe('agent');
      expect(inferPrimitiveKindFromPath('chat-modes/architect.chatmode.md')).toBe('chat-mode');
      expect(inferPrimitiveKindFromPath('skills/code-review/SKILL.md')).toBe('skill');
      expect(inferPrimitiveKindFromPath('plugins/my-plugin/plugin.json')).toBe('plugin');
      expect(inferPrimitiveKindFromPath('hooks/pre-commit.hook.json')).toBe('hook');
      expect(inferPrimitiveKindFromPath('mcp-servers/github.mcp.json')).toBe('mcp-server');
      expect(inferPrimitiveKindFromPath('.kiro/steering/api.md')).toBe('steering');
      expect(inferPrimitiveKindFromPath('.kiro/specs/auth/requirements.md')).toBe('spec');
      expect(inferPrimitiveKindFromPath('.claude/commands/deploy.md')).toBe('command');
      expect(inferPrimitiveKindFromPath('.cursor/rules/backend.mdc')).toBe('rule');
      expect(inferPrimitiveKindFromPath('.claude/output-styles/terse.md')).toBe('output-style');
      expect(inferPrimitiveKindFromPath('.opencode/tools/db.py')).toBe('tool');
      expect(inferPrimitiveKindFromPath('powers/stripe/POWER.md')).toBe('power');
      expect(inferPrimitiveKindFromPath('knowledge/onboarding.md')).toBe('knowledge');
      expect(inferPrimitiveKindFromPath('playbooks/incident.md')).toBe('playbook');
    });

    it('generates canonical repo-relative paths for new primitives', () => {
      expect(defaultPathForPrimitiveKind('prompt', 'Code Review Helper')).toBe('prompts/code-review-helper.prompt.md');
      expect(defaultPathForPrimitiveKind('instruction', 'Java Standards')).toBe('instructions/java-standards.instructions.md');
      expect(defaultPathForPrimitiveKind('agent', 'Security Reviewer')).toBe('agents/security-reviewer.agent.md');
      expect(defaultPathForPrimitiveKind('skill', 'API Design')).toBe('skills/api-design/SKILL.md');
      expect(defaultPathForPrimitiveKind('plugin', 'my-plugin')).toBe('plugins/my-plugin/plugin.json');
      expect(defaultPathForPrimitiveKind('hook', 'Pre Commit')).toBe('hooks/pre-commit.hook.json');
    });
  });

  describe('bumpCollectionVersion', () => {
    it('increments patch, minor, and major versions', () => {
      expect(bumpCollectionVersion('1.2.3', 'patch')).toBe('1.2.4');
      expect(bumpCollectionVersion('1.2.3', 'minor')).toBe('1.3.0');
      expect(bumpCollectionVersion('1.2.3', 'major')).toBe('2.0.0');
      expect(bumpCollectionVersion(undefined, 'patch')).toBe('1.0.1');
    });
  });

  describe('parsePrimitiveFrontmatter and serializePrimitiveFrontmatter', () => {
    it('round-trips YAML frontmatter and Markdown body cleanly', () => {
      const raw = [
        '---',
        'name: code-reviewer',
        'description: Reviews pull requests for bugs',
        'applyTo: "**/*.ts"',
        'tools:',
        '  - grep',
        '  - view',
        '---',
        '',
        '# Code Reviewer',
        '',
        'Check every diff carefully.'
      ].join('\n');

      const parsed = parsePrimitiveFrontmatter(raw);
      expect(parsed.hasFrontmatter).toBe(true);
      expect(parsed.frontmatter).toEqual({
        name: 'code-reviewer',
        description: 'Reviews pull requests for bugs',
        applyTo: '**/*.ts',
        tools: ['grep', 'view']
      });
      expect(parsed.body).toBe('\n# Code Reviewer\n\nCheck every diff carefully.');

      const serialized = serializePrimitiveFrontmatter(
        {
          ...parsed.frontmatter,
          description: 'Updated description',
          emptyField: ''
        },
        parsed.body
      );
      expect(serialized).toContain('description: Updated description');
      expect(serialized).not.toContain('emptyField');
      expect(serialized).toContain('# Code Reviewer\n\nCheck every diff carefully.\n');
    });

    it('handles Markdown files without frontmatter', () => {
      const raw = '# Simple README\n\nHello world.\n';
      const parsed = parsePrimitiveFrontmatter(raw);
      expect(parsed.hasFrontmatter).toBe(false);
      expect(parsed.frontmatter).toEqual({});
      expect(parsed.body).toBe(raw);

      const serialized = serializePrimitiveFrontmatter({}, parsed.body);
      expect(serialized).toBe('# Simple README\n\nHello world.\n');
    });

    it('preserves rawFrontmatter and reports parseError when frontmatter YAML is malformed', () => {
      const malformed = [
        '---',
        'name: [unterminated',
        '---',
        '# Body Content'
      ].join('\n');
      const parsed = parsePrimitiveFrontmatter(malformed);
      expect(parsed.hasFrontmatter).toBe(true);
      expect(parsed.rawFrontmatter).toBe('name: [unterminated');
      expect(parsed.parseError).toBeDefined();
      expect(parsed.body).toBe('# Body Content');
    });
  });
});
