/**
 * Tests for the primitive diagnostics fixture and catalogue
 * (domain/diagnostics/primitives/{fixture,catalogue}.ts).
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import {
  load as parseYaml,
} from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateCollectionObject,
} from '../../../../src/domain/collection/validate';
import {
  buildPrimitiveFixture,
  type DiagnosticBundle,
  PLUGIN_ROOT_PLACEHOLDER,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
  PRIMITIVE_FIXTURE_REPOSITORY_URL,
  PRIMITIVE_INVALID_PLUGIN_BUNDLES,
} from '../../../../src/domain/diagnostics/primitives';
import {
  validateAgentPluginItem,
} from '../../../../src/domain/plugin/agent-plugin-spec';
import {
  PRIMITIVE_KINDS,
} from '../../../../src/domain/primitive/types';

/** Kind → item path and expected manifest id. */
const EXPECTED_ITEMS = [
  ['prompt', 'prompts/hello-world.prompt.md', 'hello-world'],
  ['instruction', 'instructions/code-style.instructions.md', 'code-style'],
  ['chat-mode', 'chat-modes/review.chatmode.md', 'review'],
  ['agent', 'agents/security.agent.md', 'security'],
  ['skill', 'skills/standalone-skill/SKILL.md', 'standalone-skill'],
  ['plugin', 'plugins/aph-e2e-plugin/plugin.json', 'aph-e2e-plugin'],
  ['hook', 'hooks/pre-commit.hook.json', 'pre-commit'],
  ['mcp-server', 'mcp-servers/github.mcp.json', 'github'],
  ['steering', '.kiro/steering/api-standards.md', 'api-standards'],
  ['spec', '.kiro/specs/feature/requirements.md', 'feature'],
  ['command', '.claude/commands/deploy.md', 'deploy'],
  ['rule', '.cursor/rules/backend.mdc', 'backend'],
  ['output-style', '.claude/output-styles/terse.md', 'terse'],
  ['tool', '.opencode/tools/database.py', 'database'],
  ['power', 'powers/stripe/POWER.md', 'stripe'],
  ['knowledge', 'knowledge/onboarding.md', 'onboarding'],
  ['playbook', 'playbooks/bug-fix.md', 'bug-fix']
] as const;

/**
 * SHA-256 of the archive entries `bundle build` produces from the fixture,
 * so any change to the fixture bytes is deliberate.
 */
