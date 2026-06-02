/* eslint-disable no-console -- CLI script uses console for output */
/**
 * Discussion Setup Tool for Engagement Data Collection
 *
 * This admin tool:
 * 1. Fetches hub configuration from a GitHub repository
 * 2. Extracts engagement repository coordinates
 * 3. Iterates through all bundles from hub sources
 * 4. Creates GitHub Discussions for each bundle to collect ratings/feedback
 * 5. Outputs a collections.yaml mapping file for compute-ratings
 */

import * as fs from 'node:fs';
import axios from 'axios';
import * as yaml from 'js-yaml';

// ============================================================================
// Types
// ============================================================================

/**
 * Hub configuration structure (simplified for this tool)
 */
interface HubConfig {
  version: string;
  metadata: {
    name: string;
    description: string;
    maintainer: string;
  };
  sources: HubSource[];
  profiles: HubProfile[];
  engagement?: HubEngagementConfig;
}

interface HubSource {
  id: string;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
}

interface HubProfile {
  id: string;
  name: string;
  description?: string;
  bundles: HubProfileBundle[];
}

interface HubProfileBundle {
  id: string;
  version: string;
  source: string;
  required: boolean;
}

interface HubEngagementConfig {
  enabled: boolean;
  backend?: {
    type: string;
    repository: string;
    category?: string;
  };
  ratings?: {
    enabled: boolean;
    ratingsUrl?: string;
  };
  feedback?: {
    enabled: boolean;
    feedbackUrl?: string;
  };
}

/**
 * Bundle info extracted from hub
 */
interface BundleInfo {
  bundleId: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  profiles: string[];
}

/**
 * Discussion creation result
 */
interface DiscussionResult {
  bundleId: string;
  sourceId: string;
  discussionNumber: number;
  discussionUrl: string;
  created: boolean;
  error?: string;
}

/* eslint-disable @typescript-eslint/naming-convention -- snake_case fields mirror collections.yaml and GitHub API response structures */
/**
 * Collections.yaml output structure
 */
interface CollectionsConfig {
  repository: string;
  category_id?: string;
  collections: CollectionMapping[];
}

interface CollectionMapping {
  id: string;
  source_id: string;
  discussion_number: number;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * GitHub Discussion category
 */
interface DiscussionCategory {
  id: string;
  name: string;
  slug: string;
  isAnswerable: boolean;
}

/**
 * GitHub GraphQL response types
 */
interface GraphQLDiscussion {
  number: number;
  title: string;
  url: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

// ============================================================================
// GitHub API Functions
// ============================================================================

/**
 * Fetch hub configuration from GitHub repository
 * @param owner
 * @param repo
 * @param branch
 * @param token
 */
async function fetchHubConfig(
    owner: string,
    repo: string,
    branch: string,
    token: string
): Promise<HubConfig> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/hub-config.yml`;

  try {
    const response = await axios.get(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    return yaml.load(response.data as string) as HubConfig;
  } catch (error: unknown) {
    const err = error as { response?: { status: number }; message?: string };
    if (err.response?.status === 404) {
      throw new Error(`Hub config not found at ${url}`);
    }
    throw new Error(`Failed to fetch hub config: ${err.message ?? String(error)}`);
  }
}

/**
 * Get discussion categories for a repository using GraphQL
 * @param owner
 * @param repo
 * @param token
 */
async function getDiscussionCategories(
    owner: string,
    repo: string,
    token: string
): Promise<DiscussionCategory[]> {
  const query = `
        query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
                discussionCategories(first: 25) {
                    nodes {
                        id
                        name
                        slug
                        isAnswerable
                    }
                }
            }
        }
    `;

  const response = await axios.post(
    'https://api.github.com/graphql',
    { query, variables: { owner, repo } },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const responseData = response.data as GraphQLResponse<{ repository: { discussionCategories: { nodes: DiscussionCategory[] } } }>;
  if (responseData.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(responseData.errors)}`);
  }

  return responseData.data?.repository.discussionCategories.nodes ?? [];
}

