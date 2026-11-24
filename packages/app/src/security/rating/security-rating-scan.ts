/**
 * Scan a source checkout with the security scanner, then rate its bundles from the findings.
 * @module app/security/rating/security-rating-scan
 */
import type {
  SecurityResourceLimits,
} from '@ai-primitives-hub/core';
import {
  runSecurityScan,
  type SecurityScanDependencies,
  type SecurityScanOptions,
  type SecurityScanResult,
} from '../security-scan-use-case';
import {
  runSecurityRating,
  type SecurityRatingRequest,
  type SecurityRatingResult,
} from './security-rating';

const DEFAULT_SCANNER_NAME = 'ai-primitives-hub-security';

export interface SecurityRatingScanResult extends SecurityRatingResult {
  /** The underlying scan, for coverage and operational errors. */
  scan: SecurityScanResult;
}

/**
 * Scan a checkout and rate its bundles.
 * @param options - Scan dependencies plus the rating request
 */
export const scanAndRate = async (
  options: SecurityScanDependencies & {
    request: Omit<SecurityRatingRequest, 'scannerName'> & { scannerName?: string };
    scanOptions?: SecurityScanOptions;
    limits?: SecurityResourceLimits;
  }
): Promise<SecurityRatingScanResult> => {
  const { request } = options;
  const scan = await runSecurityScan({
    input: options.input,
    engine: options.engine,
    clock: options.clock,
    cancellation: options.cancellation,
    limits: options.limits,
    scanOptions: options.scanOptions,
    failOn: 'none',
    request: {
      roots: [request.root],
      extensions: ['.md', '.markdown'],
      recursive: true,
      excludes: ['.git', 'node_modules'],
      // Documentation costs fewer points in the rating but is still rated.
      includeDocFiles: true,
      // Repository suppressions are ignored so a rating cannot be tuned by the rated repository.
      ignoreTrust: 'none'
    }
  });
  const rated = runSecurityRating({
    findings: scan.findings,
    generatedAt: options.clock.nowIso(),
    request: { ...request, scannerName: request.scannerName ?? DEFAULT_SCANNER_NAME }
  });
  return { ...rated, scan };
};
