/**
 * Collection governance: the established file validator plus the shared policy engine.
 * With `--base-ref`/`--head-ref`, only collections the PR touched are reported. When the PR changes
 * the hub config, every added or modified enabled github source is downloaded and its collections validated.
 * @module app/governance/validate-collection-governance
 */
import * as path from 'node:path';
import {
  collectionGovernanceFindings,
  computeHubScope,
  evaluateGovernance,
  type FileSystem,
  type GovernanceFinding,
  type GovernanceReport,
  hubCollectionFindings,
  type HubCollectionIndex,
  type HubEntity,
  releaseFindings,
  type ReleaseLookup,
  scopedHubInventory,
} from '@ai-primitives-hub/core';
import {
  describeFailure,
  type FailureReason,
  type GitChangedFiles,
  readGitHubScope,
} from '@ai-primitives-hub/infra/governance';
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

/** A hub source downloaded to a temporary directory. */
export interface HubSourceCheckout {
  dir: string;
  /** Repository URL used for release lookups. */
  repository: string;
  releaseLookup: ReleaseLookup;
  dispose(): Promise<void>;
}

/** Downloads hub sources with their own authentication; supplied by the delivery layer. */
export interface HubSourceAccess {
  checkout(source: HubEntity): Promise<HubSourceCheckout>;
}

export interface CollectionGovernanceRequest extends PrScopeRequest {
  repoRoot: string;
  policy?: string;
  minScore?: number;
  collectionFiles?: string[];
  checkReleases?: boolean;
  /** Verify collection IDs against all enabled hub sources (COL004). */
  checkSources?: boolean;
  collectionIndex?: HubCollectionIndex;
  repository?: string;
  releaseLookup?: ReleaseLookup;
  /** Hub configuration file whose changed sources are validated in PR mode (default `hub-config.yml`). */
  config?: string;
  /** Downloads hub sources changed by the PR. */
  hubSources?: HubSourceAccess;
}

export type CollectionGovernanceReport = GovernanceReport & { prScope?: PrScope };

interface RepositoryOptions {
  collectionFiles?: string[];
  /** PR mode: only these collection files are reported. */
  affected?: ReadonlySet<string>;
  checkReleases?: boolean;
  repository?: string;
  releaseLookup?: ReleaseLookup;
  sourceId: string;
}

/**
 * A finding belongs to a collection when it names the file in its `file` field or message prefix.
 * @param finding
 * @param files
 */
const concerns = (finding: GovernanceFinding, files: ReadonlySet<string>): boolean =>
  (finding.file !== undefined && files.has(finding.file)) || [...files].some((file) => finding.message.startsWith(`${file}:`));

/**
 * Validate the collections of one repository on disk, and their releases when requested.
 * @param fs
 * @param repoRoot
 * @param options
 */
async function repositoryFindings(fs: FileSystem, repoRoot: string, options: RepositoryOptions): Promise<GovernanceFinding[]> {
  // A repository without a collections/ directory has no collections, not a read error.
  // Uniqueness (COL001) needs every collection, so the whole set is validated and then narrowed.
  const files = options.collectionFiles?.length
    ? options.collectionFiles
    : (await fs.exists(path.join(repoRoot, 'collections')) ? listCollectionFiles(repoRoot) : []);
  const result = files.length === 0 ? undefined : validateAllCollections(repoRoot, files);
  if (result === undefined) {
    return options.affected === undefined
      ? [{ ruleId: 'COL005', severity: 'error' as const, message: 'No collection files found. Supply --collection-file or a non-empty collections/ directory.' }]
      : [];
  }
  const affected = options.affected;
  const findings = affected === undefined
    ? collectionGovernanceFindings(result)
    : collectionGovernanceFindings(result).filter((finding) => concerns(finding, affected));
  if (options.checkReleases) {
    for (const file of result.fileResults) {
      if (!file.ok || !file.collection || (affected !== undefined && !affected.has(file.file))) {
        continue;
      }
      const collection = { id: file.collection.id, name: file.collection.name, sourceId: options.sourceId, repository: options.repository, file: file.file };
      let evidence;
      try {
        evidence = options.releaseLookup === undefined
          ? { status: 'unverified' as const, message: 'Supply --repository <owner/repo> and a release lookup for publication checks.' }
          : await options.releaseLookup.lookup(collection);
      } catch {
        evidence = { status: 'unverified' as const };
      }
      findings.push(...releaseFindings(collection, evidence));
    }
  }
  return findings;
}

/**
 * Enabled github sources the PR added or modified in the hub config. Other source types have no collection files to validate.
 * @param request
 * @param changes
 */
