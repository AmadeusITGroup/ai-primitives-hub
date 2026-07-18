#!/usr/bin/env node
/**
 * Hub Ownership Analyzer
 * For each repository in a hub-config.yml, resolves who owns / maintains it via
 * a two-tier priority chain:
 *   1. CODEOWNERS file (.github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS)
 *   2. Authors of the most recent commits (fallback when no CODEOWNERS file)
 *
 * Usage:
 *   hub-ownership-analyzer [OPTIONS] <HUB_SOURCE>
 *
 * Examples:
 *   hub-ownership-analyzer ./hub-config.yml
 *   hub-ownership-analyzer https://github.com/owner/repo
 *   hub-ownership-analyzer https://github.com/owner/repo/blob/main/hub-config.yml
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    hubSource: null,
    outputDir: './ownership-output',
    format: 'all', // 'md', 'json', 'all'
    includeDisabled: false,
    maxCommitAuthors: 5, // how many recent commit authors to show in fallback
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
    } else if (arg === '--include-disabled') {
      args.includeDisabled = true;
    } else if (arg === '--max-commit-authors') {
      args.maxCommitAuthors = parseInt(requireNextArg(argv, i++, arg), 10) || 5;
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

function requireNextArg(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`Option ${flag} requires a value`);
  return value;
}

function showHelp() {
  console.log(`
Hub Ownership Analyzer
For each repository in a hub-config.yml, shows who owns or can merge via:
  1. CODEOWNERS file  2. Recent commit authors (fallback)

Usage:
  hub-ownership-analyzer [OPTIONS] <HUB_SOURCE>

Arguments:
  HUB_SOURCE                 Hub config file, GitHub repo URL, or direct YAML URL

Options:
  --output-dir, -o <dir>     Output directory (default: ./ownership-output)
  --format, -f <fmt>         Output formats: md, json, all (default: all)
  --include-disabled         Also analyze disabled sources
  --max-commit-authors <n>   Max commit authors to show in fallback (default: 5)
  --dry-run                  List sources without fetching data
  --verbose, -v              Verbose logging
  --help, -h                 Show this help

Examples:
  hub-ownership-analyzer ./hub-config.yml
  hub-ownership-analyzer https://github.com/Amadeus-xDLC/genai.prompt-registry-config
  hub-ownership-analyzer -o ./reports https://github.com/owner/repo/blob/main/hub-config.yml
`);
}

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

function execCommand(cmd, cmdArgs, options = {}) {
  const { spawnSync: spawnFn } = options;
  const spawn = spawnFn || childProcess.spawnSync;
  const result = spawn(cmd, cmdArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const err = result.stderr || result.stdout || `${cmd} ${cmdArgs.join(' ')}`;
    throw new Error(err.trim());
  }

  return result.stdout;
}

// ---------------------------------------------------------------------------
// Hub config loading (same pattern as hub-release-analyzer)
// ---------------------------------------------------------------------------

function detectInputType(source) {
  // GitHub URLs first so blob/tree paths with .yml extension are handled correctly
  const githubMatch = source.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(.*))?/);
  if (githubMatch) {
    const [, owner, repo, rest] = githubMatch;
    let filePath = 'hub-config.yml';
    let ref = 'main';
    if (rest) {
      const treeMatch = rest.match(/^(?:tree|blob)\/([^/]+)(?:\/(.*))?/);
      if (treeMatch) {
        ref = treeMatch[1];
        filePath = treeMatch[2] || 'hub-config.yml';
      }
    }
    return { type: 'github-repo', filePath, ref, fullRepo: `${owner}/${repo}` };
  }

  if (/^https?:\/\/.*\.(ya?ml)(\?.*)?$/i.test(source)) {
    return { type: 'yaml-url', url: source };
  }

  return { type: 'local', path: path.resolve(source) };
}

function loadHubConfig(source, options = {}) {
  const info = detectInputType(source);
  const { verbose, spawnSync } = options;
  if (verbose) console.log(`Detected input type: ${info.type}`);

  let yamlContent;

  switch (info.type) {
    case 'local': {
      if (!fs.existsSync(info.path)) throw new Error(`File not found: ${info.path}`);
      yamlContent = fs.readFileSync(info.path, 'utf8');
      break;
    }
    case 'yaml-url': {
      const apiPath = info.url.replace(/^https?:\/\/github\.com\//, '');
      yamlContent = execCommand('gh', ['api', apiPath, '-H', 'Accept: application/vnd.github.v3.raw'], { spawnSync });
      break;
    }
    case 'github-repo': {
      const apiUrl = `repos/${info.fullRepo}/contents/${info.filePath}?ref=${info.ref}`;
      const output = execCommand('gh', ['api', apiUrl], { spawnSync });
      const response = JSON.parse(output);
      if (response.content) {
        yamlContent = Buffer.from(response.content, 'base64').toString('utf8');
      } else if (response.download_url) {
        yamlContent = execCommand('gh', ['api', response.download_url, '-H', 'Accept: application/vnd.github.v3.raw'], { spawnSync });
      } else {
        throw new Error('Unable to fetch hub configuration from GitHub');
      }
      break;
    }
    default:
      throw new Error(`Unknown input type: ${info.type}`);
  }

  return yaml.load(yamlContent);
}

function extractRepoInfo(source) {
  if (source.repository) return source.repository;
  if (source.url) {
    const m = source.url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/|$)/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 1: CODEOWNERS
// ---------------------------------------------------------------------------

function fetchCodeowners(repoInfo, ref, options = {}) {
  const { verbose, spawnSync } = options;
  const candidates = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

  for (const filePath of candidates) {
    try {
      const output = execCommand('gh', ['api', `repos/${repoInfo}/contents/${filePath}?ref=${ref}`], { spawnSync });
      const response = JSON.parse(output);
      if (response.content) {
        const content = Buffer.from(response.content, 'base64').toString('utf8');
        if (verbose) console.log(`    [tier-1] CODEOWNERS found at ${filePath}`);
        return { path: filePath, content };
      }
    } catch (_) {
      // not at this path
    }
  }

  if (verbose) console.log(`    [tier-1] No CODEOWNERS file`);
  return null;
}

function parseCodeowners(content) {
  const owners = new Set();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].startsWith('@')) owners.add(tokens[i]);
    }
  }
  return Array.from(owners).sort();
}

// ---------------------------------------------------------------------------
// Tier 2: Recent commit authors (fallback)
// ---------------------------------------------------------------------------

function fetchRecentCommitAuthors(repoInfo, ref, maxAuthors, options = {}) {
  const { verbose, spawnSync } = options;
  try {
    const output = execCommand(
      'gh',
      ['api', `repos/${repoInfo}/commits?sha=${ref}&per_page=30`],
      { spawnSync }
    );
    const commits = JSON.parse(output);
    const seen = new Set();
    const authors = [];
    for (const c of commits) {
      const login = c.author?.login;
      const name = c.commit?.author?.name;
      const handle = login ? `@${login}` : name || null;
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        authors.push(handle);
        if (authors.length >= maxAuthors) break;
      }
    }
    if (verbose) console.log(`    [tier-2] ${authors.length} recent commit author(s)`);
    return authors;
  } catch (err) {
    if (verbose) console.log(`    [tier-2] Cannot list commits: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Repository metadata
// ---------------------------------------------------------------------------

function fetchRepoMetadata(repoInfo, options = {}) {
  const { verbose, spawnSync } = options;
  try {
    const data = JSON.parse(execCommand('gh', ['api', `repos/${repoInfo}`], { spawnSync }));
    return {
      owner: data.owner?.login || repoInfo.split('/')[0],
      ownerType: data.owner?.type || 'Unknown',
      description: data.description || '',
      defaultBranch: data.default_branch || 'main',
      private: data.private || false,
    };
  } catch (err) {
    if (verbose) console.error(`    Error fetching repo metadata: ${err.message}`);
    return {
      owner: repoInfo.split('/')[0],
      ownerType: 'Unknown',
      description: '',
      defaultBranch: 'main',
      private: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function analyzeSources(hubConfig, args, options = {}) {
  const { verbose, dryRun } = args;
  const { spawnSync } = options;
  const sources = (hubConfig.sources || []).filter(
    (s) => args.includeDisabled || s.enabled !== false
  );

  console.log(`\nAnalyzing ${sources.length} source(s)...`);

  return sources.map((source) => {
    const repoInfo = extractRepoInfo(source);
    const entry = {
      id: source.id,
      name: source.name || source.id,
      type: source.type,
      enabled: source.enabled !== false,
      repoInfo,
      url: source.url || (repoInfo ? `https://github.com/${repoInfo}` : null),
      owner: null,
      ownerType: null,
      repoDescription: null,
      private: null,
      // Tier results
      codeownersPath: null,
      codeowners: [],
      recentCommitAuthors: [],
      // Resolved contacts (best available tier)
      contactsSource: 'none', // 'codeowners' | 'commits' | 'none'
      contacts: [],
    };

    if (!repoInfo) {
      console.log(`  [${source.id}] No GitHub repository — skipping`);
      return entry;
    }

    console.log(`  [${source.id}] ${repoInfo}`);

    if (dryRun) return entry;

    // Repo metadata
    const meta = fetchRepoMetadata(repoInfo, { verbose, spawnSync });
    const ref = source.config?.branch || meta.defaultBranch;
    entry.owner = meta.owner;
    entry.ownerType = meta.ownerType;
    entry.repoDescription = meta.description;
    entry.private = meta.private;

    if (verbose) console.log(`    Owner: ${meta.owner} (${meta.ownerType})`);

    // --- Tier 1: CODEOWNERS ---
    const codeownersResult = fetchCodeowners(repoInfo, ref, { verbose, spawnSync });
    if (codeownersResult) {
      entry.codeownersPath = codeownersResult.path;
      entry.codeowners = parseCodeowners(codeownersResult.content);
    }

    if (entry.codeowners.length > 0) {
      entry.contactsSource = 'codeowners';
      entry.contacts = entry.codeowners;
      console.log(`    contacts (CODEOWNERS): ${entry.contacts.join(', ')}`);
      return entry;
    }

    // --- Tier 2: recent commit authors (fallback) ---
    entry.recentCommitAuthors = fetchRecentCommitAuthors(repoInfo, ref, args.maxCommitAuthors, { verbose, spawnSync });

    if (entry.recentCommitAuthors.length > 0) {
      entry.contactsSource = 'commits';
      entry.contacts = entry.recentCommitAuthors;
      console.log(`    contacts (recent commits): ${entry.contacts.join(', ')}`);
      return entry;
    }

    console.log(`    contacts: none found`);
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const TIER_LABEL = {
  codeowners: 'CODEOWNERS',
  commits: 'recent commits',
  none: '—',
};

function generateMarkdownReport(results, hubConfig, args, generatedAt) {
  const lines = [];

  lines.push('# Hub Ownership Report');
  lines.push('');
  lines.push(`Hub: **${hubConfig.metadata?.name || 'Unknown'}**`);
  lines.push(`Source: ${args.hubSource}`);
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');

  const withRepo = [];
  const noRepo = [];
  let countCODEOWNERS = 0, countCommits = 0, countNone = 0;
  for (const r of results) {
    if (r.repoInfo) {
      withRepo.push(r);
      if (r.contactsSource === 'codeowners') countCODEOWNERS++;
      else if (r.contactsSource === 'commits') countCommits++;
      else countNone++;
    } else {
      noRepo.push(r);
    }
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total sources analyzed**: ${results.length}`);
  lines.push(`- **With GitHub repository**: ${withRepo.length}`);
  lines.push(`- **With resolved contacts**: ${countCODEOWNERS + countCommits}`);
  lines.push(`  - via CODEOWNERS: ${countCODEOWNERS}`);
  lines.push(`  - via recent commits: ${countCommits}`);
  lines.push(`- **No contacts found**: ${countNone}`);
  lines.push(`- **No repository URL**: ${noRepo.length}`);
  lines.push('');

  lines.push('## Contacts per Repository');
  lines.push('');
  lines.push('| Source ID | Repository | Org Owner | Contacts | Source |');
  lines.push('|-----------|------------|-----------|----------|--------|');

  for (const r of results) {
    const repoCell = r.repoInfo ? `[${r.repoInfo}](${r.url})` : '—';
    const ownerCell = r.owner || (r.repoInfo ? r.repoInfo.split('/')[0] : '—');
    const contactsCell = r.contacts.length > 0 ? r.contacts.join(', ') : '—';
    const sourceCell = TIER_LABEL[r.contactsSource] || '—';
    const badge = r.enabled ? '' : ' _(off)_';
    lines.push(`| ${r.id}${badge} | ${repoCell} | ${ownerCell} | ${contactsCell} | ${sourceCell} |`);
  }

  lines.push('');
  lines.push('## Details per Source');
  lines.push('');

  for (const r of withRepo) {
    const badge = r.enabled ? '' : ' _(disabled)_';
    lines.push(`### ${r.id}${badge}`);
    lines.push('');
    lines.push(`- **Repository**: [${r.repoInfo}](${r.url})`);
    lines.push(`- **Org owner**: ${r.owner || r.repoInfo.split('/')[0]}${r.ownerType ? ` (${r.ownerType})` : ''}`);
    if (r.repoDescription) lines.push(`- **Description**: ${r.repoDescription}`);

    if (r.codeownersPath) {
      lines.push(`- **CODEOWNERS** (\`${r.codeownersPath}\`): ${r.codeowners.length > 0 ? r.codeowners.join(', ') : '_empty_'}`);
    } else {
      lines.push(`- **CODEOWNERS**: _none_`);
    }

    if (r.recentCommitAuthors.length > 0) {
      lines.push(`- **Recent commit authors**: ${r.recentCommitAuthors.join(', ')}`);
    }

    lines.push(`- **Resolved contacts** _(${TIER_LABEL[r.contactsSource]})_: ${r.contacts.length > 0 ? r.contacts.join(', ') : '—'}`);
    lines.push('');
  }

  if (noRepo.length > 0) {
    lines.push('## Sources Without a GitHub Repository');
    lines.push('');
    lines.push('| Source ID | Name | Type |');
    lines.push('|-----------|------|------|');
    for (const r of noRepo) {
      lines.push(`| ${r.id} | ${r.name} | ${r.type} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateJsonReport(results, hubConfig, args, generatedAt) {
  return JSON.stringify(
    { hub: hubConfig.metadata?.name || 'Unknown', source: args.hubSource, generatedAt, sources: results },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const spawnSync = opts.spawnSync || childProcess.spawnSync;
  const args = parseArgs(argv);

  if (args.help || !args.hubSource) {
    showHelp();
    return;
  }

  console.log(`Hub Ownership Analyzer`);
  console.log(`======================`);
  console.log(`Source: ${args.hubSource}`);
  console.log(`Output: ${path.resolve(args.outputDir)}`);

  console.log('\nLoading hub configuration...');
  const hubConfig = loadHubConfig(args.hubSource, { verbose: args.verbose, spawnSync });
  console.log(`Hub: ${hubConfig.metadata?.name || 'Unknown'}`);
  console.log(`Sources: ${hubConfig.sources?.length || 0} total`);

  const results = analyzeSources(hubConfig, args, { spawnSync });

  if (args.dryRun) {
    console.log('\nDry run complete — no ownership data fetched.');
    return;
  }

  if (!fs.existsSync(args.outputDir)) {
    fs.mkdirSync(args.outputDir, { recursive: true });
  }

  const generatedAt = new Date().toISOString();
  const timestamp = generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const reports = [];

  if (args.format === 'md' || args.format === 'all') {
    const content = generateMarkdownReport(results, hubConfig, args, generatedAt);
    const filePath = path.join(args.outputDir, `hub-ownership-${timestamp}.md`);
    fs.writeFileSync(filePath, content);
    reports.push({ name: 'Markdown', path: filePath });
  }

  if (args.format === 'json' || args.format === 'all') {
    const content = generateJsonReport(results, hubConfig, args, generatedAt);
    const filePath = path.join(args.outputDir, `hub-ownership-${timestamp}.json`);
    fs.writeFileSync(filePath, content);
    reports.push({ name: 'JSON', path: filePath });
  }

  console.log('\n========================================');
  console.log('Reports Generated');
  console.log('========================================');
  for (const report of reports) {
    console.log(`  ${report.name}: ${report.path}`);
  }

  console.log('\n--- Ownership Summary ---');
  for (const r of results) {
    if (!r.repoInfo) continue;
    const label = TIER_LABEL[r.contactsSource] || '—';
    const contactStr = r.contacts.length > 0 ? r.contacts.join(', ') : 'none found';
    console.log(`  ${r.id} → ${r.owner || r.repoInfo.split('/')[0]} | [${label}] ${contactStr}`);
  }

  console.log('\nDone!');
}

module.exports = {
  main,
  parseArgs,
  detectInputType,
  loadHubConfig,
  extractRepoInfo,
  fetchCodeowners,
  parseCodeowners,
  fetchRecentCommitAuthors,
  fetchRepoMetadata,
  analyzeSources,
  generateMarkdownReport,
  generateJsonReport,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`\nError: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}
