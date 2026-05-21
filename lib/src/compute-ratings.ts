/* eslint-disable no-console -- CLI script uses console for output */
/**
 * Rating Computation for GitHub Actions
 *
 * Fetches reaction counts from GitHub Discussions and computes ratings
 * using Wilson score algorithm. Outputs ratings.json for static hosting.
 */

import * as fs from 'node:fs';
import axios from 'axios';
import * as yaml from 'js-yaml';

// ============================================================================
// Types
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- snake_case fields mirror collections.yaml and GitHub API response structures */
/**
 * Resource mapping in collections.yaml
 */
export interface ResourceMapping {
  id: string;
  comment_id?: number;
}

/**
 * Collection mapping in collections.yaml
 */
export interface CollectionMapping {
  id: string;
  source_id?: string;
  discussion_number: number;
  resources?: ResourceMapping[];
}

/**
 * Collections configuration file structure
 */
export interface CollectionsConfig {
  repository: string;
  collections: CollectionMapping[];
}

/**
 * Reaction counts from GitHub API
 */
interface ReactionCounts {
  '+1': number;
  '-1': number;
  laugh?: number;
  hooray?: number;
  confused?: number;
  heart?: number;
  rocket?: number;
  eyes?: number;
}

/**
 * Resource rating in output
 */
export interface ResourceRating {
  up: number;
  down: number;
  wilson_score: number;
  bayesian_score: number;
  star_rating: number;
  confidence: string;
}

/**
 * Collection rating in output
 */
export interface CollectionRating {
  source_id?: string;
  discussion_number: number;
  up: number;
  down: number;
  wilson_score: number;
  bayesian_score: number;
  aggregated_score: number;
  star_rating: number;
  rating_count: number;
  confidence: string;
  resources: Record<string, ResourceRating>;
}

/**
 * Output ratings.json structure
 */
export interface RatingsOutput {
  generated_at: string;
  repository: string;
  collections: Record<string, CollectionRating>;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Rating metrics calculation result
 */
interface RatingMetrics {
  wilsonScore: number;
  bayesianScore: number;
  starRating: number;
  confidence: string;
}

// ============================================================================
// Rating Algorithms (inline to avoid circular dependencies)
// ============================================================================

/**
 * Calculate Wilson score lower bound (95% confidence)
 * @param upvotes
 * @param downvotes
 */
function wilsonLowerBound(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes;
  if (n === 0) {
    return 0;
  }

  const z = 1.96; // 95% confidence
  const phat = upvotes / n;

  return (phat + z * z / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n)) / (1 + z * z / n);
}

/**
 * Calculate Bayesian smoothed rating
 * @param upvotes
 * @param downvotes
 * @param priorMean
 * @param priorWeight
 */
function bayesianSmoothing(upvotes: number, downvotes: number, priorMean = 3.5, priorWeight = 10): number {
  const totalVotes = upvotes + downvotes;
  const observedMean = totalVotes > 0 ? (upvotes / totalVotes) * 5 : priorMean;

  return (observedMean * totalVotes + priorMean * priorWeight) / (totalVotes + priorWeight);
}

/**
 * Get confidence level based on vote count
 * @param voteCount
 */
function getConfidenceLevel(voteCount: number): string {
  if (voteCount >= 100) {
    return 'very_high';
  } else if (voteCount >= 20) {
    return 'high';
  } else if (voteCount >= 5) {
    return 'medium';
  } else {
    return 'low';
  }
}

/**
 * Parse star rating from a feedback comment body
 * Supports both old and new formats:
 * - New: "Rating: ⭐⭐⭐⭐⭐"
 * - Old: "**Feedback** (N ⭐⭐⭐⭐⭐)"
 * @param commentBody The comment body text
 * @returns The star rating (1-5) or null if not found
 */
