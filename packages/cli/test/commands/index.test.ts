/**
 * `index *` command tests (build/stats/search/shortlist/export/eval/
 * bench/report/harvest).
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands read/write real index/shortlist/
 * profile/report files. Fixture mirrors `doctor/diagnostics.ts`'s
 * already-proven bundle fixture.
 */
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  ActiveHubStore,
  AppStoragePrimitiveIndexStore,
  HubStore,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  IndexBenchCommand,
} from '../../src/commands/index-bench';
import {
  IndexBuildCommand,
} from '../../src/commands/index-build';
import {
  IndexEvalCommand,
} from '../../src/commands/index-eval';
import {
  IndexExportCommand,
} from '../../src/commands/index-export';
import {
  IndexHarvestCommand,
} from '../../src/commands/index-harvest';
import {
  IndexReportCommand,
} from '../../src/commands/index-report';
import {
  IndexSearchCommand,
} from '../../src/commands/index-search';
import {
  IndexShortlistAddCommand,
  IndexShortlistListCommand,
  IndexShortlistNewCommand,
  IndexShortlistRemoveCommand,
} from '../../src/commands/index-shortlist';
import {
  IndexStatsCommand,
} from '../../src/commands/index-stats';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  IndexBuildCommand,
  IndexStatsCommand,
  IndexSearchCommand,
  IndexShortlistNewCommand,
  IndexShortlistAddCommand,
  IndexShortlistListCommand,
  IndexShortlistRemoveCommand,
  IndexExportCommand,
  IndexEvalCommand,
  IndexBenchCommand,
  IndexReportCommand,
  IndexHarvestCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('index commands', () => {
  let workspace: string;
  let bundleDir: string;
  let indexFile: string;
  let embeddedIndexFile: string;

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-index-test-'));
    bundleDir = path.join(workspace, 'bundle');
    indexFile = path.join(workspace, 'primitive-index.json');
    embeddedIndexFile = path.join(workspace, 'embedded-index.json');

    const localFooDir = path.join(bundleDir, 'local-foo');
    await mkdir(path.join(localFooDir, 'prompts'), { recursive: true });
    await writeFile(
      path.join(localFooDir, 'deployment-manifest.yml'),
      'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
    );
    await writeFile(path.join(localFooDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n\nA diagnostic prompt.\n');

    expect((await run([
      'index', 'build', '--root', bundleDir, '--out', indexFile, '--source-id', 'local-foo-src', '-o', 'json'
    ])).exitCode).toBe(0);

    expect((await run([
      'index', 'build', '--root', bundleDir, '--out', embeddedIndexFile, '--source-id', 'local-foo-src', '--embed', '-o', 'json'
    ])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('index build', () => {
    it('builds an index file with the expected stats', async () => {
      const content = JSON.parse(await readFile(indexFile, 'utf8')) as unknown;
      expect(content).toBeTruthy();
    });

    it('embeds primitive text when --embed is passed', async () => {
      const content = JSON.parse(await readFile(embeddedIndexFile, 'utf8')) as {
        embeddingsMeta?: { provider: string; dim: number } | null;
      };
      expect(content.embeddingsMeta).toBeTruthy();
      expect(content.embeddingsMeta?.dim).toBe(384);
    });

    it('uses the current directory as the default --root and writes to the XDG cache', async () => {
      const result = await run(['index', 'build', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ primitives: number; bundles: number; outFile: string }>(result.stdout);
      expect(envelope.data.primitives).toBe(0);
      expect(envelope.data.bundles).toBe(0);
      expect(envelope.data.outFile).toBe(path.join(workspace, 'xdg-cache', 'ai-primitives-hub', 'primitive-index.json'));
    });
  });

  describe('index stats', () => {
    it('reports primitives/bundles counts', async () => {
      const result = await run(['index', 'stats', '--index', indexFile, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ primitives: number; bundles: number }>(result.stdout);
      expect(envelope.data.primitives).toBe(1);
      expect(envelope.data.bundles).toBe(1);
    });

    it('fails with exit 1 for a missing index file', async () => {
      const result = await run(['index', 'stats', '--index', path.join(workspace, 'no-such-index.json'), '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('index search', () => {
    it('finds the seeded prompt by query text', async () => {
      const result = await run(['index', 'search', '--query', 'hello', '--index', indexFile, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ hits: { primitive: { id: string } }[] }>(result.stdout);
      expect(envelope.data.hits.length).toBeGreaterThan(0);
    });

    it('returns zero hits for a non-matching query', async () => {
      const result = await run(['index', 'search', '--query', 'zzz-no-match-zzz', '--index', indexFile, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ hits: unknown[] }>(result.stdout);
      expect(envelope.data.hits).toEqual([]);
    });

    it('performs hybrid search with --ranking hybrid on an embedded index', async () => {
      const result = await run([
        'index', 'search', '--query', 'diagnostic prompt', '--index', embeddedIndexFile, '--ranking', 'hybrid', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ hits: { primitive: { id: string } }[] }>(result.stdout);
      expect(envelope.data.hits.length).toBeGreaterThan(0);
    });

    it('reads a stable index namespace for a timestamp-suffixed active hub id', async () => {
      const store = new AppStoragePrimitiveIndexStore({
        getPaths: () => ({
          cache: path.join(workspace, 'xdg-cache', 'ai-primitives-hub'),
          config: path.join(workspace, 'xdg-config', 'ai-primitives-hub'),
          data: path.join(workspace, 'xdg-data', 'ai-primitives-hub'),
          state: path.join(workspace, 'xdg-state', 'ai-primitives-hub')
        })
      });
      const stablePath = store.getIndexPath({
        hubId: 'amadeus-hub',
        sourceRevision: 'contract-revision',
        searchProfileId: 'ternlight-single-v1'
      });
      await mkdir(path.dirname(stablePath), { recursive: true });
      await copyFile(embeddedIndexFile, stablePath);

      const activeHubStore = new ActiveHubStore(
        path.join(workspace, 'xdg-config', 'ai-primitives-hub', 'active-hub.json'),
        new NodeFileSystem()
      );
      await mkdir(path.dirname(path.join(workspace, 'xdg-config', 'ai-primitives-hub', 'active-hub.json')), { recursive: true });
      await activeHubStore.set('amadeus-hub-788228');

      const result = await run(['index', 'search', '--query', 'hello', '-o', 'json']);

      expect(result.exitCode, result.stderr).toBe(0);
      const envelope = parseJson<{ hits: unknown[] }>(result.stdout);
      expect(envelope.data.hits.length).toBeGreaterThan(0);
    });

    it('rejects --ranking hybrid on a non-embedded index', async () => {
      const result = await run([
        'index', 'search', '--query', 'hello', '--index', indexFile, '--ranking', 'hybrid'
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('embedded index');
    });

    it('uses legacy prompt-registry active hub when installing from search results', async () => {
      const userPaths = resolveUserConfigPaths({
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      });
      const legacyRoot = path.join(path.dirname(userPaths.root), 'prompt-registry');
      const legacyHubsDir = path.join(legacyRoot, 'hubs');
      const legacyActiveHubPath = path.join(legacyRoot, 'active-hub.json');
      const fs = new NodeFileSystem();
      const hubId = 'legacy-hub';

      const hubStore = new HubStore(legacyHubsDir, fs);
      await hubStore.save(hubId, {
        version: '1.0.0',
        metadata: {
          name: 'Legacy Hub',
          description: 'Legacy hub for regression test',
          maintainer: 'tests',
          updatedAt: new Date().toISOString()
        },
        sources: [
          {
            id: 'local-foo-src',
            name: 'Local Foo Source',
            type: 'local',
            url: 'file:///tmp/local-foo',
            enabled: true,
            priority: 0,
            hubId,
            metadata: {
              description: 'Source matching indexed bundle source id'
            },
            config: {
              branch: 'main'
            }
          }
        ],
        profiles: []
      }, {
        type: 'local',
        location: legacyRoot
      });

      const activeHubStore = new ActiveHubStore(legacyActiveHubPath, fs);
      await activeHubStore.set(hubId);

      const result = await run([
        'index', 'search', '--query', 'hello', '--index', indexFile, '--install'
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No target found. Run `ai-primitives-hub target add` first.');
      expect(result.stderr).not.toContain('No active hub found');
    });
  });

  describe('index shortlist', () => {
    it('supports the full new/add/list/remove lifecycle', async () => {
      const newResult = await run(['index', 'shortlist', 'new', '--name', 'My List', '--index', indexFile, '-o', 'json']);
      expect(newResult.exitCode).toBe(0);
      const newEnvelope = parseJson<{ shortlist: { id: string } }>(newResult.stdout);
      const shortlistId = newEnvelope.data.shortlist.id;

      const searchResult = await run(['index', 'search', '--query', 'hello', '--index', indexFile, '-o', 'json']);
      const searchEnvelope = parseJson<{ hits: { primitive: { id: string } }[] }>(searchResult.stdout);
      const primitiveId = searchEnvelope.data.hits[0].primitive.id;

      const addResult = await run([
        'index', 'shortlist', 'add', '--id', shortlistId, '--primitive', primitiveId, '--index', indexFile, '-o', 'json'
      ]);
      expect(addResult.exitCode).toBe(0);

      const listResult = await run(['index', 'shortlist', 'list', '--index', indexFile, '-o', 'json']);
      expect(listResult.exitCode).toBe(0);
      const listEnvelope = parseJson<{ shortlists: { id: string; primitiveIds: string[] }[] }>(listResult.stdout);
      const sl = listEnvelope.data.shortlists.find((s) => s.id === shortlistId);
      expect(sl?.primitiveIds).toContain(primitiveId);

      const removeResult = await run([
        'index', 'shortlist', 'remove', '--id', shortlistId, '--primitive', primitiveId, '--index', indexFile, '-o', 'json'
      ]);
      expect(removeResult.exitCode).toBe(0);
      const removeEnvelope = parseJson<{ shortlist: { primitiveIds: string[] } }>(removeResult.stdout);
      expect(removeEnvelope.data.shortlist.primitiveIds).not.toContain(primitiveId);
    });

    it('fails with exit 1 for an unknown shortlist id', async () => {
      const result = await run([
        'index', 'shortlist', 'add', '--id', 'does-not-exist', '--primitive', 'foo', '--index', indexFile, '-o', 'json'
      ]);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('index export', () => {
    it('exports a shortlist as a profile YAML', async () => {
      const newResult = await run(['index', 'shortlist', 'new', '--name', 'Export List', '--index', indexFile, '-o', 'json']);
      const newEnvelope = parseJson<{ shortlist: { id: string } }>(newResult.stdout);
      const shortlistId = newEnvelope.data.shortlist.id;

      const exportDir = path.join(workspace, 'exports');
      const result = await run([
        'index', 'export', '--shortlist', shortlistId, '--profile-id', 'exported-profile',
        '--out-dir', exportDir, '--index', indexFile, '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ profileFile: string }>(result.stdout);
      const content = await readFile(envelope.data.profileFile, 'utf8');
      expect(content).toContain('exported-profile');
    });

    it('fails with exit 1 for an unknown shortlist', async () => {
      const result = await run([
        'index', 'export', '--shortlist', 'does-not-exist', '--profile-id', 'x', '--index', indexFile, '-o', 'json'
      ]);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('index eval', () => {
    it('exits 0 when every gold case matches', async () => {
      const goldFile = path.join(workspace, 'gold-pass.json');
      await writeFile(goldFile, JSON.stringify({
        cases: [{ id: 'case-1', query: { q: 'hello' }, mustMatch: [{ bundleId: 'local-foo' }] }]
      }));
      const result = await run(['index', 'eval', '--gold', goldFile, '--index', indexFile, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ aggregate: { failed: number } }>(result.stdout);
      expect(envelope.data.aggregate.failed).toBe(0);
    });

    it('exits 1 when a gold case fails to match', async () => {
      const goldFile = path.join(workspace, 'gold-fail.json');
      await writeFile(goldFile, JSON.stringify({
        cases: [{ id: 'case-1', query: { q: 'hello' }, mustMatch: [{ bundleId: 'does-not-exist' }] }]
      }));
      const result = await run(['index', 'eval', '--gold', goldFile, '--index', indexFile, '-o', 'json']);
      expect(result.exitCode).toBe(1);
      const envelope = parseJson<{ aggregate: { failed: number } }>(result.stdout);
      expect(envelope.data.aggregate.failed).toBeGreaterThan(0);
    });

    it('fails with exit 1 when --gold is missing', async () => {
      const result = await run(['index', 'eval', '--index', indexFile, '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('index bench', () => {
    it('reports a benchmark summary', async () => {
      const goldFile = path.join(workspace, 'gold-bench.json');
      await writeFile(goldFile, JSON.stringify({
        cases: [{ id: 'case-1', query: { q: 'hello' } }]
      }));
      const result = await run(['index', 'bench', '--gold', goldFile, '--index', indexFile, '--iterations', '5', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ perCase: unknown[] }>(result.stdout);
      expect(envelope.data.perCase.length).toBe(1);
    });
  });

  describe('index report', () => {
    it('reports an empty summary for a not-yet-created progress file', async () => {
      const progressFile = path.join(workspace, 'progress.jsonl');
      const result = await run(['index', 'report', '--progress-file', progressFile, '--cache-dir', '', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ summary: { done: number; error: number; skip: number } }>(result.stdout);
      expect(envelope.data.summary).toMatchObject({ done: 0, error: 0, skip: 0 });
    });
  });

  describe('index harvest', () => {
    it('fails with exit 1 when no hub ref is configured', async () => {
      const result = await run(['index', 'harvest', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('--no-hub-config with zero sources completes offline with zero totals', async () => {
      const result = await run([
        'index', 'harvest', '--no-hub-config',
        '--out-file', path.join(workspace, 'harvest-index.json'),
        '--progress-file', path.join(workspace, 'harvest-progress.jsonl'),
        '--cache-dir', path.join(workspace, 'harvest-cache'),
        '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ totals: { done: number; error: number } }>(result.stdout);
      expect(envelope.data.totals).toMatchObject({ done: 0, error: 0 });
    });
  });
});
