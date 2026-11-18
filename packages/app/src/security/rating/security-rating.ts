/**
 * Security rating: score each bundle (collection or skill) of a source checkout from the findings
 * of a scan, and the source as the average of its bundles.
 *
 * The rating does not scan anything itself, so it works with the findings of any scanner.
 * @module app/security/rating/security-rating
 */
import * as path from 'node:path';
import type {
  SecurityRatingFailOn,
  SecurityRatingFinding,
  SecurityRatingReport,
} from '@ai-primitives-hub/core';
import {
  buildSecurityRatingReport,
} from '@ai-primitives-hub/core';
import {
  discoverBundles,
} from './bundle-discovery';

export interface SecurityRatingRequest {
  /** Checkout to rate. */
  root: string;
  /** `owner/repo`, recorded in the report and used for skill bundle ids. */
  repository: string;
  tag?: string;
  commit?: string;
  failOn: SecurityRatingFailOn;
  collectionsPath?: string;
  skillsPath?: string;
  /** Name of the tool that produced the findings, recorded in the report. */
  scannerName: string;
}

export interface SecurityRatingResult {
  report: SecurityRatingReport;
  /** Collection items that were missing or outside the repository. */
  warnings: readonly string[];
}

const isOutside = (relative: string): boolean => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

const relativeToRoot = (root: string, file: string): string => {
  if (!path.isAbsolute(file)) {
    return file;
  }
  const relative = path.relative(path.resolve(root), file);
  return isOutside(relative) ? file : relative;
};

/**
 * True when a finding path resolves outside the checkout.
 * @param root
 * @param file
 */
const isOutsideRoot = (root: string, file: string): boolean => {
  const base = path.resolve(root);
  return isOutside(path.relative(base, path.resolve(base, file)));
};

/**
 * Rate the bundles of a checkout from scan findings.
 * @param options - The rating request, the findings and the report timestamp (ISO-8601 UTC)
 * @param options.request
 * @param options.findings
 * @param options.generatedAt
 */
export const runSecurityRating = (options: {
  request: SecurityRatingRequest;
  findings: readonly SecurityRatingFinding[];
  generatedAt: string;
}): SecurityRatingResult => {
  const { request } = options;
  const discovered = discoverBundles(request.root, {
    repository: request.repository,
    collectionsPath: request.collectionsPath,
    skillsPath: request.skillsPath
  });
  const findings = options.findings
    .filter((item) => !isOutsideRoot(request.root, item.file))
    .map((item) => ({ ...item, file: relativeToRoot(request.root, item.file) }));
  const report = buildSecurityRatingReport({
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