export async function changedGitHubSources(request: CollectionGovernanceRequest, changes: GitChangedFiles): Promise<HubEntity[]> {
  const config = request.config ?? 'hub-config.yml';
  if (!changes.files.includes(config) || request.processRunner === undefined) {
    return [];
  }
  const snapshot = await readGitHubScope(request.processRunner, request.repoRoot, config, changes.baseRef, changes.headRef);
  const scope = computeHubScope(snapshot.base, snapshot.head);
  const ids = new Set([...scope.sources.added, ...scope.sources.modified]);
  return snapshot.head.sources.filter((source) => ids.has(source.id) && source.enabled === true && source.type === 'github');
}

/**
 * Download one hub source and validate its collections. Paths are reported as `<source id>/<file>`.
 * @param fs
 * @param source
 * @param request
 */
async function sourceCollectionFindings(fs: FileSystem, source: HubEntity, request: CollectionGovernanceRequest): Promise<GovernanceFinding[]> {
  const unreadable = (failure: FailureReason): GovernanceFinding[] => [{
    ruleId: 'COL005', severity: 'error', verified: false, file: source.id, subject: { kind: 'source', id: source.id }, problem: failure.reason,
    message: `Could not download source '${source.id}' to validate its collections. Why: ${failure.reason}`, hint: failure.hint
  }];
  if (request.hubSources === undefined) {
    return unreadable({ reason: 'Source download is not configured', hint: 'Run through the CLI, which supplies source access.' });
  }
  let checkout;
  try {
    checkout = await request.hubSources.checkout(source);
  } catch (error) {
    return unreadable(describeFailure(error));
  }
  try {
    const findings = await repositoryFindings(fs, checkout.dir, {
      checkReleases: request.checkReleases, repository: checkout.repository, sourceId: source.id, releaseLookup: checkout.releaseLookup
    });
    return withDisplayPaths(findings, checkout.dir).map((finding) => ({ ...finding, file: finding.file === undefined ? source.id : `${source.id}/${finding.file}` }));
  } finally {
    await checkout.dispose();
  }
}

/**
 * Run collection checks and apply policy without loading source adapters.
 * @param fs Filesystem port.
 * @param request Root, collection files, PR refs and options.
 */
export async function validateCollectionGovernance(fs: FileSystem, request: CollectionGovernanceRequest): Promise<CollectionGovernanceReport> {
  let mode: 'sources' | 'offline' = request.checkReleases || request.checkSources ? 'sources' : 'offline';
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
    const hasCollectionsDir = await fs.exists(path.join(request.repoRoot, 'collections'));
    const affected = changes ? new Set(hasCollectionsDir ? affectedCollections(request.repoRoot, changes.files).map((c) => c.file) : []) : undefined;
    const sources = changes ? await changedGitHubSources(request, changes) : [];
    if (changes) {
      prScope = { baseRef: changes.baseRef, headRef: changes.headRef, mergeBase: changes.mergeBase, changedFiles: changes.files,
        validated: [...affected ?? []].toSorted(), ...(sources.length > 0 ? { sources: sources.map((source) => source.id).toSorted() } : {}) };
    }
    findings = withDisplayPaths(await repositoryFindings(fs, request.repoRoot, {
      collectionFiles: request.collectionFiles, affected, checkReleases: request.checkReleases,
      repository: request.repository, releaseLookup: request.releaseLookup, sourceId: 'repository'
    }), request.repoRoot);
    for (const source of sources) {
      mode = 'sources';
      findings.push(...await sourceCollectionFindings(fs, source, request));
    }
    if (request.checkSources) {
      let inventory;
      try {
        inventory = request.collectionIndex === undefined
          ? { collections: [], unverifiedSources: [{ sourceId: 'hub', message: 'Source inventory dependencies are required.' }] }
          : await request.collectionIndex.read();
      } catch {
        inventory = { collections: [], unverifiedSources: [{ sourceId: 'hub', message: 'Source inventory is unavailable; check access and retry.' }] };
      }
      if (changes && request.processRunner) {
        const snapshot = await readGitHubScope(request.processRunner, request.repoRoot, request.config ?? 'hub-config.yml', changes.baseRef, changes.headRef);
        inventory = scopedHubInventory(snapshot.head, computeHubScope(snapshot.base, snapshot.head), inventory);
      }
      findings.push(...hubCollectionFindings(inventory));
    }
  } catch (error) {
    findings = [{ ruleId: 'COL005', severity: 'error',
      message: `Validation could not complete: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const report = evaluateGovernance('collection', findings, config.policy, request.minScore,
    { mode, configFile: config.file });
  if (mode === 'sources') {
    for (const [ruleId, enabled, option] of [
      ['COL002', request.checkReleases, '--check-releases'],
      ['COL004', request.checkSources, '--check-sources']
    ] as const) {
      if (!enabled && !report.suppressions.some((entry) => entry.ruleId === ruleId && entry.action === 'disabled')) {
        report.notChecked.push({ ruleId, reason: `Not requested; use ${option}.` });
      }
    }
  }
  return prScope ? { ...report, prScope } : report;
}
