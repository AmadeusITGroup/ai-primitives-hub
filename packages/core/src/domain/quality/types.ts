/**
 * Types of a finding as the quality rating reads it. Deliberately small: any scanner that writes
 * these fields as JSON can feed the rating.
 * @module domain/quality/types
 */

export const QUALITY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type QualitySeverity = typeof QUALITY_SEVERITIES[number];

export const QUALITY_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type QualityConfidence = typeof QUALITY_CONFIDENCES[number];

/** One scanner finding. */
export interface QualityFinding {
  ruleId: string;
  title: string;
  severity: QualitySeverity;
  confidence: QualityConfidence;
  /** Path of the file, relative to the rated checkout when possible. */
  file: string;
  line?: number;
  /** How to fix it; a suggestion for the rule family is used when the scanner gives none. */
  recommendedFix?: string;
}
