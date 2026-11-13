/**
 * Read the findings of a scan report.
 *
 * Accepts the JSON that scanners write: an object with a `findings` array, or a bare array.
 * Entries that lack a rule id, a file or a known severity are skipped and counted rather than
 * guessed.
 * @module domain/quality/findings-document
 */
import {
  QUALITY_CONFIDENCES,
  QUALITY_SEVERITIES,
  type QualityConfidence,
  type QualityFinding,
  type QualitySeverity,
} from './types';

export interface ParsedFindings {
  findings: QualityFinding[];
  /** Entries that were not valid findings. */
  skipped: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => {
  const upper = typeof value === 'string' ? value.toUpperCase() : '';
  return values.find((candidate) => candidate === upper);
};

/**
 * Turn a parsed JSON document into findings.
 * @param document - Parsed JSON of a scan report
 */
export const parseFindingsDocument = (document: unknown): ParsedFindings => {
  const entries = Array.isArray(document) ? document : (isRecord(document) && Array.isArray(document.findings) ? document.findings : undefined);
  if (entries === undefined) {
    throw new TypeError('expected an object with a "findings" array, or an array of findings');
  }
  const findings: QualityFinding[] = [];
  let skipped = 0;
  for (const entry of entries as unknown[]) {
    const severity: QualitySeverity | undefined = isRecord(entry) ? oneOf(QUALITY_SEVERITIES, entry.severity) : undefined;
    // The security scan report writes snake_case names; other scanners use camelCase.
    const ruleId = isRecord(entry) ? entry.ruleId ?? entry.rule_id : undefined;
    const recommendedFix = isRecord(entry) ? entry.recommendedFix ?? entry.recommended_fix : undefined;
    if (!isRecord(entry) || typeof ruleId !== 'string' || ruleId === '' || typeof entry.file !== 'string' || entry.file === '' || severity === undefined) {
      skipped += 1;
      continue;
    }
    // A finding without a confidence counts in full: assuming it is doubtful would hide it.
    const confidence: QualityConfidence = oneOf(QUALITY_CONFIDENCES, entry.confidence) ?? 'HIGH';
    findings.push({
      ruleId,
      title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : ruleId,
      severity,
      confidence,
      file: entry.file,
      ...(typeof entry.line === 'number' && Number.isInteger(entry.line) ? { line: entry.line } : {}),
      ...(typeof recommendedFix === 'string' && recommendedFix !== '' ? { recommendedFix } : {})
    });
  }
  return { findings, skipped };
};
