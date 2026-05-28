/**
 * Hub Release Analyzer Tests
 *
 * Unit tests for the hub-release-analyzer.js CLI script.
 * Tests cover input detection, config loading, data extraction, aggregation,
 * and report generation.
 */
/* eslint-disable import/order -- require() as import conflicts with import/newline-after-import */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const analyzer = require('../../bin/hub-release-analyzer.js');
/* eslint-enable import/order */

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a mock spawnSync that routes `gh api <path>` calls to predefined responses.
 * @param routes - Map of path substring → response data (will be JSON-stringified).
 *                 Use a function for dynamic matching on the full args[1] path.
 * @param fallback - Default result when no route matches (default: error status).
 * @param fallback.status - Exit code (default: 1).
 * @param fallback.stdout - Standard output (optional).
 * @param fallback.stderr - Standard error (optional).
 */
function createMockSpawnSync(
  routes: Record<string, unknown> | ((apiPath: string) => unknown),
  fallback?: { status: number; stdout?: string; stderr?: string }
) {
  const defaultFallback = { status: 1 };
  const finalFallback = fallback ?? defaultFallback;
  return (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'api') {
      const apiPath = args[1];
      if (typeof routes === 'function') {
        const data = routes(apiPath);
        if (data !== undefined) {
          return { status: 0, stdout: JSON.stringify(data) };
        }
      } else {
        for (const [pattern, data] of Object.entries(routes)) {
          if (apiPath.includes(pattern)) {
            return { status: 0, stdout: JSON.stringify(data) };
          }
        }
      }
    }
    return finalFallback;
  };
}

// Shared mock data for report generation tests
const sharedMockAggregated = {
  bySource: [
    { sourceId: 'src1', sourceName: 'Source 1', sourceRepo: 'owner/repo1', totalDownloads: 1000, bundleCount: 5, versionCount: 10, latestRelease: '2024-01-01' },
    { sourceId: 'src2', sourceName: 'Source 2', sourceRepo: 'owner/repo2', totalDownloads: 500, bundleCount: 3, versionCount: 6, latestRelease: '2024-02-01' }
  ],
  byBundle: [
    { bundleId: 'bundle-a', totalDownloads: 800, versionCount: 3, sourceCount: 2 },
    { bundleId: 'bundle-b', totalDownloads: 700, versionCount: 2, sourceCount: 1 }
  ],
  detailed: [
    {
      sourceId: 'src1', sourceName: 'Source 1', bundleId: 'bundle-a', version: '1.0.0',
      assetName: 'a-1.0.0.zip', assetSize: 1024, downloadCount: 100, releaseTag: 'v1.0.0',
      releaseDate: '2024-01-01'
    },
    {
      sourceId: 'src1', sourceName: 'Source 1', bundleId: 'bundle-b', version: '2.0.0',
      assetName: 'b-2.0.0.zip', assetSize: 2048, downloadCount: 200, releaseTag: 'v2.0.0',
      releaseDate: '2024-02-01'
    }
  ]
};

const sharedMockArgs = {
  hubSource: 'https://github.com/owner/repo',
  minDownloads: 0,
  sourceFilter: null,
  bundleFilter: null
};