/**
 * Get repository ID for GraphQL mutations
 * @param owner
 * @param repo
 * @param token
 */
async function getRepositoryId(
    owner: string,
    repo: string,
    token: string
): Promise<string> {
  const query = `
        query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
                id
            }
        }
    `;

  const response = await axios.post(
    'https://api.github.com/graphql',
    { query, variables: { owner, repo } },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const responseData = response.data as GraphQLResponse<{ repository: { id: string } }>;
  if (responseData.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(responseData.errors)}`);
  }

  return responseData.data?.repository.id ?? '';
}

/**
 * Search for existing discussion by title
 * Note: GitHub GraphQL API doesn't support searching discussions by title,
 * so we fetch recent discussions and filter client-side
 * @param owner
 * @param repo
 * @param title
 * @param token
 */
async function findExistingDiscussion(
    owner: string,
    repo: string,
    title: string,
    token: string
): Promise<GraphQLDiscussion | null> {
  const query = `
        query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
                discussions(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
                    nodes {
                        number
                        title
                        url
                    }
                }
            }
        }
    `;

  const response = await axios.post(
    'https://api.github.com/graphql',
    { query, variables: { owner, repo } },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const responseData = response.data as GraphQLResponse<{ repository: { discussions: { nodes: GraphQLDiscussion[] } } }>;
  if (responseData.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(responseData.errors)}`);
  }

  const discussions = responseData.data?.repository.discussions.nodes ?? [];
  return discussions.find((d) => d.title === title) ?? null;
}

/**
 * Create a new GitHub Discussion
 * @param repositoryId
 * @param categoryId
 * @param title
 * @param body
 * @param token
 */
