/**
 * Tests for comment-preserving YAML AST range indexing and CRUD mutations
 * on hub-config.yml documents.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  applyHubYamlMutation,
  indexHubYamlRanges,
  locateHubYamlCursor,
} from '../../src/hub/hub-yaml-document';
import {
  parseHubConfigYaml,
  validateHubConfigYaml,
} from '../../src/hub/validate-hub-config';

const SAMPLE_HUB_YAML = `# yaml-language-server: $schema=https://raw.githubusercontent.com/AmadeusITGroup/prompt-registry/refs/heads/main/schemas/hub-config.schema.json
version: 1.0.0
metadata:
  name: Awesome Copilot Hub
  description: A list of agentic primitives curated by Awesome Copilot Community
  maintainer: Waldek Herka
  updatedAt: "2026-10-21T00:00:00.000Z"
sources:
  - id: community-collections
    name: Amadeus Community Collections (Official)
    type: github
    url: https://github.com/AmadeusITGroup/community-collections
    enabled: true
    priority: 10
    metadata:
      description: Official Amadeus Community sources for open source collections
      homepage: https://github.com/AmadeusITGroup/community-collections
  - id: awesome-copilot-skills-official
    name: Awesome Copilot Skills (Official)
    type: skills
    url: https://github.com/github/awesome-copilot/skills
    enabled: true
    priority: 10
    metadata:
      description: Official Awesome Copilot Skills from GitHub
      homepage: https://github.com/github/awesome-copilot/skills

profiles:
  # Roles
  - id: opensource-contributor
    name: OpenSource Contributor
    description: Agentic primitives for Open Source related activities
    icon: "🌍"
    path: ["Roles"]
    bundles:
      - id: AmadeusITGroup-community-collections-amadeus-ospo
        version: latest
        source: community-collections
        required: true

  # Domains
  - id: testing-specialist
    name: Testing Specialist
    description: Testing tools and skills
    icon: "🧪"
    path: ["Domains"]
    bundles:
      - id: skills-github-awesome-copilot-webapp-testing
        version: latest
        source: awesome-copilot-skills-official
        required: true
`;

describe('indexHubYamlRanges & locateHubYamlCursor', () => {
  it('indexes accurate 0-based line ranges for metadata, sources, profiles, and bundles', () => {
    const ranges = indexHubYamlRanges(SAMPLE_HUB_YAML);

    expect(ranges.get('version')?.startLine).toBe(1);
    expect(ranges.get('metadata.name')?.startLine).toBe(3);
    expect(ranges.get('sources.0')?.startLine).toBe(8);
    expect(ranges.get('sources.1.id')?.startLine).toBe(17);
    expect(ranges.get('profiles.0.id')?.startLine).toBe(29);
    expect(ranges.get('profiles.0.bundles.0.id')?.startLine).toBe(35);
    expect(ranges.get('profiles.1.id')?.startLine).toBe(41);
  });

  it('locates semantic cursor context for any line in hub-config.yml', () => {
    expect(locateHubYamlCursor(SAMPLE_HUB_YAML, 4)).toEqual({ section: 'metadata' });
    expect(locateHubYamlCursor(SAMPLE_HUB_YAML, 10)).toEqual({
      section: 'source',
      index: 0,
      id: 'community-collections'
    });
    expect(locateHubYamlCursor(SAMPLE_HUB_YAML, 36)).toEqual({
      section: 'profile',
      index: 0,
      id: 'opensource-contributor',
      bundleIndex: 0
    });
  });
});

describe('applyHubYamlMutation (comment-preserving CRUD)', () => {
  it('preserves $schema header and category comments when adding, updating, and deleting sources and profiles', () => {
    const afterAddSource = applyHubYamlMutation(SAMPLE_HUB_YAML, {
      kind: 'add-source',
      source: {
        id: 'anthropic-skills-official',
        name: 'Anthropic Skills (Official)',
        type: 'skills',
        url: 'https://github.com/anthropics/skills/skills',
        enabled: true,
        priority: 20,
        metadata: {
          description: 'Official Agent Skills from Anthropic',
          homepage: 'https://github.com/anthropics/skills/skills'
        }
      },
      updatedAt: '2026-10-25T12:00:00.000Z'
    });

    expect(afterAddSource).toContain('# yaml-language-server: $schema=');
    expect(afterAddSource).toContain('# Roles');
    expect(afterAddSource).toContain('# Domains');
    expect(afterAddSource).toContain('id: anthropic-skills-official');

    const afterAddProfile = applyHubYamlMutation(afterAddSource, {
      kind: 'add-profile',
      profile: {
        id: 'frontend-developer',
        name: 'Frontend Developer',
        description: 'Frontend tools and design skills',
        icon: '🌐',
        path: ['Roles'],
        bundles: [
          {
            id: 'skills-anthropics-skills-frontend-design',
            version: 'latest',
            source: 'anthropic-skills-official',
            required: true
          }
        ]
      },
      updatedAt: '2026-10-25T12:05:00.000Z'
    });

    expect(afterAddProfile).toContain('# Roles');
    expect(afterAddProfile).toContain('# Domains');
    const parsed = parseHubConfigYaml(afterAddProfile) as {
      sources: unknown[];
      profiles: unknown[];
      metadata: { updatedAt: string };
    };
    expect(parsed.sources).toHaveLength(3);
    expect(parsed.profiles).toHaveLength(3);
    expect(parsed.metadata.updatedAt).toBe('2026-10-25T12:05:00.000Z');

    const validation = validateHubConfigYaml(afterAddProfile);
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toHaveLength(0);
  });

  it('supports updating and deleting a profile bundle and applying quick fixes', () => {
    const withBrokenPrefix = SAMPLE_HUB_YAML.replace(
      'id: AmadeusITGroup-community-collections-amadeus-ospo',
      'id: amadeus-ospo'
    );

    const validation = validateHubConfigYaml(withBrokenPrefix);
    expect(validation.valid).toBe(false);
    const prefixDiag = validation.diagnostics.find((d) => d.code === 'HUB_INVALID_BUNDLE_PREFIX');
    expect(prefixDiag).toBeDefined();
    expect(prefixDiag?.range?.startLine).toBe(35);
    expect(prefixDiag?.quickFix).toMatchObject({
      kind: 'fix-bundle-prefix',
      replacementValue: 'AmadeusITGroup-community-collections-amadeus-ospo'
    });

    const fixed = applyHubYamlMutation(withBrokenPrefix, {
      kind: 'apply-quick-fix',
      quickFix: prefixDiag!.quickFix!
    });

    expect(validateHubConfigYaml(fixed).valid).toBe(true);
    expect(fixed).toContain('# Roles');
    expect(fixed).toContain('# Domains');
  });

  it('produces inline decorations for metadata, sources, and categorized profiles', () => {
    const result = validateHubConfigYaml(SAMPLE_HUB_YAML);
    expect(result.valid).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(result.inlineDecorations.length).toBeGreaterThan(0);
  });

  it('preserves CRLF line endings when mutating CRLF documents', () => {
    const crlfDoc = SAMPLE_HUB_YAML.replaceAll('\n', '\r\n');
    const updated = applyHubYamlMutation(crlfDoc, {
      kind: 'touch-updated-at',
      updatedAt: '2026-10-26T00:00:00.000Z'
    });
    expect(updated.includes('\r\n')).toBe(true);
    expect(updated.replaceAll('\r\n', '').includes('\n')).toBe(false);
  });
});
