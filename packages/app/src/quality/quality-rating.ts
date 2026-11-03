/**
 * Quality rating: score each bundle (collection or skill) of a source checkout from the findings
 * of a scan, and the source as the average of its bundles.
 *
 * The rating does not scan anything itself, so it works with the findings of any scanner.
 * @module app/quality/quality-rating
 */
import * as path from 'node:path';
import type {
  QualityFailOn,
  QualityFinding,
  QualityReport,
} from '@ai-primitives-hub/core';
import {
  buildQualityReport,
} from '@ai-primitives-hub/core';
import {
  discoverBundles,
} from './bundle-discovery';

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
  /** Name of the tool that produced the findings, recorded in the report. */
  scannerName: string;
}

export interface QualityRatingResult {
  report: QualityReport;
  /** Collection items that were missing or outside the repository. */
  warnings: readonly string[];
}

const relativeToRoot = (root: string, file: string): string => {
  if (!path.isAbsolute(file)) {
    return file;
  }
  const relative = path.relative(path.resolve(root), file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
};

/**
 * Rate the bundles of a checkout from scan findings.
 * @param options - The rating request, the findings and the report timestamp (ISO-8601 UTC)
 * @param options.request
 * @param options.findings
 * @param options.generatedAt
 */
export const runQualityRating = (options: {
  request: QualityRatingRequest;
  findings: readonly QualityFinding[];
  generatedAt: string;
}): QualityRatingResult => {
  const { request } = options;
  const discovered = discoverBundles(request.root, {
    repository: request.repository,
    collectionsPath: request.collectionsPath,
    skillsPath: request.skillsPath
  });
  const findings = options.findings.map((item) => ({ ...item, file: relativeToRoot(request.root, item.file) }));
  const report = buildQualityReport({
    findings,
    bundles: discovered.bundles,
    mode: discovered.mode,
    failOn: request.failOn,
    generatedAt: options.generatedAt,
    // The report schema records only the scanner name.
    scanner: { name: request.scannerName },
    source: { repository: request.repository, tag: request.tag ?? '', commit: request.commit ?? '' }
  });
  return { report, warnings: discovered.warnings };
};
