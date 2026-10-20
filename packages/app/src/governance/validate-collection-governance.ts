/**
 * Collection governance: the established file validator plus the shared policy engine.
 * With `--base-ref`/`--head-ref`, only collections the PR touched are reported.
 * @module app/governance/validate-collection-governance
 */
import {
  collectionGovernanceFindings,
  evaluateGovernance,
  type FileSystem,
  type GovernanceFinding,
  type GovernanceReport,
  releaseFindings,
  type ReleaseLookup,
} from '@ai-primitives-hub/core';
import {
  affectedCollections,
} from '../collection/affected-collections';
import {
  listCollectionFiles,
  validateAllCollections,
} from '../collection/read-collection';
import {
  loadGovernanceConfig,
  withDisplayPaths,
} from './load-config';
import {
  type PrScope,
  type PrScopeRequest,
  readPrChanges,
} from './pr-scope';

export interface CollectionGovernanceRequest extends PrScopeRequest {
  repoRoot: string;
  policy?: string;
  minScore?: number;
  collectionFiles?: string[];
  checkReleases?: boolean;
  repository?: string;
  releaseLookup?: ReleaseLookup;
}

export type CollectionGovernanceReport = GovernanceReport & { prScope?: PrScope };

/**
 * A finding belongs to a collection when it names the file in its `file` field or message prefix.
 * @param finding
 * @param files
 */
const concerns = (finding: GovernanceFinding, files: ReadonlySet<string>): boolean =>
  (finding.file !== undefined && files.has(finding.file)) || [...files].some((file) => finding.message.startsWith(`${file}:`));

/**
 * Run collection checks and apply policy without loading source adapters.
 * @param fs Filesystem port.
 * @param request Root, collection files, PR refs and options.
 */
export async function validateCollectionGovernance(fs: FileSystem, request: CollectionGovernanceRequest): Promise<CollectionGovernanceReport> {
  const mode = request.checkReleases ? 'sources' : 'offline';
  const config = await loadGovernanceConfig(fs, request.repoRoot, request.policy);
  if (config.findings.length > 0) {
    return evaluateGovernance('collection', config.findings, {}, request.minScore, { mode });
  }
  let findings: GovernanceFinding[];
  let prScope: PrScope | undefined;
  try {
    const changes = await readPrChanges(request, request.repoRoot);
    if (changes && request.collectionFiles?.length) {
      throw new Error('--collection-file cannot be combined with --base-ref/--head-ref.');
    }
    const affected = changes ? new Set(affectedCollections(request.repoRoot, changes.files).map((c) => c.file)) : undefined;
    if (changes) {
      prScope = { baseRef: changes.baseRef, headRef: changes.headRef, mergeBase: changes.mergeBase, changedFiles: changes.files, validated: [...affected ?? []].toSorted() };
    }
    // Uniqueness (COL001) needs every collection, so the whole set is validated and then narrowed.
    const files = request.collectionFiles?.length ? request.collectionFiles : listCollectionFiles(request.repoRoot);
    const result = files.length === 0 ? undefined : validateAllCollections(request.repoRoot, files);
    if (result === undefined) {
      findings = affected === undefined
        ? [{ ruleId: 'COL005', severity: 'error' as const, message: 'No collection files found. Supply --collection-file or a non-empty collections/ directory.' }]
        : [];
    } else {
      findings = collectionGovernanceFindings(result);
      if (affected !== undefined) {
        findings = findings.filter((finding) => concerns(finding, affected));
      }
    }
    if (request.checkReleases) {
      for (const file of result?.fileResults ?? []) {
        if (!file.ok || !file.collection || (affected !== undefined && !affected.has(file.file))) {
          continue;
        }
        const collection = { id: file.collection.id, name: file.collection.name, sourceId: 'repository', repository: request.repository, file: file.file };
        let evidence;
        try {
          evidence = request.releaseLookup === undefined
            ? { status: 'unverified' as const, message: 'Supply --repository <owner/repo> and a release lookup for publication checks.' }
            : await request.releaseLookup.lookup(collection);
        } catch {
          evidence = { status: 'unverified' as const };
        }
        findings.push(...releaseFindings(collection, evidence));
      }
    }
  } catch (error) {
    findings = [{ ruleId: 'COL005', severity: 'error',
      message: `Validation could not complete: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const report = evaluateGovernance('collection', withDisplayPaths(findings, request.repoRoot), config.policy, request.minScore,
    { mode, configFile: config.file });
  return prScope ? { ...report, prScope } : report;
}