const ARCHIVE_DIGESTS: Record<string, string> = {
  LICENSE: 'add9cacde2904e5041c61dcc64855c605b7103d5657fc0d15b8124f9209d6149',
  'prompts/hello-world.prompt.md': '1c00793a9d0449d3b1b2b15c30d7a945c7923911f76a5b986699e9cbc757bac4',
  'instructions/code-style.instructions.md': '1492a667587a504978a86fb1b77ab6577949af3f324e9c14ecfb32e4f1a62fdb',
  'chat-modes/review.chatmode.md': 'da58005dd5b299e230985af36c2aa0800b2fa39b0b4e6eb70a3ec8c3fcb242be',
  'agents/security.agent.md': '512ce427b07dc1453703596563896a1ec34312a2ed18c1544245c1481e63e9d0',
  'skills/standalone-skill/SKILL.md': 'cdfe5ab6edbbeb86863f7be2d807a2c2ddbe68406a65c920acf7af35454d6ffe',
  'skills/standalone-skill/references/guide.md': '255b4a5b6101a1e3caa76186ec09f3019f77d09640714b6684e048f9cf3a2e59',
  'skills/standalone-skill/scripts/run.sh': '6f7a74003c4c71a15cf3bf516ad2b494e27c5f8c57da2b135725569f421fedec',
  'plugins/aph-e2e-plugin/plugin.json': 'c8ec123d32e8859c1aef6ae6791c5c893222db60e466dfb59568c1a2b70b6436',
  'plugins/aph-e2e-plugin/mcp.json': '45f0ef5b95580fee6456baa50a0b2ea203545ac1991e2a9233e7a13b18b77a1d',
  'plugins/aph-e2e-plugin/scripts/launch.sh': 'c76b28cc5ec0a8104f41e9b4d5962ad8779b797a9ed8c9dcd1e5cca1e51e5caf',
  'plugins/aph-e2e-plugin/skills/plugin-skill/SKILL.md': '33954af9f5d53b83c4b63db4085d7138ee8c658ed720ffd18648ed041caceea1',
  'plugins/aph-e2e-no-schema/plugin.json': 'ecac6b048b9c541620baa845644b0e19688dadc3788fe99e3e5c1ac91b5d2644',
  'plugins/aph-e2e--bad-name/plugin.json': '5fd1a04d3dd4be66bf1e00436dd3846fc25bf8c4707740d85eff3ed96722c5d2',
  'plugins/aph-e2e-string-author/plugin.json': 'afaf1f1b78a10db7d32fb892b1d0599b4ba0fbc41ecf63d1895b03b97bfccc75',
  'plugins/aph-e2e-nested-manifest/meta/plugin.json': '1de7bacc76f38b2ae98a1800d82942b41bf177ac7902c93438cc879fb59cba1d',
  'plugins/aph-e2e-nested-manifest/skills/nested-skill/SKILL.md': '3bda85b93082fecc7ce9923c464876c85cfa5c1c34fcbf24d25c3750878855c5',
  'hooks/pre-commit.hook.json': '89964c843471aca38a822945bae5b2bdb85ef82f266839dcc53bae70dd8cb0b3',
  'mcp-servers/github.mcp.json': 'fe1afc5359ea23f252035b58e751b4d2b536c623780396b36e0b787feefb5c65',
  '.kiro/steering/api-standards.md': '38dcd0ec1d3c9540a030a92b06a6566c774ed4592ac93b55ae6b251962887874',
  '.kiro/specs/feature/requirements.md': '34b0f2d2fcdb02746cbc9e5b7df0b30cc69a3ca464486da178d15a76662a4558',
  '.claude/commands/deploy.md': '50023b59e1afb097fb80ac2200f32914b1087d44e9376deb8fca91698a78071d',
  '.cursor/rules/backend.mdc': '2b0ac0c9ae9b60fad2dda933d176caa6581689bc773895ce283969d3b0cab091',
  '.claude/output-styles/terse.md': 'c6297572ab53331271347d447974719e4bd3c9524861de9cb1a69d72e2f55cff',
  '.opencode/tools/database.py': '67dbf8282fc0baa69f07effa0ced9894e46a55a6ea7811a5a86909c6b06824c6',
  'powers/stripe/POWER.md': '5049d9934b86e73fb707e3681b43de99bab8a3b920532a884ebc4d2793dc8f27',
  'knowledge/onboarding.md': '91929930f6a69fca99e7568e000ac9f801c5cb177c3070a58c7a8a4d8a18a34d',
  'playbooks/bug-fix.md': 'a2e1f463025a60b88d595bbad278c1a704b97718662b4056c30f5f492013d971',
  'collections/aph-e2e-only-prompt.collection.yml': 'face0d7daba5f5262eeb41dcd673cb82276eaf9295bc9d5bb48c857e19142237',
  'collections/aph-e2e-only-instruction.collection.yml': 'c685b7332bf29c7ac094752a793d4197bd06669e776663e7c564ca69771867af',
  'collections/aph-e2e-only-chat-mode.collection.yml': 'ff346199ea95b6a6d4dc1c4a4ce7a43c14a8f96e755a46285918a8e102b80c38',
  'collections/aph-e2e-only-agent.collection.yml': 'fddba651feba97da14b03db08e9631ea579dc30d863089fcc6ce98acb395480f',
  'collections/aph-e2e-only-skill.collection.yml': '596731582fc1ab0295f340ade35c200a0c3aeddaadc8b92dd7f2731525bea8ae',
  'collections/aph-e2e-only-plugin.collection.yml': 'c315f4a11fb2a1f257b9a61a3694ffc8df099f3bf7022dacf49301d80061194b',
  'collections/aph-e2e-only-hook.collection.yml': '3592c8170e76a9784bd48eba4a382e71990bab1ad7a0feb3209b1b1fcfed919e',
  'collections/aph-e2e-only-mcp-server.collection.yml': 'a8d4cce532d7a92587e1ab693b98c03147621a51ed16038d772fb6e0d474262d',
  'collections/aph-e2e-only-steering.collection.yml': '12a9b939487c00b803fda8d49a2c0fc5c16f5742d18f055e6995ebebc03c9fc2',
  'collections/aph-e2e-only-spec.collection.yml': '79f6727ed4aa0ae5b7bfef5e4d02ea03c3e66ccc8735d8555477209887eb345d',
  'collections/aph-e2e-only-command.collection.yml': '68af76fa166b3e0d2390d899f785c9f5c1e68318e3f8dcdbc4d3df359a41c47b',
  'collections/aph-e2e-only-rule.collection.yml': 'd9a61f9066001ca097edfa612163d2f5bc95437efd4cdd22fa12da4dc9c01d0c',
  'collections/aph-e2e-only-output-style.collection.yml': '42adf3b85739d535cd9642aa208cfc47b432b7e310b7fd01923eae3d9d6f34fe',
  'collections/aph-e2e-only-tool.collection.yml': 'f6df5c3a5c03724460c22e3ff5762f5260f93d3d408f2961a1cda43b78e6d70a',
  'collections/aph-e2e-only-power.collection.yml': '11f894db97adca0a959ced2d0e97e94e47bfffb6aa44520239633bf719bb24a4',
  'collections/aph-e2e-only-knowledge.collection.yml': 'a5495cf2b6408f65abe2241878d9145c0f58619a089fd9906cf4f3e4a6447d76',
  'collections/aph-e2e-only-playbook.collection.yml': '4823ad78495b1849fe7fc3286e7754fc7cf13cf446ccd233052b1e5aae249c81',
  'collections/aph-e2e-mix-portable.collection.yml': 'b210bb5e8abf42a5acb72d0ba5f6b132af7a03e3d3c28023feefe7e499e8841f',
  'collections/aph-e2e-mix-all-kinds.collection.yml': '11f6acf3759aab47658cf32dbe58788909b50ccb6239cd988a67b773ccfac4ba',
  'collections/aph-e2e-bad-plugin-no-schema.collection.yml': '4656867066292420fd0d2acbe9beaeec684daba55325c6a5ec912f6de29adda3',
  'collections/aph-e2e-bad-plugin-name.collection.yml': '12ae7828a09e2716186155475647d33e57d67055a9ccd2409dd48b94dfa16cea',
  'collections/aph-e2e-bad-plugin-author.collection.yml': 'dba0bcc517ece70d967fdda5e02a9e345ce4b11b3ad0a6a600316a00d9405d43',
  'collections/aph-e2e-bad-plugin-nested-manifest.collection.yml': '4259bbaa919168e5c6ca336c78ea703921e953c39f6c487eab43ea92a4762dec'
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const ISOLATED = PRIMITIVE_DIAGNOSTIC_BUNDLES.slice(0, PRIMITIVE_KINDS.length);
const MIXED_IDS = ['aph-e2e-mix-portable', 'aph-e2e-mix-all-kinds'];
const INVALID_IDS = ['aph-e2e-bad-plugin-no-schema', 'aph-e2e-bad-plugin-name', 'aph-e2e-bad-plugin-author', 'aph-e2e-bad-plugin-nested-manifest'];
const byId = (id: string): DiagnosticBundle => PRIMITIVE_DIAGNOSTIC_BUNDLES.find((b) => b.id === id)!;

describe('PRIMITIVE_DIAGNOSTIC_BUNDLES', () => {
  const fixture = buildPrimitiveFixture();

  it('has 23 bundles: one isolated bundle per kind in PRIMITIVE_KINDS order, then the mixed, then the invalid plugin bundles', () => {
    expect(PRIMITIVE_DIAGNOSTIC_BUNDLES.map((b) => b.id)).toEqual([
      ...PRIMITIVE_KINDS.map((kind) => `aph-e2e-only-${kind}`),
      ...MIXED_IDS,
      ...INVALID_IDS
    ]);
    for (const bundle of PRIMITIVE_DIAGNOSTIC_BUNDLES) {
      expect(bundle.collectionFile).toBe(`collections/${bundle.id}.collection.yml`);
      expect(bundle.version).toBe('1.0.0');
    }
    for (const bundle of ISOLATED) {
      expect(bundle.items).toHaveLength(1);
      expect(bundle.rejection).toBeUndefined();
    }
  });

  it('declares the item paths and expected ids', () => {
    expect(ISOLATED.map((b) => [b.items[0].kind, b.items[0].path, b.items[0].expectedId]))
      .toEqual(EXPECTED_ITEMS.map((row) => [...row]));
  });

  it('lists every item source file, sorted, present in the fixture and under the source prefix', () => {
    for (const item of PRIMITIVE_DIAGNOSTIC_BUNDLES.flatMap((b) => b.items)) {
      expect(item.files).toContain(item.path);
      expect([...item.files]).toEqual(item.files.toSorted());
      for (const file of item.files) {
        expect(fixture.has(file)).toBe(true);
        expect(file.startsWith(item.sourcePrefix)).toBe(true);
      }
    }
  });

  it('models skill, plugin and power as directory units that stay under the entry point directory', () => {
    const units = Object.fromEntries(ISOLATED.map((b) => [b.items[0].kind, b.items[0]]));
    expect(units.skill.unit).toBe('directory');
    expect(units.skill.files).toEqual([
      'skills/standalone-skill/SKILL.md',
      'skills/standalone-skill/references/guide.md',
      'skills/standalone-skill/scripts/run.sh'
    ]);
    expect(units.plugin.unit).toBe('directory');
    expect(units.plugin.files).toEqual([
      'plugins/aph-e2e-plugin/mcp.json',
      'plugins/aph-e2e-plugin/plugin.json',
      'plugins/aph-e2e-plugin/scripts/launch.sh',
      'plugins/aph-e2e-plugin/skills/plugin-skill/SKILL.md'
    ]);
    expect(units.power.unit).toBe('directory');
    expect(units.power.files).toEqual(['powers/stripe/POWER.md', 'powers/stripe/steering/payments.md']);
    for (const item of Object.values(units)) {
      if (item.unit === 'directory') {
        const root = `${path.posix.dirname(item.path)}/`;
        expect(item.files.every((f) => f.startsWith(root))).toBe(true);
      } else {
        expect(item.files).toEqual([item.path]);
      }
    }
    expect(Object.values(units).filter((i) => i.unit === 'directory').map((i) => i.kind)).toEqual(['skill', 'plugin', 'power']);
  });

  it('declares the executable files and the plugin components', () => {
    const items = Object.fromEntries(ISOLATED.map((b) => [b.items[0].kind, b.items[0]]));
    expect(items.skill.executable).toEqual(['skills/standalone-skill/scripts/run.sh']);
    expect(items.plugin.executable).toEqual(['plugins/aph-e2e-plugin/scripts/launch.sh']);
    expect(Object.values(items).filter((i) => i.executable.length > 0).map((i) => i.kind)).toEqual(['skill', 'plugin']);
    expect(items.plugin.plugin).toEqual({ skills: ['plugin-skill'], mcpServers: ['aph-e2e'] });
    expect(Object.values(items).filter((i) => i.plugin !== undefined).map((i) => i.kind)).toEqual(['plugin']);
  });

  it('builds the mixed bundles from the isolated items, in PRIMITIVE_KINDS order', () => {
    const isolatedItem = new Map(ISOLATED.map((b) => [b.items[0].kind, b.items[0]]));
    expect(byId('aph-e2e-mix-portable').items.map((i) => i.kind)).toEqual(['prompt', 'instruction', 'agent', 'skill', 'plugin', 'hook']);
    expect(byId('aph-e2e-mix-all-kinds').items.map((i) => i.kind)).toEqual([...PRIMITIVE_KINDS]);
    for (const id of MIXED_IDS) {
      expect(byId(id).rejection).toBeUndefined();
      for (const item of byId(id).items) {
        expect(item).toEqual(isolatedItem.get(item.kind));
      }
    }
  });

  it('expects each invalid plugin bundle to be rejected with the documented message', () => {
    expect(INVALID_IDS.map((id) => [byId(id).items.map((i) => [i.kind, i.path]), byId(id).rejection])).toEqual([
      [[['plugin', 'plugins/aph-e2e-no-schema/plugin.json']], {
        errorCode: 'PLUGIN.INVALID_MANIFEST',
        message: 'collections/aph-e2e-bad-plugin-no-schema.collection.yml: items[0] plugin plugins/aph-e2e-no-schema/plugin.json: '
          + 'missing required field "$schema"; set it to "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"'
      }],
      [[['plugin', 'plugins/aph-e2e--bad-name/plugin.json']], {
        errorCode: 'PLUGIN.INVALID_MANIFEST',
        message: 'collections/aph-e2e-bad-plugin-name.collection.yml: items[0] plugin plugins/aph-e2e--bad-name/plugin.json: '
          + '"name" must be 1-64 characters of lowercase letters, digits, "." or "-", start and end with a letter or digit, '
          + 'and contain no "--" or ".." (got "aph-e2e--bad-name")'
      }],
      [[['plugin', 'plugins/aph-e2e-string-author/plugin.json']], {
        errorCode: 'PLUGIN.INVALID_MANIFEST',
        message: 'collections/aph-e2e-bad-plugin-author.collection.yml: items[0] plugin plugins/aph-e2e-string-author/plugin.json: '
          + '"author" must be an object with optional string fields "name", "email", "url" (got a string)'
      }],
      [[['plugin', 'plugins/aph-e2e-nested-manifest/meta/plugin.json']], {
        errorCode: 'PLUGIN.INVALID_MANIFEST',
        message: 'collections/aph-e2e-bad-plugin-nested-manifest.collection.yml: items[0] plugin plugins/aph-e2e-nested-manifest/meta/plugin.json: '
          + 'plugin name "aph-e2e-nested-manifest" must match its directory "meta" (AI Primitives Hub packaging rule: '
          + 'the plugin root is the directory that contains plugin.json, and it is bundled and installed under that directory name). '
          + 'Rename the directory or the "name" field, and keep plugin.json at the plugin root'
      }]
    ]);
  });

  it('declares, for each invalid plugin, exactly the single fatal issue the plugin validator reports', () => {
    for (const invalid of PRIMITIVE_INVALID_PLUGIN_BUNDLES) {
      const result = validateAgentPluginItem({ itemPath: invalid.item.path, manifestText: decode(fixture.get(invalid.item.path)!.bytes) });
      expect(result.valid, invalid.id).toBe(false);
      expect(result.issues.filter((issue) => issue.severity === 'fatal').map((issue) => issue.message), invalid.id).toEqual([invalid.issue]);
    }
  });

  it('ships a spec-compliant plugin: valid manifest and a ${PLUGIN_ROOT}-based MCP server', () => {
    const plugin = ISOLATED.find((b) => b.items[0].kind === 'plugin')!.items[0];
    const manifest = decode(fixture.get(plugin.path)!.bytes);
    expect(validateAgentPluginItem({ itemPath: plugin.path, manifestText: manifest })).toMatchObject({ valid: true, issues: [] });
    const mcp = JSON.parse(decode(fixture.get('plugins/aph-e2e-plugin/mcp.json')!.bytes)) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['aph-e2e']);
    expect(mcp.mcpServers['aph-e2e'].command).toBe('./scripts/launch.sh');
    expect(JSON.stringify(mcp.mcpServers['aph-e2e'].args)).toContain(PLUGIN_ROOT_PLACEHOLDER);
    expect(decode(fixture.get('plugins/aph-e2e-plugin/scripts/launch.sh')!.bytes)).toContain(PLUGIN_ROOT_PLACEHOLDER);
  });
});