async function createDiscussion(
    repositoryId: string,
    categoryId: string,
    title: string,
    body: string,
    token: string
): Promise<GraphQLDiscussion> {
  const mutation = `
        mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
            createDiscussion(input: {
                repositoryId: $repositoryId,
                categoryId: $categoryId,
                title: $title,
                body: $body
            }) {
                discussion {
                    number
                    title
                    url
                }
            }
        }
    `;

  const response = await axios.post(
    'https://api.github.com/graphql',
    {
      query: mutation,
      variables: { repositoryId, categoryId, title, body }
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const responseData = response.data as GraphQLResponse<{ createDiscussion: { discussion: GraphQLDiscussion } }>;
  if (responseData.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(responseData.errors)}`);
  }

  if (!responseData.data) {
    throw new Error('No data returned from createDiscussion mutation');
  }
  return responseData.data.createDiscussion.discussion;
}

// ============================================================================
// Bundle Extraction
// ============================================================================

/**
 * Extract all unique bundles from hub configuration
 * @param hubConfig
 */
function extractBundlesFromHub(hubConfig: HubConfig): BundleInfo[] {
  const bundlesMap = new Map<string, BundleInfo>();

  // Build source lookup
  const sourceLookup = new Map<string, HubSource>();
  for (const source of hubConfig.sources) {
    sourceLookup.set(source.id, source);
  }

  // Extract bundles from all profiles
  for (const profile of hubConfig.profiles) {
    for (const bundle of profile.bundles) {
      const key = `${bundle.source}:${bundle.id}`;

      if (bundlesMap.has(key)) {
        // Add profile to existing bundle
        const existing = bundlesMap.get(key)!;
        if (!existing.profiles.includes(profile.name)) {
          existing.profiles.push(profile.name);
        }
      } else {
        // Create new bundle entry
        const source = sourceLookup.get(bundle.source);
        bundlesMap.set(key, {
          bundleId: bundle.id,
          sourceId: bundle.source,
          sourceName: source?.name || bundle.source,
          sourceUrl: source?.url || '',
          profiles: [profile.name]
        });
      }
    }
  }

  return Array.from(bundlesMap.values());
}

// ============================================================================
// Discussion Generation
// ============================================================================

/**
 * Generate discussion title for a bundle
 * @param bundle
 */
function generateDiscussionTitle(bundle: BundleInfo): string {
  return `[Rating] ${bundle.bundleId}`;
}

/**
 * Generate discussion body for a bundle
 * @param bundle
 * @param hubName
 */
function generateDiscussionBody(bundle: BundleInfo, hubName: string): string {
  return `# Bundle Rating: ${bundle.bundleId}

## Bundle Information

| Field | Value |
|-------|-------|
| **Bundle ID** | \`${bundle.bundleId}\` |
| **Source** | ${bundle.sourceName} (\`${bundle.sourceId}\`) |
| **Source URL** | ${bundle.sourceUrl || 'N/A'} |
| **Used in Profiles** | ${bundle.profiles.join(', ')} |

## How to Rate

React to this discussion to rate this bundle:
- 👍 **Thumbs Up** - I find this bundle useful
- 👎 **Thumbs Down** - This bundle needs improvement

## Feedback

Feel free to leave comments with detailed feedback about this bundle:
- What works well?
- What could be improved?
- Any issues or bugs?

---
*This discussion was auto-generated for the **${hubName}** hub.*
*Bundle ratings are collected and aggregated to help users discover quality bundles.*
`;
}

/**
 * Setup discussions for all bundles
 * @param bundles
 * @param engagementOwner
 * @param engagementRepo
 * @param categoryName
 * @param hubName
 * @param token
 * @param dryRun
 */
async function setupDiscussionsForBundles(
    bundles: BundleInfo[],
    engagementOwner: string,
    engagementRepo: string,
    categoryName: string,
    hubName: string,
    token: string,
    dryRun: boolean
): Promise<DiscussionResult[]> {
  const results: DiscussionResult[] = [];

  // Get repository ID and category
  console.log(`\nFetching repository info for ${engagementOwner}/${engagementRepo}...`);

  let repositoryId: string;

  try {
    repositoryId = await getRepositoryId(engagementOwner, engagementRepo, token);
  } catch (error: unknown) {
    throw new Error(`Failed to get repository ID: ${(error as Error).message}. Make sure the repository exists and you have access.`);
  }

  const categories = await getDiscussionCategories(engagementOwner, engagementRepo, token);

  if (categories.length === 0) {
    throw new Error(
      `No discussion categories found in ${engagementOwner}/${engagementRepo}.\n`
      + `Please enable GitHub Discussions and create at least one category:\n`
      + `https://github.com/${engagementOwner}/${engagementRepo}/settings`
    );
  }

  let category = categories.find((c) =>
    c.name.toLowerCase() === categoryName.toLowerCase()
    || c.slug.toLowerCase() === categoryName.toLowerCase()
  );

  if (category) {
    console.log(`Using category: ${category.name} (${category.slug})`);
  } else {
    const availableCategories = categories.map((c) => `  - ${c.name} (${c.slug})`).join('\n');
    console.log(`\n⚠️  Category "${categoryName}" not found. Available categories:\n${availableCategories}\n`);

    // Use the first available category as fallback
    category = categories[0];
    console.log(`Using fallback category: ${category.name} (${category.slug})`);
    console.log(`\nTo create a "${categoryName}" category:`);
    console.log(`  1. Go to https://github.com/${engagementOwner}/${engagementRepo}/discussions/categories`);
    console.log(`  2. Click "New category"`);
    console.log(`  3. Name it "${categoryName}" and choose format (Announcement or Discussion)`);
    console.log(`  4. Re-run this tool with --category "${categoryName}"\n`);
  }

  const categoryId = category.id;

  // Process each bundle
  console.log(`\nProcessing ${bundles.length} bundles...`);

  for (const bundle of bundles) {
    const title = generateDiscussionTitle(bundle);
    const body = generateDiscussionBody(bundle, hubName);

    try {
      // Check if discussion already exists
      const existing = await findExistingDiscussion(
        engagementOwner, engagementRepo, title, token
      );

      if (existing) {
        console.log(`  ✓ ${bundle.sourceId}:${bundle.bundleId} - Discussion #${existing.number} already exists`);
        results.push({
          bundleId: bundle.bundleId,
          sourceId: bundle.sourceId,
          discussionNumber: existing.number,
          discussionUrl: existing.url,
          created: false
        });
      } else if (dryRun) {
        console.log(`  ○ ${bundle.sourceId}:${bundle.bundleId} - Would create discussion (dry-run)`);
        results.push({
          bundleId: bundle.bundleId,
          sourceId: bundle.sourceId,
          discussionNumber: 0,
          discussionUrl: '',
          created: false
        });
      } else {
        // Create new discussion
        const discussion = await createDiscussion(
          repositoryId, categoryId, title, body, token
        );
        console.log(`  + ${bundle.sourceId}:${bundle.bundleId} - Created discussion #${discussion.number}`);
        results.push({
          bundleId: bundle.bundleId,
          sourceId: bundle.sourceId,
          discussionNumber: discussion.number,
          discussionUrl: discussion.url,
          created: true
        });

        // Rate limit: wait a bit between creations
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error: unknown) {
      const errMsg = (error as Error).message;
      console.error(`  ✗ ${bundle.sourceId}:${bundle.bundleId} - Error: ${errMsg}`);
      results.push({
        bundleId: bundle.bundleId,
        sourceId: bundle.sourceId,
        discussionNumber: 0,
        discussionUrl: '',
        created: false,
        error: errMsg
      });
    }
  }

  return results;
}

/**
 * Generate collections.yaml from discussion results
 * @param results
 * @param engagementRepo
 * @param categoryId
 */
function generateCollectionsConfig(
    results: DiscussionResult[],
    engagementRepo: string,
    categoryId?: string
): CollectionsConfig {
  const collections: CollectionMapping[] = results
    .filter((r) => r.discussionNumber > 0)
    .map((r) => ({
      id: r.bundleId,
      source_id: r.sourceId,
      discussion_number: r.discussionNumber
    }));

  const config: CollectionsConfig = {
    repository: engagementRepo,
    collections
  };

  if (categoryId) {
    config.category_id = categoryId;
  }

  return config;
}

// ============================================================================
// CLI Interface
// ============================================================================

/**
 * Parse command line arguments
 * @param args
 */
export function parseArgs(args: string[]): {
  hubUrl: string;
  branch: string;
  output: string;
  category: string;
  dryRun: boolean;
  help: boolean;
} {
  let hubUrl = '';
  let branch = 'main';
  let output = 'collections.yaml';
  let category = 'Ratings';
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--hub':
      case '-h': {
        if (nextArg) {
          hubUrl = nextArg;
          i++;
        }
        break;
      }
      case '--branch':
      case '-b': {
        if (nextArg) {
          branch = nextArg;
          i++;
        }
        break;
      }
      case '--output':
      case '-o': {
        if (nextArg) {
          output = nextArg;
          i++;
        }
        break;
      }
      case '--category':
      case '-c': {
        if (nextArg) {
          category = nextArg;
          i++;
        }
        break;
      }
      case '--dry-run':
      case '-n': {
        dryRun = true;
        break;
      }
      case '--help': {
        help = true;
        break;
      }
      default: {
        // Positional argument - treat as hub URL if not set
        if (!hubUrl && !arg.startsWith('-')) {
          hubUrl = arg;
        }
      }
    }
  }

  return { hubUrl, branch, output, category, dryRun, help };
}

/**
 * Print usage information
 */
export function printUsage(): void {
  console.log(`
Usage: setup-discussions [options] <hub-url>

Creates GitHub Discussions for all bundles in a hub configuration.
The discussions are used to collect ratings and feedback via reactions.

Arguments:
  <hub-url>              GitHub repository URL for the hub config
                         Format: https://github.com/owner/repo or owner/repo

Options:
  --hub, -h <url>        Hub repository URL (alternative to positional arg)
  --branch, -b <branch>  Git branch to fetch hub config from (default: main)
  --output, -o <file>    Output collections.yaml path (default: collections.yaml)
  --category, -c <name>  Discussion category name (default: Ratings)
  --dry-run, -n          Preview what would be created without making changes
  --help                 Show this help message

Environment Variables:
  GITHUB_TOKEN           Required. GitHub token with repo and discussions permissions

Examples:
  # Create discussions for a hub
  setup-discussions https://github.com/AmadeusITGroup/prompt-registry-config

  # Dry run to preview
  setup-discussions --dry-run AmadeusITGroup/prompt-registry-config

  # Specify branch and output
  setup-discussions -b develop -o my-collections.yaml owner/repo

Output:
  Creates a collections.yaml file mapping bundles to discussion numbers.
  This file is used by compute-ratings to fetch reaction counts.
`);
}

/**
 * Parse GitHub repository URL
 * @param url
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } {
  // Handle full URLs
  const urlMatch = url.match(/github\.com[/:]([^/]+)\/([^/.\s]+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, '') };
  }

  // Handle owner/repo format
  const shortMatch = url.match(/^([^/]+)\/([^/]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  throw new Error(`Invalid GitHub URL format: ${url}`);
}

/**
 * Main entry point
 * @param hubUrl
 * @param branch
 * @param outputPath
 * @param categoryName
 * @param dryRun
 * @param token
 */
export async function setupDiscussions(
    hubUrl: string,
    branch: string,
    outputPath: string,
    categoryName: string,
    dryRun: boolean,
    token: string
): Promise<void> {
  // Parse hub URL
  const { owner: hubOwner, repo: hubRepo } = parseGitHubUrl(hubUrl);
  console.log(`Hub repository: ${hubOwner}/${hubRepo} (branch: ${branch})`);

  // Fetch hub configuration
  console.log('Fetching hub configuration...');
  const hubConfig = await fetchHubConfig(hubOwner, hubRepo, branch, token);
  console.log(`Hub: ${hubConfig.metadata.name}`);
  console.log(`Sources: ${hubConfig.sources.length}`);
  console.log(`Profiles: ${hubConfig.profiles.length}`);

  // Check engagement configuration
  if (!hubConfig.engagement?.backend?.repository) {
    throw new Error(
      'Hub config does not have engagement.backend.repository configured.\n'
      + 'Please add engagement configuration to hub-config.yml first.'
    );
  }

  const engagementRepo = hubConfig.engagement.backend.repository;
  const { owner: engagementOwner, repo: engagementRepoName } = parseGitHubUrl(engagementRepo);
  console.log(`Engagement repository: ${engagementOwner}/${engagementRepoName}`);

  // Extract bundles from hub
  const bundles = extractBundlesFromHub(hubConfig);
  console.log(`\nFound ${bundles.length} unique bundles across all profiles`);

  if (bundles.length === 0) {
    console.log('No bundles found in hub configuration.');
    return;
  }

  // Setup discussions
  const results = await setupDiscussionsForBundles(
    bundles,
    engagementOwner,
    engagementRepoName,
    categoryName,
    hubConfig.metadata.name,
    token,
    dryRun
  );

  // Generate collections.yaml
  const collectionsConfig = generateCollectionsConfig(
    results,
    `${engagementOwner}/${engagementRepoName}`
  );

  // Write output
  if (dryRun) {
    console.log('\n--- Dry Run: collections.yaml would contain ---');
    console.log(yaml.dump(collectionsConfig, { indent: 2 }));
  } else {
    const yamlContent = yaml.dump(collectionsConfig, {
      indent: 2,
      lineWidth: -1,
      noRefs: true
    });
    fs.writeFileSync(outputPath, yamlContent);
    console.log(`\nCollections config written to: ${outputPath}`);
  }

  // Summary
  const created = results.filter((r) => r.created).length;
  const existing = results.filter((r) => !r.created && r.discussionNumber > 0).length;
  const errors = results.filter((r) => r.error).length;

  console.log('\n=== Summary ===');
  console.log(`Total bundles: ${bundles.length}`);
  console.log(`Discussions created: ${created}`);
  console.log(`Already existing: ${existing}`);
  if (errors > 0) {
    console.log(`Errors: ${errors}`);
  }

  if (dryRun) {
    console.log('\n(Dry run - no changes were made)');
  }
}