describe('Hub Release Analyzer', () => {
  describe('parseArgs()', () => {
    const { parseArgs } = analyzer;

    it('should parse all options', () => {
      const full = parseArgs(['-o', './reports', '-f', 'csv', '-c', '10', '--min-downloads', '5', '--source-filter', 'github-.*', '--bundle-filter', 'my-.*', '--dry-run', '-v', './hub.yml']);

      assert.strictEqual(full.hubSource, './hub.yml');
      assert.strictEqual(full.outputDir, './reports');
      assert.strictEqual(full.format, 'csv');
      assert.strictEqual(full.concurrency, 10);
      assert.strictEqual(full.minDownloads, 5);
      assert.strictEqual(full.sourceFilter.source, 'github-.*');
      assert.strictEqual(full.bundleFilter.source, 'my-.*');
      assert.strictEqual(full.dryRun, true);
      assert.strictEqual(full.verbose, true);
    });

    it('should use defaults for missing options', () => {
      const defaults = parseArgs(['./hub.yml']);
      assert.strictEqual(defaults.hubSource, './hub.yml');
      assert.strictEqual(defaults.outputDir, './analytics-output');
      assert.strictEqual(defaults.format, 'all');
      assert.strictEqual(defaults.concurrency, 5);
      assert.strictEqual(defaults.minDownloads, 0);
      assert.strictEqual(defaults.dryRun, false);
      assert.strictEqual(defaults.verbose, false);
    });

    it('should parse --help flag', () => {
      assert.strictEqual(parseArgs(['--help']).help, true);
    });

    it('should throw on invalid regex for --source-filter', () => {
      assert.throws(() => {
        parseArgs(['--source-filter', '[invalid', './hub.yml']);
      }, /Invalid regex for --source-filter/);
    });

    it('should throw on invalid regex for --bundle-filter', () => {
      assert.throws(() => {
        parseArgs(['--bundle-filter', '(unclosed', './hub.yml']);
      }, /Invalid regex for --bundle-filter/);
    });

    it('should throw when flag is missing its value', () => {
      assert.throws(() => {
        parseArgs(['--output-dir']);
      }, /requires a value/);

      assert.throws(() => {
        parseArgs(['--format']);
      }, /requires a value/);

      assert.throws(() => {
        parseArgs(['--source-filter']);
      }, /requires a value/);
    });
  });

  describe('detectInputType()', () => {
    const { detectInputType } = analyzer;

    it('should detect local file path', () => {
      const result = detectInputType('./hub-config.yml');
      assert.strictEqual(result.type, 'local');
      assert.ok(result.path.includes('hub-config.yml'));
    });

    it('should detect direct YAML URL', () => {
      const result = detectInputType('https://github.com/owner/repo/raw/main/hub-config.yml');
      assert.strictEqual(result.type, 'yaml-url');
      assert.strictEqual(result.url, 'https://github.com/owner/repo/raw/main/hub-config.yml');
    });

    it('should detect GitHub repo URL with default path', () => {
      const result = detectInputType('https://github.com/Amadeus-xDLC/genai.prompt-registry-config');
      assert.strictEqual(result.type, 'github-repo');
      assert.strictEqual(result.owner, 'Amadeus-xDLC');
      assert.strictEqual(result.repo, 'genai.prompt-registry-config');
      assert.strictEqual(result.filePath, 'hub-config.yml');
      assert.strictEqual(result.ref, 'main');
    });

    it('should detect GitHub URLs with .yml/.yaml extension as yaml-url', () => {
      for (const url of [
        'https://github.com/owner/repo/tree/develop/config/hub.yml',
        'https://github.com/owner/repo/blob/feature/test/hub.yaml'
      ]) {
        const result = detectInputType(url);
        assert.strictEqual(result.type, 'yaml-url', `Expected yaml-url for ${url}`);
        assert.strictEqual(result.url, url);
      }
    });
  });

  describe('extractRepoInfo()', () => {
    const { extractRepoInfo } = analyzer;

    it('should extract from repository field', () => {
      assert.strictEqual(extractRepoInfo({ repository: 'owner/repo' }), 'owner/repo');
    });

    it('should extract from GitHub URL (with and without trailing slash)', () => {
      assert.strictEqual(extractRepoInfo({ url: 'https://github.com/owner/repo' }), 'owner/repo');
      assert.strictEqual(extractRepoInfo({ url: 'https://github.com/owner/repo/' }), 'owner/repo');
    });

    it('should return null for non-GitHub URL or missing repo info', () => {
      assert.strictEqual(extractRepoInfo({ url: 'https://gitlab.com/owner/repo' }), null);
      assert.strictEqual(extractRepoInfo({ type: 'local' }), null);
    });
  });

  describe('getGitHubSources()', () => {
    const { getGitHubSources } = analyzer;

    const mockHubConfig = {
      sources: [
        { id: 'src1', type: 'github', enabled: true, repository: 'owner/repo1' },
        { id: 'src2', type: 'github', enabled: false, repository: 'owner/repo2' },
        { id: 'src3', type: 'apm', enabled: true, repository: 'owner/repo3' },
        { id: 'src4', type: 'awesome-copilot', enabled: true, url: 'https://github.com/owner/repo4' },
        { id: 'src5', type: 'github', enabled: true, url: 'https://github.com/owner/repo5' },
        { id: 'src6', type: 'github', enabled: true } // no repo info
      ]
    };

    it('should filter enabled GitHub and APM sources only', () => {
      const result = getGitHubSources(mockHubConfig);

      assert.strictEqual(result.length, 3);
      assert.ok(result.some((s: any) => s.id === 'src1'));
      assert.ok(result.some((s: any) => s.id === 'src3'));
      assert.ok(result.some((s: any) => s.id === 'src5'));
    });

    it('should apply source filter regex', () => {
      const result = getGitHubSources(mockHubConfig, { sourceFilter: /src[13]/ });

      assert.strictEqual(result.length, 2);
      assert.ok(result.some((s: any) => s.id === 'src1'));
      assert.ok(result.some((s: any) => s.id === 'src3'));
    });

    it('should return empty array when no matching sources', () => {
      const result = getGitHubSources(mockHubConfig, { sourceFilter: /nonexistent/ });
      assert.strictEqual(result.length, 0);
    });
  });

  describe('loadHubConfig()', () => {
    const { loadHubConfig } = analyzer;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('hub-test-');
    });
    afterEach(() => {
      cleanup(tempDir);
    });

    it('should load and parse local YAML file', () => {
      const hubPath = path.join(tempDir, 'hub-config.yml');
      fs.writeFileSync(hubPath, `
version: '1.0.0'
metadata:
  name: Test Hub
  description: A test hub
  maintainer: test@example.com
  updatedAt: '2024-01-01T00:00:00Z'
sources:
  - id: test-src
    type: github
    enabled: true
    priority: 1
    repository: owner/repo
`);

      const result = loadHubConfig(hubPath);
      assert.strictEqual(result.version, '1.0.0');
      assert.strictEqual(result.metadata.name, 'Test Hub');
      assert.strictEqual(result.sources.length, 1);
      assert.strictEqual(result.sources[0].id, 'test-src');
    });

    it('should throw error for non-existent file', () => {
      assert.throws(() => {
        loadHubConfig(path.join(tempDir, 'nonexistent.yml'));
      }, /File not found/);
    });

    it('should fetch and parse hub config from GitHub repo', () => {
      const hubYaml = `
version: '1.0.0'
metadata:
  name: GitHub Hub
  description: From GitHub
  maintainer: gh@example.com
  updatedAt: '2024-01-01T00:00:00Z'
sources: []
`;
      const mockSpawnSync = createMockSpawnSync({
        '': { content: Buffer.from(hubYaml).toString('base64') }
      });

      const result = loadHubConfig('https://github.com/owner/repo', { spawnSync: mockSpawnSync });
      assert.strictEqual(result.version, '1.0.0');
      assert.strictEqual(result.metadata.name, 'GitHub Hub');
    });
  });

  describe('extractBundleInfo()', () => {
    const { extractBundleInfo } = analyzer;

    it('should extract bundle info from various filename formats', () => {
      const cases: [string, string | null, string | undefined][] = [
        ['my-bundle-1.2.3.zip', 'my-bundle', '1.2.3'],
        ['my-bundle-v2.0.0.zip', 'my-bundle', '2.0.0'],
        ['other-bundle-1.0.0.json', 'other-bundle', '1.0.0'],
        ['some-asset-latest.zip', 'some-asset-latest', 'unknown'],
        ['bundle-1.0.0-beta.1.zip', 'bundle', '1.0.0-beta.1'],
        ['my-bundle.bundle.zip', 'my-bundle', 'unknown'],
        ['my-bundle.bundle-1.0.0.zip', 'my-bundle', '1.0.0']
      ];
      for (const [filename, expectedId, expectedVersion] of cases) {
        const result = extractBundleInfo(filename);
        assert.strictEqual(result.bundleId, expectedId, `bundleId for ${filename}`);
        assert.strictEqual(result.version, expectedVersion, `version for ${filename}`);
      }
    });

    it('should return null for non-zip/json files', () => {
      assert.strictEqual(extractBundleInfo('readme.md'), null);
    });

    it('should normalize .bundle suffix so variants map to same bundleId', () => {
      const a = extractBundleInfo('workflow-nevio.bundle.zip');
      const b = extractBundleInfo('workflow-nevio-1.0.17.zip');
      assert.strictEqual(a.bundleId, b.bundleId);
    });
  });

  describe('processReleases()', () => {
    const { processReleases } = analyzer;

    const mockSource = {
      id: 'test-src',
      name: 'Test Source',
      repo: 'owner/repo',
      type: 'github' as const
    };

    const mockReleases = [
      {
        tag_name: 'v1.0.0',
        published_at: '2024-01-01T00:00:00Z',
        assets: [
          { name: 'bundle-a-1.0.0.zip', size: 1024, download_count: 100 },
          { name: 'bundle-b-1.0.0.zip', size: 2048, download_count: 200 },
          { name: 'readme.md', size: 100, download_count: 50 }
        ]
      },
      {
        tag_name: 'v2.0.0',
        published_at: '2024-02-01T00:00:00Z',
        assets: [
          { name: 'bundle-a-2.0.0.zip', size: 1536, download_count: 150 },
          { name: 'bundle-c-2.0.0.zip', size: 3072, download_count: 300 }
        ]
      }
    ];

    it('should extract all download records from releases', () => {
      const result = processReleases(mockSource, mockReleases);

      assert.strictEqual(result.length, 4);
      assert.ok(result.some((r: any) => r.bundleId === 'bundle-a' && r.version === '1.0.0'));
      assert.ok(result.some((r: any) => r.bundleId === 'bundle-a' && r.version === '2.0.0'));
      assert.ok(result.some((r: any) => r.bundleId === 'bundle-b' && r.version === '1.0.0'));
      assert.ok(result.some((r: any) => r.bundleId === 'bundle-c' && r.version === '2.0.0'));
    });

    it('should filter by minDownloads', () => {
      const result = processReleases(mockSource, mockReleases, { minDownloads: 150 });

      assert.strictEqual(result.length, 3);
      assert.ok(!result.some((r: any) => r.bundleId === 'bundle-a' && r.version === '1.0.0')); // 100 downloads
    });

    it('should filter by bundle regex', () => {
      const result = processReleases(mockSource, mockReleases, {
        bundleFilter: /bundle-a/
      });

      assert.strictEqual(result.length, 2);
      assert.ok(result.every((r: any) => r.bundleId === 'bundle-a'));
    });

    it('should include correct metadata in records', () => {
      const record = processReleases(mockSource, mockReleases)
        .find((r: any) => r.bundleId === 'bundle-a' && r.version === '1.0.0');
      assert.ok(record);
      assert.deepStrictEqual(
        {
          sourceId: record.sourceId,
          sourceName: record.sourceName,
          sourceRepo: record.sourceRepo,
          downloadCount: record.downloadCount,
          assetSize: record.assetSize,
          releaseTag: record.releaseTag,
          releaseDate: record.releaseDate
        },
        {
          sourceId: 'test-src',
          sourceName: 'Test Source',
          sourceRepo: 'owner/repo',
          downloadCount: 100,
          assetSize: 1024,
          releaseTag: 'v1.0.0',
          releaseDate: '2024-01-01T00:00:00Z'
        }
      );
    });
  });

  describe('aggregateData()', () => {
    const { aggregateData } = analyzer;

    const mockRecords = [
      {
        sourceId: 'src1', sourceName: 'Source 1', sourceRepo: 'owner/repo1', bundleId: 'bundle-a',
        version: '1.0.0', assetName: 'a-1.0.0.zip', assetSize: 1000, downloadCount: 100,
        releaseTag: 'v1.0.0', releaseDate: '2024-01-01'
      },
      {
        sourceId: 'src1', sourceName: 'Source 1', sourceRepo: 'owner/repo1', bundleId: 'bundle-a',
        version: '2.0.0', assetName: 'a-2.0.0.zip', assetSize: 1000, downloadCount: 200,
        releaseTag: 'v2.0.0', releaseDate: '2024-02-01'
      },
      {
        sourceId: 'src1', sourceName: 'Source 1', sourceRepo: 'owner/repo1', bundleId: 'bundle-b',
        version: '1.0.0', assetName: 'b-1.0.0.zip', assetSize: 1000, downloadCount: 50,
        releaseTag: 'v1.0.0', releaseDate: '2024-01-01'
      },
      {
        sourceId: 'src2', sourceName: 'Source 2', sourceRepo: 'owner/repo2', bundleId: 'bundle-a',
        version: '1.0.0', assetName: 'a-1.0.0.zip', assetSize: 1000, downloadCount: 150,
        releaseTag: 'v1.0.0', releaseDate: '2024-01-15'
      }
    ];

    it('should aggregate by source and bundle', () => {
      const result = aggregateData(mockRecords);

      // By source
      assert.strictEqual(result.bySource.length, 2);
      const src1 = result.bySource.find((s: any) => s.sourceId === 'src1');
      assert.ok(src1);
      assert.strictEqual(src1.totalDownloads, 350);
      assert.strictEqual(src1.bundleCount, 2);
      assert.strictEqual(src1.versionCount, 3);
      assert.strictEqual(src1.latestRelease, '2024-02-01');
      assert.strictEqual(result.bySource.find((s: any) => s.sourceId === 'src2').totalDownloads, 150);

      // By bundle
      assert.strictEqual(result.byBundle.length, 2);
      const bundleA = result.byBundle.find((b: any) => b.bundleId === 'bundle-a');
      assert.ok(bundleA);
      assert.strictEqual(bundleA.totalDownloads, 450);
      assert.strictEqual(bundleA.versionCount, 2);
      assert.strictEqual(bundleA.sourceCount, 2);
      const bundleB = result.byBundle.find((b: any) => b.bundleId === 'bundle-b');
      assert.strictEqual(bundleB.totalDownloads, 50);

      // Detailed
      assert.strictEqual(result.detailed.length, 4);
    });
  });

  describe('generateCsvReports()', () => {
    const { generateCsvReports } = analyzer;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('csv-test-');
    });
    afterEach(() => {
      cleanup(tempDir);
    });

    it('should generate all three CSV files with correct content', () => {
      const reports = generateCsvReports(sharedMockAggregated, tempDir, '2024-01-01');

      assert.strictEqual(reports.length, 3);
      for (const report of reports) {
        assert.ok(fs.existsSync(report.path), `File should exist: ${report.path}`);
      }

      const content = fs.readFileSync(path.join(tempDir, 'hub-analytics-2024-01-01-by-source.csv'), 'utf8');
      assert.ok(content.includes('Source ID,Source Name,Repository'));
      assert.ok(content.includes('src1,Source 1,owner/repo1'));
    });

    it('should properly escape CSV fields with commas', () => {
      const withComma = {
        ...sharedMockAggregated,
        bySource: [{ sourceId: 'src1', sourceName: 'Source, with comma', sourceRepo: 'owner/repo1', totalDownloads: 1000, bundleCount: 5, versionCount: 10, latestRelease: '2024-01-01' }],
        byBundle: [], detailed: []
      };
      generateCsvReports(withComma, tempDir, '2024-01-01');
      const content = fs.readFileSync(path.join(tempDir, 'hub-analytics-2024-01-01-by-source.csv'), 'utf8');
      assert.ok(content.includes('"Source, with comma"'));
    });
  });

  describe('generateMarkdownReport()', () => {
    const { generateMarkdownReport } = analyzer;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('md-test-');
    });
    afterEach(() => {
      cleanup(tempDir);
    });

    it('should generate markdown with summary, source, and bundle tables', () => {
      const report = generateMarkdownReport(sharedMockAggregated, tempDir, '2024-01-01', sharedMockArgs);

      assert.strictEqual(report.name, 'Markdown Summary');
      assert.ok(fs.existsSync(report.path));

      const content = fs.readFileSync(path.join(tempDir, 'hub-analytics-2024-01-01.md'), 'utf8');
      assert.ok(content.includes('# Hub Release Analytics Report'));
      assert.ok(content.includes('Total Sources'));
      assert.ok(content.includes('Total Bundles'));
      assert.ok(content.includes('## Downloads by Source'));
      assert.ok(content.includes('| Source ID | Source Name |'));
      assert.ok(content.includes('src1'));
      assert.ok(content.includes('## Downloads by Bundle'));
      assert.ok(content.includes('| Bundle ID | Primitives | Downloads |'));
      assert.ok(content.includes('bundle-a'));
    });

    it('should include primitives data when totals provided', () => {
      const totals = {
        totalSources: 2,
        totalBundles: 2,
        totalPrimitives: 15,
        nonGitHubBundles: [
          { sourceId: 'awesome-src', bundleId: 'awesome-bundle', primitiveCount: 3 }
        ],
        allBundleDetails: [
          { bundleId: 'bundle-a', primitiveCount: 5, sourceId: 'src1', isGitHub: true },
          { bundleId: 'awesome-bundle', primitiveCount: 3, sourceId: 'awesome-src', isGitHub: false }
        ]
      };

      generateMarkdownReport(sharedMockAggregated, tempDir, '2024-01-01', sharedMockArgs, totals);
      const content = fs.readFileSync(path.join(tempDir, 'hub-analytics-2024-01-01.md'), 'utf8');

      assert.ok(content.includes('Total Primitives'));
      assert.ok(content.includes('15'));
      assert.ok(content.includes('| bundle-a | 5 |'));
      assert.ok(content.includes('## Bundles from Non-GitHub Sources'));
      assert.ok(content.includes('| awesome-src | awesome-bundle | 3 |'));
    });
  });

  describe('fetchReleases()', () => {
    const { fetchReleases } = analyzer;

    it('should fetch releases via gh api', () => {
      const mockSpawnSync = createMockSpawnSync({
        '': [
          { tag_name: 'v1.0.0', assets: [] },
          { tag_name: 'v2.0.0', assets: [] }
        ]
      });

      const result = fetchReleases('owner/repo', { spawnSync: mockSpawnSync });

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].tag_name, 'v1.0.0');
    });

    it('should return empty array on error', () => {
      const mockSpawnSync = createMockSpawnSync({}, { status: 1, stderr: 'API error' });

      const result = fetchReleases('owner/repo', { spawnSync: mockSpawnSync, verbose: false });

      assert.strictEqual(result.length, 0);
    });
  });

  describe('processSources()', () => {
    const { processSources } = analyzer;

    const mockSources = [
      { id: 'src1', name: 'Source 1', repo: 'owner/repo1', type: 'github' },
      { id: 'src2', name: 'Source 2', repo: 'owner/repo2', type: 'github' },
      { id: 'src3', name: 'Source 3', repo: 'owner/repo3', type: 'github' }
    ];

    it('should process all sources and return records', () => {
      const mockSpawnSync = createMockSpawnSync({
        '': [
          {
            tag_name: 'v1.0.0',
            published_at: '2024-01-01T00:00:00Z',
            assets: [{ name: 'bundle-a-1.0.0.zip', size: 1024, download_count: 10 }]
          }
        ]
      });

      const result = processSources(mockSources, { spawnSync: mockSpawnSync });
      assert.strictEqual(result.length, 3);
    });

    it('should process sources in batches limited by concurrency', () => {
      const fiveSources = [
        { id: 'src1', name: 'S1', repo: 'owner/repo1', type: 'github' },
        { id: 'src2', name: 'S2', repo: 'owner/repo2', type: 'github' },
        { id: 'src3', name: 'S3', repo: 'owner/repo3', type: 'github' },
        { id: 'src4', name: 'S4', repo: 'owner/repo4', type: 'github' },
        { id: 'src5', name: 'S5', repo: 'owner/repo5', type: 'github' }
      ];

      const mockSpawnSync = createMockSpawnSync({
        '': [
          {
            tag_name: 'v1.0.0',
            published_at: '2024-01-01T00:00:00Z',
            assets: [{ name: 'bundle-a-1.0.0.zip', size: 1024, download_count: 10 }]
          }
        ]
      });

      // Capture verbose log output to observe batch structure
      const logs: string[] = [];
      // eslint-disable-next-line no-console -- Intentionally capturing console.log for test verification
      const origLog = console.log;
      // eslint-disable-next-line no-console -- Intentionally redirecting console.log to capture test output
      console.log = (msg: string) => {
        logs.push(String(msg));
      };
      try {
        processSources(fiveSources, { concurrency: 2, verbose: true, spawnSync: mockSpawnSync });
      } finally {
        // eslint-disable-next-line no-console -- Restoring console.log after test
        console.log = origLog;
      }

      // With concurrency=2 and 5 sources, expect 3 batches (2, 2, 1)
      const batchLogs = logs.filter((l) => l.includes('batch'));
      assert.strictEqual(batchLogs.length, 3, `Expected 3 batch logs, got: ${JSON.stringify(batchLogs)}`);
    });
  });

  describe('Integration - main() dry run', () => {
    const { main } = analyzer;
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('integration-');
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('should complete dry run without throwing', () => {
      const hubPath = path.join(tempDir, 'hub.yml');
      fs.writeFileSync(
        hubPath,
        `
version: '1.0.0'
metadata:
  name: Test Hub
  description: Test
  maintainer: test@example.com
  updatedAt: '2024-01-01T00:00:00Z'
sources:
  - id: test-src
    type: github
    enabled: true
    priority: 1
    repository: owner/repo
`
      );

      // main() is synchronous now; verify it completes without error
      assert.doesNotThrow(() =>
        main({
          argv: ['--dry-run', hubPath],
          env: {},
          spawnSync: () => ({ status: 0 }),
          logger: { log: () => {}, error: () => {} }
        })
      );
    });
  });

  describe('getAllEnabledSources()', () => {
    const { getAllEnabledSources } = analyzer;

    it('should return all enabled sources regardless of type', () => {
      const hubConfig = {
        sources: [
          { id: 'src1', enabled: true, type: 'github' },
          { id: 'src2', enabled: true, type: 'awesome-copilot' },
          { id: 'src3', enabled: false, type: 'github' },
          { id: 'src4', enabled: true, type: 'apm' }
        ]
      };

      const result = getAllEnabledSources(hubConfig, {});
      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(result.map((s: any) => s.id), ['src1', 'src2', 'src4']);
    });

    it('should apply sourceFilter regex', () => {
      const hubConfig = {
        sources: [
          { id: 'github-src', enabled: true },
          { id: 'awesome-src', enabled: true },
          { id: 'github-other', enabled: true }
        ]
      };

      const result = getAllEnabledSources(hubConfig, {
        sourceFilter: /^github-/
      });
      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result.map((s: any) => s.id), ['github-src', 'github-other']);
    });
  });

  describe('countBundlesFromAllSources()', () => {
    const { countBundlesFromAllSources } = analyzer;

    it('should count bundles and primitives from all sources', () => {
      const hubConfig = {
        sources: [
          {
            id: 'awesome-src',
            type: 'awesome-copilot',
            enabled: true,
            url: 'https://github.com/owner/awesome-repo',
            config: { branch: 'main', collectionsPath: 'collections' }
          },
          {
            id: 'github-src',
            type: 'github',
            enabled: true,
            repository: 'owner/github-repo',
            config: { branch: 'main', collectionsPath: 'collections' }
          }
        ]
      };

      const collectionYaml = 'id: test\nitems:\n  - path: test.prompt.md\n  - path: test.skill/SKILL.md\nmcpServers:\n  server1: {}';
      const collectionContent = { content: Buffer.from(collectionYaml).toString('base64') };

      const mockSpawnSync = createMockSpawnSync((apiPath: string) => {
        if (apiPath.includes('.collection.yml')) {
          return collectionContent;
        }
        if (apiPath.includes('owner/awesome-repo')) {
          return [
            { name: 'bundle-a.collection.yml' },
            { name: 'bundle-b.collection.yml' }
          ];
        }
        if (apiPath.includes('owner/github-repo')) {
          return [
            { name: 'bundle-c.collection.yml' }
          ];
        }
        return undefined;
      }, { status: 0, stdout: '[]' });

      const result = countBundlesFromAllSources(hubConfig, {
        verbose: false,
        spawnSync: mockSpawnSync
      });

      // 3 collections mocked (2 in awesome-repo, 1 in github-repo), each with 3 primitives (2 items + 1 mcpServer)
      assert.strictEqual(result.allBundleDetails.length, 3);
      assert.strictEqual(result.totalPrimitives, 9);
      assert.strictEqual(result.enabledSourceCount, 2);
      assert.strictEqual(result.nonGitHubBundles.length, 2);
    });
  });

  describe('formatNumber()', () => {
    const { formatNumber } = analyzer;

    it('should format numbers with commas', () => {
      assert.strictEqual(formatNumber(0), '0');
      assert.strictEqual(formatNumber(999), '999');
      assert.strictEqual(formatNumber(1000), '1,000');
      assert.strictEqual(formatNumber(1_234_567), '1,234,567');
    });
  });

  describe('formatBytes()', () => {
    const { formatBytes } = analyzer;

    it('should return 0 B for zero', () => {
      assert.strictEqual(formatBytes(0), '0 B');
    });

    it('should format bytes', () => {
      assert.strictEqual(formatBytes(512), '512 B');
    });

    it('should format kilobytes', () => {
      assert.strictEqual(formatBytes(1024), '1 KB');
      assert.strictEqual(formatBytes(1536), '1.5 KB');
    });

    it('should format megabytes', () => {
      assert.strictEqual(formatBytes(1_048_576), '1 MB');
    });
  });

  describe('escapeCsv()', () => {
    const { escapeCsv } = analyzer;

    it('should return simple values unchanged', () => {
      assert.strictEqual(escapeCsv('hello'), 'hello');
      assert.strictEqual(escapeCsv(123), '123');
    });

    it('should wrap values containing commas in quotes', () => {
      assert.strictEqual(escapeCsv('a,b'), '"a,b"');
    });

    it('should escape double quotes by doubling them', () => {
      assert.strictEqual(escapeCsv('say "hi"'), '"say ""hi"""');
    });

    it('should wrap values containing newlines in quotes', () => {
      assert.strictEqual(escapeCsv('line1\nline2'), '"line1\nline2"');
    });
  });

  describe('normalizeBundleId()', () => {
    const { normalizeBundleId } = analyzer;

    it('should strip .bundle suffix', () => {
      assert.strictEqual(normalizeBundleId('my-bundle.bundle'), 'my-bundle');
    });

    it('should leave IDs without .bundle unchanged', () => {
      assert.strictEqual(normalizeBundleId('my-bundle'), 'my-bundle');
    });
  });
});