describe('buildPrimitiveFixture', () => {
  const fixture = buildPrimitiveFixture();

  it('has the governed-release root files and the fixture repository URL', () => {
    expect(PRIMITIVE_FIXTURE_REPOSITORY_URL).toBe('https://github.com/example/aph-e2e-fixture.git');
    expect(fixture.has('LICENSE')).toBe(true);
    expect(fixture.has('README.md')).toBe(true);
    const pkg = JSON.parse(decode(fixture.get('package.json')!.bytes)) as { repository: { url: string } };
    expect(pkg.repository.url).toBe(PRIMITIVE_FIXTURE_REPOSITORY_URL);
  });

  it('carries the intended file modes as data', () => {
    const executable = ['plugins/aph-e2e-plugin/scripts/launch.sh', 'skills/standalone-skill/scripts/run.sh'];
    expect([...fixture].filter(([, f]) => f.mode === 0o755).map(([p]) => p).toSorted()).toEqual(executable);
    expect([...fixture].filter(([p]) => !executable.includes(p)).every(([, f]) => f.mode === 0o644)).toBe(true);
  });

  it('keeps the pinned archive bytes', () => {
    for (const [file, digest] of Object.entries(ARCHIVE_DIGESTS)) {
      const entry = fixture.get(file);
      expect(entry, file).toBeDefined();
      expect(createHash('sha256').update(entry!.bytes).digest('hex'), file).toBe(digest);
    }
  });

  it('renders every bundle collection with the canonical key order and a valid shape', () => {
    for (const bundle of PRIMITIVE_DIAGNOSTIC_BUNDLES) {
      const parsed = parseYaml(decode(fixture.get(bundle.collectionFile)!.bytes)) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(['id', 'name', 'description', 'version', 'author', 'tags', 'items']);
      expect(parsed.id).toBe(bundle.id);
      expect(parsed.version).toBe(bundle.version);
      expect(parsed.items).toEqual(bundle.items.map((i) => ({ path: i.path, kind: i.kind })));
      expect(validateCollectionObject(parsed, bundle.collectionFile)).toEqual({ ok: true, errors: [] });
    }
  });

  it('returns a fresh map on each call', () => {
    expect(buildPrimitiveFixture()).not.toBe(fixture);
  });
});
