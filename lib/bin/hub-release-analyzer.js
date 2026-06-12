#!/usr/bin/env node
/**
 * Hub Release Analyzer
 * Analyzes GitHub release download statistics for prompt-registry hub configurations.
 *
 * Usage:
 *   hub-release-analyzer [OPTIONS] <HUB_SOURCE>
 *
 * Examples:
 *   hub-release-analyzer ./hub-config.yml
 *   hub-release-analyzer https://github.com/owner/repo
 *   hub-release-analyzer https://github.com/owner/repo/raw/main/hub-config.yml
 *   hub-release-analyzer https://github.com/owner/repo/tree/main/config/hub.yml
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const yaml = require('js-yaml');

// Parse command line arguments
function parseArgs(argv) {
  const args = {
    hubSource: null,
    outputDir: './analytics-output',
    format: 'all', // 'csv', 'md', 'all'
    concurrency: 5,
    minDownloads: 0,
    sourceFilter: null,
    bundleFilter: null,
    dryRun: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--output-dir' || arg === '-o') {
      args.outputDir = requireNextArg(argv, i++, arg);
    } else if (arg === '--format' || arg === '-f') {
      args.format = requireNextArg(argv, i++, arg);
    } else if (arg === '--concurrency' || arg === '-c') {
      args.concurrency = parseInt(requireNextArg(argv, i++, arg), 10) || 5;
    } else if (arg === '--min-downloads') {
      args.minDownloads = parseInt(requireNextArg(argv, i++, arg), 10) || 0;
    } else if (arg === '--source-filter') {
      args.sourceFilter = safeRegExp(requireNextArg(argv, i++, arg), 'source-filter');
    } else if (arg === '--bundle-filter') {
      args.bundleFilter = safeRegExp(requireNextArg(argv, i++, arg), 'bundle-filter');
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
    } else if (!arg.startsWith('-') && !args.hubSource) {
      args.hubSource = arg;
    }
  }

  return args;
}

// Require the next argument value, throwing if missing
function requireNextArg(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`Option ${flag} requires a value`);
  }
  return value;
}

// Safely compile a regex, throwing a user-friendly error on invalid patterns
function safeRegExp(pattern, name) {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex for --${name}: ${pattern} (${e.message})`);
  }
}

function showHelp() {
  console.log(`
Hub Release Analyzer
Analyzes GitHub release download statistics for prompt-registry hub configurations.

Usage:
  hub-release-analyzer [OPTIONS] <HUB_SOURCE>

Arguments:
  HUB_SOURCE              Hub config file path, GitHub repo URL, or direct YAML URL

Options:
  --output-dir, -o <dir>     Output directory for reports (default: ./analytics-output)
  --format, -f <formats>     Output formats: csv, md, all (default: all)
  --concurrency, -c <num>    Max concurrent API calls (default: 5)
  --min-downloads <num>      Filter out assets with fewer downloads (default: 0)
  --source-filter <pattern>  Regex filter for source IDs
  --bundle-filter <pattern>  Regex filter for bundle IDs
  --dry-run                  Show what would be analyzed without fetching
  --verbose, -v              Enable verbose logging
  --help, -h                 Show this help message

Examples:
  hub-release-analyzer ./hub-config.yml
  hub-release-analyzer https://github.com/Amadeus-xDLC/genai.prompt-registry-config
  hub-release-analyzer -o ./reports -f csv https://github.com/owner/repo/raw/main/hub-config.yml
`);
}

// Execute shell command
function execCommand(cmd, args, options = {}) {
  const { cwd, env, spawnSync } = options;
  const spawn = spawnSync || childProcess.spawnSync;
  const result = spawn(cmd, args, {
    cwd: cwd || process.cwd(),
    env: env || process.env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large API responses
  });

  if (result.status !== 0) {
    const err = result.stderr || result.stdout || `${cmd} ${args.join(' ')}`;
    throw new Error(err.trim());
  }

  return result.stdout;
}

// Detect input type and normalize
function detectInputType(source) {
  // Direct YAML URL
  if (/^https?:\/\/.*\.(ya?ml)(\?.*)?$/i.test(source)) {
    return { type: 'yaml-url', url: source };
  }

  // GitHub repository URL
  const githubRepoMatch = source.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(.*))?/);
  if (githubRepoMatch) {
    const [, owner, repo, rest] = githubRepoMatch;
    let filePath = 'hub-config.yml';
    let ref = 'main';

    if (rest) {
      // Parse /tree/branch/path or /blob/branch/path
      const treeMatch = rest.match(/^(?:tree|blob)\/([^/]+)(?:\/(.*))?/);
      if (treeMatch) {
        ref = treeMatch[1];
        filePath = treeMatch[2] || 'hub-config.yml';
      }
    }

    return {
      type: 'github-repo',
      owner,
      repo,
      filePath,
      ref,
      fullRepo: `${owner}/${repo}`,
    };
  }

  // Assume local file path
  return { type: 'local', path: path.resolve(source) };
}

// Load hub configuration based on input type
function loadHubConfig(source, options = {}) {
  const inputInfo = detectInputType(source);
  const { verbose, spawnSync } = options;

  if (verbose) {
    console.log(`Detected input type: ${inputInfo.type}`);
  }

  let yamlContent;

  switch (inputInfo.type) {
    case 'local': {
      if (!fs.existsSync(inputInfo.path)) {
        throw new Error(`File not found: ${inputInfo.path}`);
      }
      yamlContent = fs.readFileSync(inputInfo.path, 'utf8');
      break;
    }

    case 'yaml-url': {
      // Use gh api to fetch with authentication
      const apiPath = inputInfo.url.replace(/^https?:\/\/github\.com\//, '');
      const output = execCommand('gh', ['api', apiPath, '-H', 'Accept: application/vnd.github.v3.raw'], { spawnSync });
      yamlContent = output;
      break;
    }

    case 'github-repo': {
      // Fetch file content via GitHub API
      const apiUrl = `repos/${inputInfo.fullRepo}/contents/${inputInfo.filePath}?ref=${inputInfo.ref}`;
      const output = execCommand('gh', ['api', apiUrl], { spawnSync });
      const response = JSON.parse(output);

      if (response.content) {
        yamlContent = Buffer.from(response.content, 'base64').toString('utf8');
      } else if (response.download_url) {
        // Fallback: fetch raw content
        const rawOutput = execCommand('gh', ['api', response.download_url, '-H', 'Accept: application/vnd.github.v3.raw'], { spawnSync });
        yamlContent = rawOutput;
      } else {
        throw new Error('Unable to fetch hub configuration from GitHub');
      }
      break;
    }

    default:
      throw new Error(`Unknown input type: ${inputInfo.type}`);
  }

  return yaml.load(yamlContent);
}

// Extract repository info from various source formats
function extractRepoInfo(source) {
  const { type, repository, url } = source;

  if (repository) {
    return repository; // Already in owner/repo format
  }

  if (url) {
    // Parse URL to extract owner/repo
    const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/|$)/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  }

  return null;
}

// Get all enabled sources (for total counts)
function getAllEnabledSources(hubConfig, options = {}) {
  const { sourceFilter } = options;
  const sources = hubConfig.sources || [];

  return sources.filter((source) => {
    if (!source.enabled) {
      return false;
    }

    if (sourceFilter && !sourceFilter.test(source.id)) {
      return false;
    }

    return true;
  });
}

// Fetch and parse a single .collection.yml file, returning primitive count
function fetchCollectionPrimitives(repoInfo, collectionsPath, ref, collectionFile, options = {}) {
  const { verbose, spawnSync } = options;

  try {
    const apiUrl = `repos/${repoInfo}/contents/${collectionsPath}/${collectionFile}?ref=${ref}`;
    const output = execCommand('gh', ['api', apiUrl], { spawnSync });
    const response = JSON.parse(output);
    let yamlContent;

    if (response.content) {
      yamlContent = Buffer.from(response.content, 'base64').toString('utf8');
    } else {
      return 0;
    }

    const collection = yaml.load(yamlContent);
    const itemCount = (collection.items || []).length;
    const mcpCount = Object.keys(collection.mcpServers || collection.mcp?.items || {}).length;
    return itemCount + mcpCount;
  } catch (error) {
    if (verbose) {
      console.error(`    Error fetching ${collectionFile}: ${error.message}`);
    }
    return 0;
  }
}

// Scan a single source's collections and return bundle details
function fetchSourceBundleDetails(source, options = {}) {
  const { verbose, spawnSync } = options;
  const isGitHub = source.type === 'github' || source.type === 'apm';
  const repoInfo = extractRepoInfo(source);
  if (!repoInfo) {
    if (verbose) {
      console.log(`  Skipping source without repository: ${source.id}`);
    }
    return [];
  }

  const collectionsPath = source.config?.collectionsPath || 'collections';
  const ref = source.config?.branch || 'main';

  try {
    const apiUrl = `repos/${repoInfo}/contents/${collectionsPath}?ref=${ref}`;
    const output = execCommand('gh', ['api', apiUrl], { spawnSync });
    const files = JSON.parse(output);
    const collectionFiles = files.filter((f) => f.name.endsWith('.collection.yml'));

    if (verbose) {
      console.log(`  ${source.id}: found ${collectionFiles.length} collection(s) in ${collectionsPath}/`);
    }

    return collectionFiles.map((file) => {
      const bundleId = file.name.replace('.collection.yml', '');
      const primitiveCount = fetchCollectionPrimitives(repoInfo, collectionsPath, ref, file.name, { verbose, spawnSync });

      if (verbose) {
        console.log(`    ${bundleId}: ${primitiveCount} primitive(s)`);
      }

      return { sourceId: source.id, bundleId, primitiveCount, isGitHub };
    });
  } catch (error) {
    if (verbose) {
      console.error(`  Error fetching collections for ${source.id}: ${error.message}`);
    }
    return [];
  }
}

// Count bundles and primitives across all enabled sources
function countBundlesFromAllSources(hubConfig, options = {}) {
  const { sourceFilter } = options;
  const allSources = getAllEnabledSources(hubConfig, { sourceFilter });
  const allBundleDetails = allSources.flatMap((source) => fetchSourceBundleDetails(source, options));
  const nonGitHubBundles = allBundleDetails.filter((b) => !b.isGitHub);
  const totalPrimitives = allBundleDetails.reduce((sum, b) => sum + b.primitiveCount, 0);

  return {
    enabledSourceCount: allSources.length,
    nonGitHubBundles,
    allBundleDetails,
    totalPrimitives,
  };
}

// Filter and normalize GitHub sources from hub config
function getGitHubSources(hubConfig, options = {}) {
  const { sourceFilter, verbose } = options;
  const enabled = getAllEnabledSources(hubConfig, { sourceFilter });

  const githubSources = [];
  for (const source of enabled) {
    if (source.type !== 'github' && source.type !== 'apm') {
      if (verbose) {
        console.log(`Skipping non-GitHub source: ${source.id} (type: ${source.type})`);
      }
      continue;
    }

    const repoInfo = extractRepoInfo(source);
    if (!repoInfo) {
      if (verbose) {
        console.log(`Skipping source without repository: ${source.id}`);
      }
      continue;
    }

    githubSources.push({
      id: source.id,
      name: source.name || source.id,
      repo: repoInfo,
      type: source.type,
    });
  }

  return githubSources;
}

// Fetch releases for a single repository
function fetchReleases(repo, options = {}) {
  const { verbose, spawnSync } = options;

  if (verbose) {
    console.log(`  Fetching releases for ${repo}...`);
  }

  try {
    // Use --paginate to get all releases
    const output = execCommand('gh', ['api', `repos/${repo}/releases`, '--paginate'], { spawnSync });
    return JSON.parse(output);
  } catch (error) {
    if (verbose) {
      console.error(`  Error fetching releases for ${repo}: ${error.message}`);
    }
    return [];
  }
}

// Extract bundle info from asset name
function extractBundleInfo(assetName) {
  // Pattern: {bundle-id}-{semver}.zip or {bundle-id}-v{semver}.zip
  // Examples: my-bundle-1.2.3.zip, my-bundle-v1.2.3.zip

  if (!assetName.endsWith('.zip') && !assetName.endsWith('.json')) {
    return null;
  }

  // Remove .zip or .json extension
  const baseName = assetName.replace(/\.(zip|json)$/, '');

  // Try to match version pattern
  const versionMatch = baseName.match(/^(.*?)[-v]?(\d+\.\d+\.\d+.*?)$/);

  if (versionMatch) {
    return {
      bundleId: normalizeBundleId(versionMatch[1].replace(/-$/, '')),
      version: versionMatch[2],
      assetName,
    };
  }

  // Fallback: no version found, treat entire name as bundle ID
  return {
    bundleId: normalizeBundleId(baseName),
    version: 'unknown',
    assetName,
  };
}

// Normalize bundle ID by stripping .bundle suffix so that
// "workflow-nevio.bundle.zip" and "workflow-nevio-1.0.17.zip" aggregate together
function normalizeBundleId(bundleId) {
  return bundleId.replace(/\.bundle$/, '');
}

// Process releases and extract download records
function processReleases(source, releases, options = {}) {
  const { minDownloads = 0, bundleFilter, verbose } = options;
  const records = [];

  for (const release of releases) {
    const tagName = release.tag_name;
    const publishedAt = release.published_at;
    const assets = release.assets || [];

    for (const asset of assets) {
      const downloadCount = asset.download_count;

      if (downloadCount < minDownloads) {
        continue;
      }

      const bundleInfo = extractBundleInfo(asset.name);
      if (!bundleInfo) {
        continue;
      }

      if (bundleFilter && !bundleFilter.test(bundleInfo.bundleId)) {
        continue;
      }

      records.push({
        sourceId: source.id,
        sourceName: source.name,
        sourceRepo: source.repo,
        bundleId: bundleInfo.bundleId,
        version: bundleInfo.version === 'unknown' ? tagName.replace(/^v/, '') : bundleInfo.version,
        assetName: asset.name,
        assetSize: asset.size,
        downloadCount: downloadCount,
        releaseTag: tagName,
        releaseDate: publishedAt,
      });
    }
  }

  return records;
}

// Process sources in batches limited by concurrency
function processSources(sources, options = {}) {
  const { concurrency = 5, verbose, dryRun, spawnSync } = options;
  const allRecords = [];

  if (dryRun) {
    console.log('\nDRY RUN - Would analyze the following sources:');
    for (const source of sources) {
      console.log(`  - ${source.id} (${source.repo})`);
    }
    return [];
  }

  console.log(`\nAnalyzing ${sources.length} source(s)...`);

  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);

    if (verbose) {
      console.log(`\nProcessing batch ${Math.floor(i / concurrency) + 1} (${batch.length} sources)`);
    }

    for (const source of batch) {
      console.log(`\n[${source.id}] Analyzing ${source.name}...`);

      const releases = fetchReleases(source.repo, { verbose, spawnSync });

      if (releases.length === 0) {
        console.log(`  No releases found for ${source.repo}`);
        continue;
      }

      console.log(`  Found ${releases.length} release(s)`);

      const records = processReleases(source, releases, options);
      console.log(`  Extracted ${records.length} download record(s)`);

      allRecords.push(...records);
    }
  }

  return allRecords;
}

// Aggregate data by different dimensions
function aggregateData(records) {
  // By Source
  const bySource = new Map();

  // By Bundle
  const byBundle = new Map();

  for (const record of records) {
    // By Source aggregation
    if (!bySource.has(record.sourceId)) {
      bySource.set(record.sourceId, {
        sourceId: record.sourceId,
        sourceName: record.sourceName,
        sourceRepo: record.sourceRepo,
        totalDownloads: 0,
        bundleCount: new Set(),
        versionCount: new Set(),
        latestRelease: null,
      });
    }
    const sourceAgg = bySource.get(record.sourceId);
    sourceAgg.totalDownloads += record.downloadCount;
    sourceAgg.bundleCount.add(record.bundleId);
    sourceAgg.versionCount.add(`${record.bundleId}@${record.version}`);
    if (!sourceAgg.latestRelease || record.releaseDate > sourceAgg.latestRelease) {
      sourceAgg.latestRelease = record.releaseDate;
    }

    // By Bundle aggregation
    if (!byBundle.has(record.bundleId)) {
      byBundle.set(record.bundleId, {
        bundleId: record.bundleId,
        totalDownloads: 0,
        versionCount: new Set(),
        sourceCount: new Set(),
      });
    }
    const bundleAgg = byBundle.get(record.bundleId);
    bundleAgg.totalDownloads += record.downloadCount;
    bundleAgg.versionCount.add(record.version);
    bundleAgg.sourceCount.add(record.sourceId);
  }

  return {
    bySource: Array.from(bySource.values()).map((s) => ({
      ...s,
      bundleCount: s.bundleCount.size,
      versionCount: s.versionCount.size,
    })),
    byBundle: Array.from(byBundle.values()).map((b) => ({
      ...b,
      versionCount: b.versionCount.size,
      sourceCount: b.sourceCount.size,
    })),
    detailed: records,
  };
}

// Format number with commas (locale-independent)
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Format bytes to human-readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Escape CSV field
function escapeCsv(field) {
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Generate CSV reports
function generateCsvReports(aggregated, outputDir, timestamp) {
  const reports = [];

  // By Source report
  const sourceHeaders = ['Source ID', 'Source Name', 'Repository', 'Total Downloads', 'Bundle Count', 'Version Count', 'Latest Release'];
  const sourceRows = aggregated.bySource.map((s) => [
    s.sourceId,
    s.sourceName,
    s.sourceRepo,
    s.totalDownloads,
    s.bundleCount,
    s.versionCount,
    s.latestRelease || 'N/A',
  ]);

  const sourceCsv = [sourceHeaders.join(','), ...sourceRows.map((row) => row.map(escapeCsv).join(','))].join('\n');
  const sourcePath = path.join(outputDir, `hub-analytics-${timestamp}-by-source.csv`);
  fs.writeFileSync(sourcePath, sourceCsv);
  reports.push({ name: 'By Source', path: sourcePath, rows: sourceRows.length });

  // By Bundle report
  const bundleHeaders = ['Bundle ID', 'Total Downloads', 'Version Count', 'Source Count'];
  const bundleRows = aggregated.byBundle.map((b) => [
    b.bundleId,
    b.totalDownloads,
    b.versionCount,
    b.sourceCount,
  ]);

  const bundleCsv = [bundleHeaders.join(','), ...bundleRows.map((row) => row.map(escapeCsv).join(','))].join('\n');
  const bundlePath = path.join(outputDir, `hub-analytics-${timestamp}-by-bundle.csv`);
  fs.writeFileSync(bundlePath, bundleCsv);
  reports.push({ name: 'By Bundle', path: bundlePath, rows: bundleRows.length });

  // Detailed report
  const detailHeaders = ['Source ID', 'Source Name', 'Bundle ID', 'Version', 'Asset Name', 'Downloads', 'Asset Size', 'Release Tag', 'Release Date'];
  const detailRows = aggregated.detailed.map((d) => [
    d.sourceId,
    d.sourceName,
    d.bundleId,
    d.version,
    d.assetName,
    d.downloadCount,
    d.assetSize,
    d.releaseTag,
    d.releaseDate,
  ]);

  const detailCsv = [detailHeaders.join(','), ...detailRows.map((row) => row.map(escapeCsv).join(','))].join('\n');
  const detailPath = path.join(outputDir, `hub-analytics-${timestamp}-detailed.csv`);
  fs.writeFileSync(detailPath, detailCsv);
  reports.push({ name: 'Detailed', path: detailPath, rows: detailRows.length });

  return reports;
}

// Generate Markdown report
function generateMarkdownReport(aggregated, outputDir, timestamp, args, totals = {}) {
  const lines = [];

  lines.push('# Hub Release Analytics Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: ${args.hubSource}`);
  lines.push(`Min Downloads Filter: ${args.minDownloads}`);
  if (args.sourceFilter) {
    lines.push(`Source Filter: ${args.sourceFilter.source}`);
  }
  if (args.bundleFilter) {
    lines.push(`Bundle Filter: ${args.bundleFilter.source}`);
  }
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total Sources**: ${totals.totalSources || aggregated.bySource.length}`);
  lines.push(`- **Total Bundles**: ${totals.totalBundles || aggregated.byBundle.length}`);
  lines.push(`- **Total Primitives**: ${totals.totalPrimitives || 0}`);
  lines.push(`- **Total Records**: ${aggregated.detailed.length}`);
  lines.push(`- **Total Downloads**: ${formatNumber(aggregated.detailed.reduce((sum, d) => sum + d.downloadCount, 0))}`);
  lines.push('');

  // By Source section
  lines.push('## Downloads by Source');
  lines.push('');
  lines.push('| Source ID | Source Name | Repository | Downloads | Bundles | Versions | Latest Release |');
  lines.push('|-----------|-------------|------------|-----------|---------|----------|----------------|');

  // Sort by total downloads descending
  const sortedSources = [...aggregated.bySource].sort((a, b) => b.totalDownloads - a.totalDownloads);
  for (const s of sortedSources) {
    lines.push(
      `| ${s.sourceId} | ${s.sourceName} | ${s.sourceRepo} | ${formatNumber(s.totalDownloads)} | ${s.bundleCount} | ${s.versionCount} | ${s.latestRelease || 'N/A'} |`
    );
  }
  lines.push('');

  // By Bundle section
  // Build a lookup of primitive counts by bundleId
  const primitiveLookup = new Map();
  for (const bd of (totals.allBundleDetails || [])) {
    primitiveLookup.set(bd.bundleId, bd.primitiveCount);
  }

  lines.push('## Downloads by Bundle');
  lines.push('');
  lines.push('| Bundle ID | Primitives | Downloads | Versions | Sources |');
  lines.push('|-----------|------------|-----------|----------|---------|');

  const sortedBundles = [...aggregated.byBundle].sort((a, b) => b.totalDownloads - a.totalDownloads);
  for (const b of sortedBundles) {
    const primitives = primitiveLookup.get(b.bundleId) ?? '-';
    lines.push(
      `| ${b.bundleId} | ${primitives} | ${formatNumber(b.totalDownloads)} | ${b.versionCount} | ${b.sourceCount} |`
    );
  }
  lines.push('');

  // Non-GitHub bundles section (awesome-copilot sources)
  const nonGitHubBundles = totals.nonGitHubBundles || [];
  if (nonGitHubBundles.length > 0) {
    lines.push('## Bundles from Non-GitHub Sources (no download stats)');
    lines.push('');
    lines.push('| Source ID | Bundle ID | Primitives |');
    lines.push('|-----------|-----------|------------|');
    for (const b of nonGitHubBundles) {
      lines.push(`| ${b.sourceId} | ${b.bundleId} | ${b.primitiveCount} |`);
    }
    lines.push('');
  }

  // Detailed section (collapsible)
  lines.push('## Detailed Records');
  lines.push('');
  lines.push('| Source | Bundle | Version | Downloads | Size | Asset |');
  lines.push('|--------|--------|---------|-----------|------|-------|');

  const sortedDetailed = [...aggregated.detailed].sort((a, b) => b.downloadCount - a.downloadCount);
  // Limit to top 100 for markdown readability
  const topDetailed = sortedDetailed.slice(0, 100);

  for (const d of topDetailed) {
    lines.push(
      `| ${d.sourceId} | ${d.bundleId} | ${d.version} | ${formatNumber(d.downloadCount)} | ${formatBytes(d.assetSize)} | ${d.assetName} |`
    );
  }

  if (sortedDetailed.length > 100) {
    lines.push('');
    lines.push(`*Showing top 100 of ${sortedDetailed.length} records. See CSV for full data.*`);
  }

  lines.push('');

  const content = lines.join('\n');
  const filePath = path.join(outputDir, `hub-analytics-${timestamp}.md`);
  fs.writeFileSync(filePath, content);

  return { name: 'Markdown Summary', path: filePath, sources: sortedSources.length, bundles: sortedBundles.length };
}

// Main function
function main(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const env = opts.env || process.env;
  const spawnSync = opts.spawnSync || childProcess.spawnSync;

  const args = parseArgs(argv);

  if (args.help || !args.hubSource) {
    showHelp();
    return;
  }

  console.log(`Hub Release Analyzer`);
  console.log(`====================`);
  console.log(`Source: ${args.hubSource}`);
  console.log(`Output: ${path.resolve(args.outputDir)}`);

  // Load hub configuration
  console.log('\nLoading hub configuration...');
  const hubConfig = loadHubConfig(args.hubSource, { verbose: args.verbose, spawnSync });
  console.log(`Hub: ${hubConfig.metadata?.name || 'Unknown'}`);
  console.log(`Sources: ${hubConfig.sources?.length || 0} total`);

  // Count all enabled sources and bundles (including awesome-copilot)
  const bundleCounts = countBundlesFromAllSources(hubConfig, {
    sourceFilter: args.sourceFilter,
    verbose: args.verbose,
    spawnSync,
  });

  console.log(`Enabled sources: ${bundleCounts.enabledSourceCount}`);
  console.log(`Non-GitHub bundles: ${bundleCounts.nonGitHubBundles.length}`);
  console.log(`Total primitives: ${bundleCounts.totalPrimitives}`);

  // Extract GitHub sources (for download analytics)
  const githubSources = getGitHubSources(hubConfig, {
    sourceFilter: args.sourceFilter,
    verbose: args.verbose,
  });

  console.log(`GitHub sources to analyze: ${githubSources.length}`);

  if (githubSources.length === 0) {
    console.log('\nNo GitHub sources found to analyze.');
    return;
  }

  // Process sources
  const records = processSources(githubSources, {
    concurrency: args.concurrency,
    verbose: args.verbose,
    dryRun: args.dryRun,
    minDownloads: args.minDownloads,
    bundleFilter: args.bundleFilter,
    spawnSync,
  });

  if (args.dryRun) {
    console.log('\nDry run complete. No data fetched.');
    return;
  }

  if (records.length === 0) {
    console.log('\nNo download records found.');
    return;
  }

  console.log(`\nTotal records collected: ${records.length}`);

  // Aggregate data
  console.log('\nAggregating data...');
  const aggregated = aggregateData(records);

  // Compute total bundles: unique bundles from GitHub releases + bundles from non-GitHub sources
  const allBundleIds = new Set(aggregated.byBundle.map((b) => b.bundleId));
  for (const b of bundleCounts.nonGitHubBundles) {
    allBundleIds.add(b.bundleId);
  }
  const totalBundles = allBundleIds.size;

  console.log(`  Sources (with downloads): ${aggregated.bySource.length}`);
  console.log(`  Bundles (with downloads): ${aggregated.byBundle.length}`);
  console.log(`  Non-GitHub bundles: ${bundleCounts.nonGitHubBundles.length}`);
  console.log(`  Total unique bundles: ${totalBundles}`);
  console.log(`  Detailed records: ${aggregated.detailed.length}`);

  // Create output directory
  if (!fs.existsSync(args.outputDir)) {
    fs.mkdirSync(args.outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Generate reports
  console.log('\nGenerating reports...');

  const reports = [];

  if (args.format === 'csv' || args.format === 'all') {
    const csvReports = generateCsvReports(aggregated, args.outputDir, timestamp);
    reports.push(...csvReports);
  }

  if (args.format === 'md' || args.format === 'all') {
    const mdReport = generateMarkdownReport(aggregated, args.outputDir, timestamp, args, {
      totalSources: bundleCounts.enabledSourceCount,
      totalBundles: totalBundles,
      totalPrimitives: bundleCounts.totalPrimitives,
      nonGitHubBundles: bundleCounts.nonGitHubBundles,
      allBundleDetails: bundleCounts.allBundleDetails,
    });
    reports.push(mdReport);
  }

  // Print summary
  console.log('\n========================================');
  console.log('Reports Generated');
  console.log('========================================');
  for (const report of reports) {
    console.log(`  ${report.name}: ${report.path}`);
  }

  console.log('\nDone!');
}

module.exports = {
  main,
  parseArgs,
  requireNextArg,
  safeRegExp,
  detectInputType,
  loadHubConfig,
  extractRepoInfo,
  getAllEnabledSources,
  fetchSourceBundleDetails,
  countBundlesFromAllSources,
  getGitHubSources,
  fetchReleases,
  extractBundleInfo,
  normalizeBundleId,
  processReleases,
  processSources,
  aggregateData,
  formatNumber,
  formatBytes,
  escapeCsv,
  generateCsvReports,
  generateMarkdownReport,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`\n❌ Error: ${e.message}`);
    if (process.env.DEBUG) {
      console.error(e.stack);
    }
    process.exit(1);
  }
}
