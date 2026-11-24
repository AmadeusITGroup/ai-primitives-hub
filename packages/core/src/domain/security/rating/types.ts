/**
 * Types of a finding as the security rating reads it. Deliberately small: any scanner that writes
 * these fields as JSON can feed the rating.
 * @module domain/security/rating/types
 */

export const SECURITY_RATING_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type SecurityRatingSeverity = typeof SECURITY_RATING_SEVERITIES[number];

export const SECURITY_RATING_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type SecurityRatingConfidence = typeof SECURITY_RATING_CONFIDENCES[number];

/** One scanner finding. */
export interface SecurityRatingFinding {
  ruleId: string;
  title: string;
  severity: SecurityRatingSeverity;
  confidence: SecurityRatingConfidence;
  /** Path of the file, relative to the rated checkout when possible. */
  file: string;
  line?: number;
  /** How to fix it; a suggestion for the rule family is used when the scanner gives none. */
  recommendedFix?: string;
}
