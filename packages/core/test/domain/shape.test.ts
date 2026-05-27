import {
  describe,
  expect,
  it,
} from 'vitest';
import * as domain from '../../src/domain';
import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
  HarvestedFile,
  HubSourceSpec,
  PluginItem,
  PluginItemKind,
  PluginManifest,
  Primitive,
  PrimitiveKind,
} from '../../src/domain';

describe('domain barrel shape', () => {
  describe('runtime exports', () => {
    it('exposes PRIMITIVE_KINDS with all six kinds', () => {
      expect(domain.PRIMITIVE_KINDS.toSorted()).toStrictEqual([
        'agent',
        'chat-mode',
        'instruction',
        'mcp-server',
        'prompt',
        'skill'
      ]);
    });

    it('runtime exports are exactly the documented set', () => {
      const ownKeys = Object.keys(domain).toSorted();
      expect(ownKeys).toStrictEqual([
        'DEFAULT_LOCAL_HUB_ID',
        'DEFAULT_VALIDATION_RULES',
        'MAX_ASSET_SIZE',
        'PRIMITIVE_KINDS',
        'RegistryError',
        'SKILL_DESCRIPTION_MAX_LENGTH',
        'SKILL_DESCRIPTION_MIN_LENGTH',
        'SKILL_NAME_MAX_LENGTH',
        'TARGET_TYPES',
        'generateBundleId',
        'generateSourceId',
        'isHubConfig',
        'isHubReference',
        'isProfile',
        'isProfileBundle',
        'isRegistryError',
        'isRegistrySource',
        'isSafeRepoRelativePath',
        'isTarget',
        'normalizeRepoRelativePath',
        'parseBundleSpec',
        'parseFrontmatter',
        'sanitizeHubId',
        'validateCollectionId',
        'validateCollectionObject',
        'validateItemKind',
        'validateManifest',
        'validateSkillDescription',
        'validateSkillName',
        'validateTargetLayoutsConfig',
        'validateVersion'
      ]);
    });
  });

  describe('type exports — structural conformance', () => {
    it('BundleRef accepts a minimum-viable record', () => {
      const ref: BundleRef = {
        sourceId: 'wherka-ama/awesome-copilot',
        sourceType: 'github',
        bundleId: 'tdd-helper',
        bundleVersion: '1.0.0',
        installed: false
      };
      expect(ref.bundleId).toBe('tdd-helper');
    });

    it('BundleManifest tolerates open-ended fields (manifest schema is bundle-defined)', () => {
      const manifest: BundleManifest = {
        id: 'tdd-helper',
        version: '1.0.0',
        items: [{ path: 'prompts/x.md', kind: 'prompt' }],
        // Open-ended schema — extra fields are part of the contract.
        someBundleSpecificField: 42
      };
      expect(manifest.id).toBe('tdd-helper');
    });

    it('Primitive carries the harvested-bundle anchor and the search-relevant fields', () => {
      const p: Primitive = {
        id: 'wherka-ama/x@1.0.0::prompts/foo.md',
        bundle: {
          sourceId: 'wherka-ama/x', sourceType: 'github',
          bundleId: 'x', bundleVersion: '1.0.0', installed: true
        },
        kind: 'prompt' satisfies PrimitiveKind,
        path: 'prompts/foo.md',
        title: 'Foo prompt',
        description: 'Does foo things.',
        tags: ['foo'],
        bodyPreview: '...',
        contentHash: 'sha256:...'
      };
      expect(p.kind).toBe('prompt');
    });

    it('HarvestedFile is the minimum bundle-file payload', () => {
      const f: HarvestedFile = { path: 'a.md', content: 'hi' };
      expect(f.path).toBe('a.md');
    });

    it('PluginItemKind is a subset of PrimitiveKind (no `mcp-server`)', () => {
      const k: PluginItemKind = 'agent';
      const p: PrimitiveKind = k;
      expect(p).toBe('agent');
    });

    it('PluginItem and PluginManifest model the awesome-copilot plugin format', () => {
      const item: PluginItem = { kind: 'skill', path: 'skills/foo.md' };
      const manifest: PluginManifest = {
        id: 'foo',
        name: 'Foo Plugin',
        items: [item],
        // Permissive surface — unknown keys must be tolerated.
        someExperimentalField: 'x'
      };
      expect(manifest.id).toBe('foo');
      expect(item.kind).toBe('skill');
    });

    it('HubSourceSpec carries the parsed-config representation of a hub source', () => {
      const spec: HubSourceSpec = {
        id: 'wherka-ama-awesome-copilot',
        name: 'awesome-copilot',
        type: 'awesome-copilot-plugin',
        url: 'https://github.com/wherka-ama/awesome-copilot',
        owner: 'wherka-ama',
        repo: 'awesome-copilot',
        branch: 'main',
        pluginsPath: 'plugins'
      };
      expect(spec.type).toBe('awesome-copilot-plugin');
      expect(spec.pluginsPath).toBe('plugins');
    });

    it('BundleProvider is callable as an interface (compile-time only check)', () => {
      class StubProvider implements BundleProvider {
        public listBundles(): AsyncIterable<BundleRef> {
          return (async function* () { /* empty */ })();
        }

        public readManifest(): Promise<BundleManifest> {
          return Promise.resolve({ id: 'x', version: '0' });
        }

        public readFile(): Promise<string> {
          return Promise.resolve('');
        }
      }
      expect(typeof StubProvider).toBe('function');
    });
  });
});
