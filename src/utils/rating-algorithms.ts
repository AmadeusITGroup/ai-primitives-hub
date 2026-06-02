/**
 * Rating algorithms for engagement scoring
 * Implements Wilson score and Bayesian smoothing for robust ranking
 */

/**
 * Wilson score lower bound for binary ratings (up/down votes)
 *
 * This algorithm provides a robust ranking that handles small sample sizes well.
 * It calculates the lower bound of a confidence interval for the true proportion
 * of positive ratings, which naturally penalizes items with few votes.
 * @param up - Number of upvotes
 * @param down - Number of downvotes
 * @param z - Z-score for confidence level (default 1.96 for 95% confidence)
 * @returns Wilson score lower bound (0-1)
 * @example
 * // Item with 100 upvotes, 10 downvotes
 * wilsonLowerBound(100, 10) // ~0.85
 *
 * // Item with 5 upvotes, 0 downvotes (penalized for low sample)
 * wilsonLowerBound(5, 0) // ~0.57
 */
export function wilsonLowerBound(up: number, down: number, z = 1.96): number {
  const n = up + down;
  if (n === 0) {
    return 0;
  }

  const phat = up / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const num = phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);

  return num / denom;
}

/**
 * Bayesian smoothing for ratings with only positive votes (thumbs-up only)
 *
 * Uses a prior to smooth ratings, preventing items with few votes from
 * dominating rankings. The prior pulls scores toward the global average.
 * @param upvotes - Number of upvotes for this item
 * @param totalVotes - Total number of votes for this item
 * @param priorMean - Prior mean (global average, default 0.6)
 * @param priorStrength - Weight of the prior (default 10)
 * @returns Smoothed score (0-1)
 * @example
 * // Item with 50 upvotes out of 60 votes
 * bayesianSmoothing(50, 60) // ~0.79
 *
 * // Item with 3 upvotes out of 3 votes (pulled toward prior)
 * bayesianSmoothing(3, 3) // ~0.69
 */
export function bayesianSmoothing(
    upvotes: number,
    totalVotes: number,
    priorMean = 0.6,
    priorStrength = 10
): number {
  return (upvotes + priorStrength * priorMean) / (totalVotes + priorStrength);
}

/**
 * Convert a 0-1 score to a star rating (1-5)
 * @param score - Score between 0 and 1
 * @param minStars - Minimum star rating (default 1)
 * @param maxStars - Maximum star rating (default 5)
 * @returns Star rating
 */
export function scoreToStars(score: number, minStars = 1, maxStars = 5): number {
  const range = maxStars - minStars;
  return Math.round((score * range + minStars) * 10) / 10;
}

/**
 * Convert a star rating (1-5) to a 0-1 score
 * @param stars - Star rating (1-5)
 * @param minStars - Minimum star rating (default 1)
 * @param maxStars - Maximum star rating (default 5)
 * @returns Score between 0 and 1
 */
export function starsToScore(stars: number, minStars = 1, maxStars = 5): number {
  const range = maxStars - minStars;
  return (stars - minStars) / range;
}

/**
 * Aggregate multiple resource scores into a collection score
 * Uses weighted average with log-scaled vote counts to prevent
 * one heavily-voted resource from dominating.
 * @param resources - Array of { score, voteCount } objects
 * @returns Aggregated score (0-1)
 */
export function aggregateResourceScores(
    resources: { score: number; voteCount: number }[]
): number {
  if (resources.length === 0) {
    return 0;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (const resource of resources) {
    // Use log(1 + votes) to dampen the effect of high vote counts
    const weight = Math.log(1 + resource.voteCount);
    weightedSum += resource.score * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Calculate confidence level based on vote count
 * Returns a string indicating how reliable the rating is
 * @param voteCount - Number of votes
 * @returns Confidence level string
 */
export function getConfidenceLevel(voteCount: number): 'low' | 'medium' | 'high' | 'very_high' {
  if (voteCount < 5) {
    return 'low';
  } else if (voteCount < 20) {
    return 'medium';
  } else if (voteCount < 100) {
    return 'high';
  } else {
    return 'very_high';
  }
}

/**
 * Rating calculation result with all computed metrics
 */
export interface RatingMetrics {
  /** Wilson score lower bound (0-1) */
  wilsonScore: number;
  /** Bayesian smoothed score (0-1) */
  bayesianScore: number;
  /** Star rating (1-5) */
  starRating: number;
  /** Number of upvotes */
  upvotes: number;
  /** Number of downvotes */
  downvotes: number;
  /** Total vote count */
  totalVotes: number;
  /** Confidence level */
  confidence: 'low' | 'medium' | 'high' | 'very_high';
}

/**
 * Calculate all rating metrics for a resource
 * @param upvotes - Number of upvotes
 * @param downvotes - Number of downvotes
 * @param priorMean - Prior mean for Bayesian smoothing
 * @returns Complete rating metrics
 */
export function calculateRatingMetrics(
    upvotes: number,
    downvotes: number,
    priorMean = 0.6
): RatingMetrics {
  const totalVotes = upvotes + downvotes;
  const wilsonScore = wilsonLowerBound(upvotes, downvotes);
  const bayesianScore = bayesianSmoothing(upvotes, totalVotes, priorMean);

  return {
    wilsonScore,
    bayesianScore,
    starRating: scoreToStars(wilsonScore),
    upvotes,
    downvotes,
    totalVotes,
    confidence: getConfidenceLevel(totalVotes)
  };
}
