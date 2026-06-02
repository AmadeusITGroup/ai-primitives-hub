import {
  isValidRatingScore,
  RatingScore,
} from '../types/engagement';

const STAR = '⭐';
const RATING_LINE_PATTERN = /^Rating:\s*(⭐+)/m;

/**
 * Parse rating score from GitHub comment body
 * @param body - Comment body containing "Rating: ⭐⭐⭐" format
 */
export function parseRatingFromComment(body: string): RatingScore | undefined {
  const match = body.match(RATING_LINE_PATTERN);
  if (!match) {
    return undefined;
  }
  const count = [...match[1]].filter((c) => c === STAR).length;
  if (!isValidRatingScore(count)) {
    return undefined;
  }
  return count;
}
