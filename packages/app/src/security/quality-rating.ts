/**
 * Quality rating: scan a source checkout, then rate each of its bundles (collections or skills)
 * and the source as the average of its bundles.
 * @module app/security/quality-rating
 */
import * as path from 'node:path';
import type {
  QualityFailOn,
  QualityReport,
  SecurityFinding,
  SecurityResourceLimits,
} from '@ai-primitives-hub/core';
import {
  buildQualityReport,
} from '@ai-primitives-hub/core';
import {
  discoverBundles,
} from './bundle-discovery';
import type {
  SecurityScanDependencies,
  SecurityScanOptions,
  SecurityScanResult,
} from './security-scan-use-case';
import {
  runSecurityScan,
} from './security-scan-use-case';

export interface QualityRatingRequest {
  /** Checkout to rate. */
  root: string;
  /** `owner/repo`, recorded in the report and used for skill bundle ids. */
  repository: string;
  tag?: string;
  commit?: string;
  failOn: QualityFailOn;
  collectionsPath?: string;
  skillsPath?: string;
  /** Repository suppressions are ignored by default so a rating cannot be tuned by the rated repo. */
  ignoreTrust?: 'repository' | 'none' | 'baseline';
}

export interface QualityRatingResult {
  report: QualityReport;
  /** The underlying scan, for coverage and operational errors. */
  scan: SecurityScanResult;
  /** Collection items that were missing or outside the repository. */
  warnings: readonly string[];
}

const SCANNER_NAME = 'ai-primitives-hub-security';

const relativeToRoot = (root: string, file: string): string => {
  if (!path.isAbsolute(file)) {
    return file;
  }
  const relative = path.relative(path.resolve(root), file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
};

/**
 * Scan a checkout and rate its bundles.
 * @param options - Scan dependencies plus the rating request
 */
export const runQualityRating = async (
  options: SecurityScanDependencies & {
    request: QualityRatingRequest;
    scanOptions?: SecurityScanOptions;
    limits?: SecurityResourceLimits;
  }
): Promise<QualityRatingResult> => {
  const { request } = options;
  const discovered = discoverBundles(request.root, {
    repository: request.repository,
    collectionsPath: request.collectionsPath,
    skillsPath: request.skillsPath
  });
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
      // Documentation costs fewer points but is still rated, so it is not skipped.
      includeDocFiles: true,
      ignoreTrust: request.ignoreTrust ?? 'none'
    }
  });
  const findings: SecurityFinding[] = scan.findings.map((item) => ({ ...item, file: relativeToRoot(request.root, item.file) }));
  const report = buildQualityReport({
    findings,
    bundles: discovered.bundles,
    mode: discovered.mode,
    failOn: request.failOn,
    generatedAt: options.clock.nowIso(),
    // The hub's schema allows only the scanner name, so the engine version is not recorded here.
    scanner: { name: SCANNER_NAME },
    source: { repository: request.repository, tag: request.tag ?? '', commit: request.commit ?? '' }
  });
  return { report, scan, warnings: discovered.warnings };
};