export function parseStarRatingFromComment(commentBody: string): number | null {
  // New format: Rating: ⭐⭐⭐⭐⭐
  const newFormatMatch = commentBody.match(/Rating:\s*(⭐+)/);
  if (newFormatMatch) {
    const starCount = newFormatMatch[1].length;
    if (starCount >= 1 && starCount <= 5) {
      return starCount;
    }
  }

  // Old format: **Feedback** (N ⭐⭐⭐⭐⭐)
  const oldFormatMatch = commentBody.match(/\*\*Feedback\*\*\s*\((\d)\s*⭐/);
  if (oldFormatMatch) {
    const rating = Number.parseInt(oldFormatMatch[1], 10);
    if (rating >= 1 && rating <= 5) {
      return rating;
    }
  }

  // Fallback: N ⭐... at start of line
  const fallbackMatch = commentBody.match(/^(\d)\s*⭐/m);
  if (fallbackMatch) {
    const rating = Number.parseInt(fallbackMatch[1], 10);
    if (rating >= 1 && rating <= 5) {
      return rating;
    }
  }

  return null;
}

/**
 * Result of computing average star rating
 */
export interface AverageStarRatingResult {
  average: number;
  count: number;
  confidence: string;
}

/**
 * Deduplicate ratings by user, keeping only the most recent rating from each user
 * This follows industry standard practice (Amazon, App Store, etc.)
 * @param comments Array of discussion comments with author and timestamp
 * @returns Array of star ratings with duplicates removed (one per user)
 */
export function deduplicateRatingsByUser(comments: DiscussionComment[]): number[] {
  // Map to store the most recent rating for each user
  const userRatings = new Map<string, { rating: number; createdAt: string }>();

  for (const comment of comments) {
    const rating = parseStarRatingFromComment(comment.body);
    if (rating === null) {
      continue; // Skip non-rating comments
    }

    const author = comment.author?.login;
    if (!author) {
      // Anonymous or deleted user - still count the rating
      // Use a unique key based on timestamp to avoid collision
      const anonymousKey = `anonymous_${comment.createdAt}`;
      userRatings.set(anonymousKey, { rating, createdAt: comment.createdAt });
      continue;
    }

    // Check if we already have a rating from this user
    const existing = userRatings.get(author);
    if (!existing || comment.createdAt > existing.createdAt) {
      // This is either the first rating from this user, or a more recent one
      userRatings.set(author, { rating, createdAt: comment.createdAt });
    }
  }

  // Extract just the ratings
  return Array.from(userRatings.values()).map((entry) => entry.rating);
}

/**
 * Compute average star rating from an array of individual ratings
 * @param ratings Array of star ratings (1-5)
 * @returns Average rating, count, and confidence level
 */
export function computeAverageStarRating(ratings: number[]): AverageStarRatingResult {
  if (ratings.length === 0) {
    return {
      average: 0,
      count: 0,
      confidence: 'low'
    };
  }

  const sum = ratings.reduce((acc, r) => acc + r, 0);
  const average = Math.round((sum / ratings.length) * 10) / 10; // Round to 1 decimal
  const confidence = getConfidenceLevel(ratings.length);

  return {
    average,
    count: ratings.length,
    confidence
  };
}

/**
 * Calculate all rating metrics
 * @param upvotes
 * @param downvotes
 */
function calculateRatingMetrics(upvotes: number, downvotes: number): RatingMetrics {
  const wilsonScore = wilsonLowerBound(upvotes, downvotes);
  const bayesianScore = bayesianSmoothing(upvotes, downvotes);
  const starRating = Math.round(bayesianScore * 10) / 10;
  const confidence = getConfidenceLevel(upvotes + downvotes);

  return {
    wilsonScore,
    bayesianScore,
    starRating,
    confidence
  };
}

/**
 * Aggregate resource scores into collection score
 * @param resources
 */
function aggregateResourceScores(resources: { score: number; voteCount: number }[]): number {
  if (resources.length === 0) {
    return 0;
  }

  const totalVotes = resources.reduce((sum, r) => sum + r.voteCount, 0);
  if (totalVotes === 0) {
    return 0;
  }

  return resources.reduce((sum, r) => sum + r.score * r.voteCount, 0) / totalVotes;
}

// ============================================================================
// GitHub API Functions
// ============================================================================

/**
 * Rate limit tracking
 */
const rateLimitState = { remaining: 5000, resetAt: 0 };

/**
 * Check and log rate limit status
 * @param headers
 */
function updateRateLimit(headers: Record<string, string>): void {
  if (headers['x-ratelimit-remaining']) {
    rateLimitState.remaining = Number.parseInt(headers['x-ratelimit-remaining'], 10);
  }
  if (headers['x-ratelimit-reset']) {
    rateLimitState.resetAt = Number.parseInt(headers['x-ratelimit-reset'], 10);
  }
}

/**
 * Get current rate limit status
 */
function getRateLimitStatus(): { remaining: number; resetAt: number } {
  return { remaining: rateLimitState.remaining, resetAt: rateLimitState.resetAt };
}

/**
 * Fetch all reactions with pagination support
 * GitHub API returns max 100 items per page
 * @param url
 * @param token
 */
async function fetchAllReactions(
    url: string,
    token: string
): Promise<{ content: string }[]> {
  const allReactions: { content: string }[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await axios.get<{ content: string }[]>(
      `${url}?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    // Update rate limit tracking
    updateRateLimit(response.headers as Record<string, string>);

    const reactions = response.data;
    allReactions.push(...reactions);

    // If we got fewer than perPage results, we've reached the end
    if (reactions.length < perPage) {
      break;
    }

    page++;

    // Safety limit to prevent infinite loops
    if (page > 100) {
      console.warn(`Pagination limit reached for ${url}`);
      break;
    }
  }

  return allReactions;
}

interface GraphQLDiscussionReactionsResponse {
  data: {
    repository: {
      discussion: {
        reactions: {
          nodes: { content: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };
  };
}

/**
 * Fetch discussion reactions using GraphQL (more reliable than REST)
 * @param owner
 * @param repo
 * @param discussionNumber
 * @param token
 */
async function fetchDiscussionReactions(
    owner: string,
    repo: string,
    discussionNumber: number,
    token: string
): Promise<ReactionCounts> {
  const query = `
        query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
                discussion(number: $number) {
                    reactions(first: 100) {
                        nodes {
                            content
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }
            }
        }
    `;

  try {
    const response = await axios.post(
      'https://api.github.com/graphql',
      {
        query,
        variables: { owner, repo, number: discussionNumber }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    updateRateLimit(response.headers as Record<string, string>);

    const responseData = response.data as GraphQLDiscussionReactionsResponse;
    const discussion = responseData.data?.repository?.discussion;
    if (!discussion) {
      console.warn(`Discussion #${discussionNumber} not found, using zero counts`);
      return { '+1': 0, '-1': 0 };
    }

    // Count reactions by type
    const counts: ReactionCounts = { '+1': 0, '-1': 0 };
    const reactions = discussion.reactions?.nodes || [];

    for (const reaction of reactions) {
      const content = reaction.content;
      if (content === 'THUMBS_UP') {
        counts['+1']++;
      } else if (content === 'THUMBS_DOWN') {
        counts['-1']++;
      }
    }

    return counts;
  } catch (error: unknown) {
    console.warn(`Error fetching discussion #${discussionNumber}: ${(error as Error).message}`);
    return { '+1': 0, '-1': 0 };
  }
}

/**
 * Fetch reactions for a comment (resource-level voting, with pagination)
 * @param owner
 * @param repo
 * @param commentId
 * @param token
 */
async function fetchCommentReactions(
    owner: string,
    repo: string,
    commentId: number,
    token: string
): Promise<ReactionCounts> {
  const url = `https://api.github.com/repos/${owner}/${repo}/discussions/comments/${commentId}/reactions`;

  try {
    const reactions = await fetchAllReactions(url, token);

    const counts: ReactionCounts = { '+1': 0, '-1': 0 };
    for (const reaction of reactions) {
      const content = reaction.content as keyof ReactionCounts;
      counts[content] = (counts[content] || 0) + 1;
    }

    return counts;
  } catch (error: unknown) {
    const err = error as { response?: { status: number }; message?: string };
    if (err.response?.status === 404) {
      console.warn(`Comment #${commentId} not found, using zero counts`);
      return { '+1': 0, '-1': 0 };
    }
    throw new Error(`GitHub API error: ${err.response?.status ?? 'unknown'} ${err.message ?? String(error)}`);
  }
}

/**
 * Discussion comment structure from GraphQL
 */
interface DiscussionComment {
  body: string;
  author?: {
    login: string;
  };
  createdAt: string;
}

/**
 * Fetch all comments from a discussion using GraphQL with pagination
 * These comments contain the star ratings in the format "**Feedback** (N ⭐...)"
 * @param owner
 * @param repo
 * @param discussionNumber
 * @param token
 */
async function fetchDiscussionComments(
    owner: string,
    repo: string,
    discussionNumber: number,
    token: string
): Promise<DiscussionComment[]> {
  const allComments: DiscussionComment[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `
            query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
                repository(owner: $owner, name: $repo) {
                    discussion(number: $number) {
                        comments(first: 100, after: $cursor) {
                            nodes {
                                body
                                author {
                                    login
                                }
                                createdAt
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                    }
                }
            }
        `;

    try {
      interface CommentsResponse {
        data?: {
          repository?: {
            discussion?: {
              comments?: {
                nodes: DiscussionComment[];
                pageInfo: {
                  hasNextPage: boolean;
                  endCursor: string | null;
                };
              };
            };
          };
        };
      }

      const response: { data: CommentsResponse; headers: Record<string, string> } = await axios.post(
        'https://api.github.com/graphql',
        {
          query,
          variables: { owner, repo, number: discussionNumber, cursor }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      updateRateLimit(response.headers);

      const discussionData = response.data?.data?.repository?.discussion;
      if (!discussionData) {
        console.warn(`Discussion #${discussionNumber} not found`);
        break;
      }

      const comments = discussionData.comments?.nodes || [];
      allComments.push(...comments);

      hasNextPage = discussionData.comments?.pageInfo?.hasNextPage || false;
      cursor = discussionData.comments?.pageInfo?.endCursor || null;

      // Safety limit
      if (allComments.length > 1000) {
        console.warn(`Comment limit reached for discussion #${discussionNumber}`);
        break;
      }
    } catch (error: unknown) {
      console.warn(`Error fetching comments for discussion #${discussionNumber}: ${(error as Error).message}`);
      break;
    }
  }

  return allComments;
}

// ============================================================================
// Rating Computation
// ============================================================================

/**
 * Compute ratings for a single resource
 * @param up
 * @param down
 */
export function computeResourceRating(up: number, down: number): ResourceRating {
  const metrics = calculateRatingMetrics(up, down);
  return {
    up,
    down,
    wilson_score: Math.round(metrics.wilsonScore * 1000) / 1000,
    bayesian_score: Math.round(metrics.bayesianScore * 1000) / 1000,
    star_rating: metrics.starRating,
    confidence: metrics.confidence
  };
}

/**
 * Compute ratings for a collection including all resources
 *
 * Rating sources (in priority order):
 * 1. Star ratings from feedback comments (new system: "**Feedback** (N ⭐...)")
 * 2. Thumbs up/down reactions on the discussion (legacy fallback)
 * @param collection
 * @param owner
 * @param repo
 * @param token
 */
async function computeCollectionRating(
    collection: CollectionMapping,
    owner: string,
    repo: string,
    token: string
): Promise<CollectionRating> {
  console.log(`  Processing collection: ${collection.id}`);

  // Fetch discussion comments to extract star ratings
  const comments = await fetchDiscussionComments(
    owner, repo, collection.discussion_number, token
  );

  // Deduplicate ratings by user (keep only most recent rating per user)
  // This follows industry standard practice (Amazon, App Store, etc.)
  const starRatings = deduplicateRatingsByUser(comments);

  // Also fetch discussion-level reactions as fallback/supplement
  const discussionReactions = await fetchDiscussionReactions(
    owner, repo, collection.discussion_number, token
  );

  const collectionUp = discussionReactions['+1'];
  const collectionDown = discussionReactions['-1'];

  // Compute rating based on star ratings only (5-star system)
  let starRating: number;
  let ratingCount: number;
  let confidence: string;
  let wilsonScore: number;
  let bayesianScore: number;

  if (starRatings.length > 0) {
    // Use star ratings from comments (5-star system)
    const avgResult = computeAverageStarRating(starRatings);
    starRating = avgResult.average;
    ratingCount = avgResult.count;
    confidence = avgResult.confidence;
    // Convert star rating to normalized score (0-1 scale)
    wilsonScore = (starRating - 1) / 4; // Maps 1-5 to 0-1
    bayesianScore = starRating;
    console.log(`    Found ${starRatings.length} star ratings, average: ${starRating}`);
  } else {
    // No ratings yet - use neutral defaults
    starRating = 0;
    ratingCount = 0;
    confidence = 'low';
    wilsonScore = 0;
    bayesianScore = 0;
    console.log(`    No star ratings found`);
  }

  // Process resources (still using reactions for now)
  const resources: Record<string, ResourceRating> = {};
  const resourceScores: { score: number; voteCount: number }[] = [];

  if (collection.resources && collection.resources.length > 0) {
    for (const resource of collection.resources) {
      if (resource.comment_id) {
        const reactions = await fetchCommentReactions(
          owner, repo, resource.comment_id, token
        );
        const rating = computeResourceRating(reactions['+1'], reactions['-1']);
        resources[resource.id] = rating;
        resourceScores.push({
          score: rating.wilson_score,
          voteCount: rating.up + rating.down
        });
      }
    }
  }

  // Compute aggregated score from resources (if any)
  let aggregatedScore = wilsonScore;
  if (resourceScores.length > 0) {
    const resourceAggregated = aggregateResourceScores(resourceScores);
    // Blend collection-level and resource-level scores (70/30 split)
    aggregatedScore = 0.7 * wilsonScore + 0.3 * resourceAggregated;
  }

  return {
    source_id: collection.source_id,
    discussion_number: collection.discussion_number,
    up: collectionUp,
    down: collectionDown,
    wilson_score: Math.round(wilsonScore * 1000) / 1000,
    bayesian_score: Math.round(bayesianScore * 1000) / 1000,
    aggregated_score: Math.round(aggregatedScore * 1000) / 1000,
    star_rating: starRating,
    rating_count: ratingCount,
    confidence,
    resources
  };
}

// ============================================================================
// Main Script
// ============================================================================

/**
 * Parse command line arguments
 * @param args
 */
export function parseArgs(args: string[]): { configPath: string; outputPath: string } {
  let configPath = 'collections.yaml';
  let outputPath = 'ratings.json';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Handle --config=value format
    if (arg.startsWith('--config=')) {
      configPath = arg.substring('--config='.length);
    } else if (arg === '--config' && args[i + 1]) {
      // Handle --config value format
      configPath = args[i + 1];
      i++;
    } else if (arg.startsWith('--output=')) {
      // Handle --output=value format
      outputPath = arg.substring('--output='.length);
    } else if (arg === '--output' && args[i + 1]) {
      // Handle --output value format
      outputPath = args[i + 1];
      i++;
    }
  }

  return { configPath, outputPath };
}

/**
 * Main entry point
 * @param configPath
 * @param outputPath
 * @param token
 */
export async function computeRatings(configPath: string, outputPath: string, token: string): Promise<void> {
  // Load collections config
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configContent = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(configContent) as CollectionsConfig;

  if (!config.repository || !config.collections) {
    throw new Error('Invalid config file. Must have "repository" and "collections" fields.');
  }

  const [owner, repo] = config.repository.split('/');
  if (!owner || !repo) {
    throw new Error('Invalid repository format. Expected "owner/repo".');
  }

  console.log(`Computing ratings for ${config.repository}`);
  console.log(`Processing ${config.collections.length} collections...`);

  // Determine concurrency based on rate limit
  const rateLimit = getRateLimitStatus();
  let concurrency = 10; // Default

  if (rateLimit.remaining < 1000) {
    concurrency = 3;
    console.log(`Low rate limit (${rateLimit.remaining} remaining), using concurrency: ${concurrency}`);
  } else if (rateLimit.remaining < 2000) {
    concurrency = 5;
    console.log(`Medium rate limit (${rateLimit.remaining} remaining), using concurrency: ${concurrency}`);
  } else {
    console.log(`Good rate limit (${rateLimit.remaining} remaining), using concurrency: ${concurrency}`);
  }

  // Process collections concurrently in batches
  const collections: Record<string, CollectionRating> = {};
  const batches: CollectionMapping[][] = [];

  for (let i = 0; i < config.collections.length; i += concurrency) {
    batches.push(config.collections.slice(i, i + concurrency));
  }

  for (const batch of batches) {
    const promises = batch.map(async (collection) => {
      try {
        return {
          id: collection.id,
          rating: await computeCollectionRating(collection, owner, repo, token)
        };
      } catch (error) {
        console.error(`  Error processing ${collection.id}:`, error);
        return null;
      }
    });

    const results = await Promise.all(promises);

    for (const result of results) {
      if (result) {
        collections[result.id] = result.rating;
      }
    }

    // Log rate limit status after each batch
    const currentLimit = getRateLimitStatus();
    if (currentLimit.remaining < 100) {
      console.warn(`⚠️  Rate limit low: ${currentLimit.remaining} requests remaining`);
    }
  }

  // Generate output
  const output: RatingsOutput = {
    generated_at: new Date().toISOString(),
    repository: config.repository,
    collections
  };

  // Write output
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nRatings written to: ${outputPath}`);

  // Summary
  const totalCollections = Object.keys(collections).length;
  const totalResources = Object.values(collections).reduce(
    (sum, c) => sum + Object.keys(c.resources).length, 0
  );
  console.log(`Summary: ${totalCollections} collections, ${totalResources} resources`);
}
