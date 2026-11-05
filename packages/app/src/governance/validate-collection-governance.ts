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
  type GovernanceCollection,
  type GovernanceFinding,
  type GovernanceReport,
  hubCollectionFindings,
  type HubCollectionIndex,
  type HubCollectionInventory,
  hubCollectionReferences,
  type HubEntity,
  releaseFindings,
  type ReleaseLookup,
  scopedHubInventory,
} from '@ai-primitives-hub/core';
import {
  parseGitHubRepositoryTarget,
} from '@ai-primitives-hub/infra';
import {
  describeFailure,
  type FailureReason,
  FileCollectionIndex,
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
  type LoadedGovernanceConfig,
  loadScopedGovernanceConfig,
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
  collectionFiles?: string[];
  checkReleases?: boolean;
  /** Verify collection ownership against .config/sources/collection-index.yml relative to the hub config directory (COL004). */
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
  /** Selected valid collections, collected during the existing validation pass. */
  candidates?: GovernanceCollection[];
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
  const affected = options.affected === undefined ? undefined : new Set([...options.affected].map((file) => file.replaceAll('\\', '/')));
  const all = withDisplayPaths(collectionGovernanceFindings(result), repoRoot);
  const findings = affected === undefined
    ? all
    : all.filter((finding) => concerns(finding, affected));
  if (options.checkReleases || options.candidates) {
    for (const file of result.fileResults) {
      const collectionFile = file.file.replaceAll('\\', '/');
      if (!file.ok || !file.collection || (affected !== undefined && !affected.has(collectionFile))) {
        continue;
      }
      const collection = { id: file.collection.id, name: file.collection.name, sourceId: options.sourceId, repository: options.repository, file: collectionFile };
      options.candidates?.push(collection);
      if (!options.checkReleases) {
        continue;
      }
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
 * Changed sources and canonical profile references, with full reference coverage for index edits.
 * @param request
 * @param changes
 */
async function changedHubCollections(request: CollectionGovernanceRequest, changes: GitChangedFiles): Promise<{ sources: HubEntity[]; references: GovernanceCollection[] }> {
  const config = request.config ?? 'hub-config.yml';
  const indexChanged = request.checkSources === true && changes.files.includes(path.posix.join(path.posix.dirname(config), '.config', 'sources', 'collection-index.yml'));
  if ((!changes.files.includes(config) && !indexChanged) || request.processRunner === undefined) {
    return { sources: [], references: [] };
  }
  const snapshot = await readGitHubScope(request.processRunner, request.repoRoot, config, changes.baseRef, changes.headRef);
  const scope = computeHubScope(snapshot.base, snapshot.head);
  const ids = new Set([...scope.sources.added, ...scope.sources.modified]);
  const references = indexChanged
    ? computeHubScope(snapshot.head, snapshot.head, { sourceIds: [], profileIds: snapshot.head.profiles.map((profile) => profile.id) }).references
    : scope.references;
  return {
    sources: snapshot.head.sources.filter((source) => ids.has(source.id) && source.enabled === true && source.type === 'github'),
    references: hubCollectionReferences(snapshot.head, references).map((collection) => ({ ...collection, file: config }))
  };
}

/**
 * Enabled GitHub sources the PR added or modified; retained for SDK consumers.
 * @param request
 * @param changes
 */
export async function changedGitHubSources(request: CollectionGovernanceRequest, changes: GitChangedFiles): Promise<HubEntity[]> {
  return (await changedHubCollections(request, changes)).sources;
}

/**
 * Download one hub source and validate its collections. Paths are reported as `<source id>/<file>`.
 * @param fs
 * @param source
 * @param request
 * @param candidates
 */
async function sourceCollectionFindings(fs: FileSystem, source: HubEntity, request: CollectionGovernanceRequest, candidates: GovernanceCollection[]): Promise<GovernanceFinding[]> {
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
    const selected: GovernanceCollection[] = [];
    const findings = await repositoryFindings(fs, checkout.dir, {
      checkReleases: request.checkReleases, repository: checkout.repository, sourceId: source.id, releaseLookup: checkout.releaseLookup, candidates: selected
    });
    candidates.push(...selected.map((collection) => ({ ...collection, file: `${source.id}/${collection.file}` })));
    return withDisplayPaths(findings, checkout.dir).map((finding) => ({ ...finding, file: finding.file === undefined ? source.id : `${source.id}/${finding.file}` }));
  } finally {
    await checkout.dispose();
  }
}

/**
 * Resolve only unambiguous enabled repository ownership; never guess from a collection ID.
 * @param repository
 * @param inventory
 */
function repositorySourceId(repository: string | undefined, inventory: HubCollectionInventory | undefined): string {
  if (!repository || !inventory?.registry) {
    return inventory?.registry ? '' : 'repository';
  }
  const identity = (url: string) => {
    const target = parseGitHubRepositoryTarget(url);
    return `${target.host}/${target.owner}/${target.repository}`.toLowerCase();
  };
  try {
    const expected = identity(repository);
    const matches = [...inventory.registry.sources].filter(([, url]) => {
      try {
        return identity(url) === expected;
      } catch {
        return false;
      }
    });
    return matches.length === 1 ? matches[0][0] : '';
  } catch {
    return '';
  }
}

/**
 * Run collection checks and apply policy without loading source adapters.
 * @param fs Filesystem port.
 * @param request Root, collection files, PR refs and options.
 */
export async function validateCollectionGovernance(fs: FileSystem, request: CollectionGovernanceRequest): Promise<CollectionGovernanceReport> {
  let mode: 'sources' | 'offline' = request.checkReleases || request.checkSources ? 'sources' : 'offline';
  let config: LoadedGovernanceConfig = { policy: {}, findings: [] };
  let findings: GovernanceFinding[];
  let prScope: PrScope | undefined;
  try {
    const changes = await readPrChanges(request, request.repoRoot);
    config = await loadScopedGovernanceConfig(fs, request, changes?.mergeBase);
    if (config.findings.length > 0) {
      return evaluateGovernance('collection', config.findings, {}, { mode, configFile: config.file });
    }
    if (changes && request.collectionFiles?.length) {
      throw new Error('--collection-file cannot be combined with --base-ref/--head-ref.');
    }
    let inventory: HubCollectionInventory | undefined;
    let legacyInventory = false;
    if (request.checkSources) {
      try {
        const configPath = path.resolve(request.repoRoot, request.config ?? 'hub-config.yml');
        const relative = path.relative(request.repoRoot, configPath);
        const inRepository = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        const index = request.collectionIndex ?? new FileCollectionIndex(fs, configPath,
          changes && inRepository && request.processRunner
            ? { repoRoot: request.repoRoot, commit: changes.headRef, runner: request.processRunner }
            : undefined);
        inventory = await index.read();
        legacyInventory = request.collectionIndex !== undefined && inventory.registry === undefined;
      } catch (error) {
        inventory = { collections: [], unverifiedSources: [{ sourceId: 'collection-index.yml',
          message: error instanceof Error ? error.message : 'Central collection index is unavailable.',
          hint: 'Provide a valid .config/sources/collection-index.yml relative to the trusted hub config directory. No remote inventory fallback is performed.' }] };
      }
    }
    const candidates: GovernanceCollection[] = [];
    const hasCollectionsDir = await fs.exists(path.join(request.repoRoot, 'collections'));
    const affected = changes ? new Set(hasCollectionsDir ? affectedCollections(request.repoRoot, changes.files).map((c) => c.file.replaceAll('\\', '/')) : []) : undefined;
    const changed = changes ? await changedHubCollections(request, changes) : { sources: [], references: [] };
    const sources = changed.sources;
    candidates.push(...changed.references);
    if (changes) {
      prScope = { baseRef: changes.baseRef, headRef: changes.headRef, mergeBase: changes.mergeBase, changedFiles: changes.files,
        validated: [...affected ?? []].toSorted(), ...(sources.length > 0 ? { sources: sources.map((source) => source.id).toSorted() } : {}) };
    }
    findings = withDisplayPaths(await repositoryFindings(fs, request.repoRoot, {
      collectionFiles: request.collectionFiles, affected, checkReleases: request.checkReleases,
      repository: request.repository, releaseLookup: request.releaseLookup, sourceId: repositorySourceId(request.repository, inventory), candidates
    }), request.repoRoot);
    for (const source of sources) {
      mode = 'sources';
      findings.push(...await sourceCollectionFindings(fs, source, request, candidates));
    }
    if (inventory) {
      // Only a successfully supplied legacy inventory can be scoped. Index failures must
      // remain errors even when the PR has no candidates or profile references.
      if (legacyInventory && changes && request.processRunner) {
        const snapshot = await readGitHubScope(request.processRunner, request.repoRoot, request.config ?? 'hub-config.yml', changes.baseRef, changes.headRef);
        inventory = scopedHubInventory(snapshot.head, computeHubScope(snapshot.base, snapshot.head), inventory);
      }
      findings.push(...hubCollectionFindings(inventory, candidates));
    }
  } catch (error) {
    findings = [{ ruleId: 'COL005', severity: 'error',
      message: `Validation could not complete: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const report = evaluateGovernance('collection', findings, config.policy,
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
