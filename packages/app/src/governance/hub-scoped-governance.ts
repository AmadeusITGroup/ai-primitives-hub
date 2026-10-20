/**
 * PR-scoped hub governance: validate only the sources and profiles a PR changed, plus their dependencies.
 * Composes pure scope selection (core), Git/parse boundaries (infra) and the existing validators.
 * @module app/governance/hub-scoped-governance
 */
import * as path from 'node:path';
import {
  type ArgvProcessRunner,
  computeHubScope,
  evaluateGovernance,
  type FileSystem,
  type GovernanceFinding,
  type GovernanceReport,
  hubCollectionFindings,
  type HubCollectionIndex,
  type HubScope,
  type HubScopeDocument,
  hubScopeInventoryDocument,
  hubScopeLocationMapper,
  releaseFindings,
  type ReleaseLookup,
  scopedHubInventory,
  selectHubScope,
} from '@ai-primitives-hub/core';
import {
  HttpSnapshot,
  hubScopeFileSystem,
  parseHubScopeDocument,
  parseHubScopeFile,
  readGitBlob,
  readGitHubScope,
  validateHubScopeDocument,
} from '@ai-primitives-hub/infra';
import type {
  SourceAdapterFactoryDeps,
} from '../registry/create-source-adapter';
import {
  type HubValidationProgress,
  validateHubConfigFile,
} from '../registry/validate-hub-config-file';
import {
  GOVERNANCE_CONFIG_FILE,
  governanceConfigFromContent,
  type LoadedGovernanceConfig,
  loadGovernanceConfig,
  withDisplayPaths,
} from './load-config';
import {
  createHubGovernanceSourceChecks,
} from './source-checks';

export interface HubScopedGovernanceRequest {
  repoRoot: string;
  config?: string;
  baseRef?: string;
  headRef?: string;
  scopeFile?: string;
  processRunner: ArgvProcessRunner;
  /** Explicit governance configuration. Otherwise `hub-governance.yml` is read from the PR base. */
  policy?: string;
  minScore?: number;
  checkSources?: boolean;
  sourceAdapterDeps?: SourceAdapterFactoryDeps;
  collectionIndex?: HubCollectionIndex;
  releaseLookup?: ReleaseLookup;
  /** Overall time limit for reading hub-wide collection ids (COL004). */
  inventoryDeadlineMs?: number;
  onProgress?: (event: HubValidationProgress) => void;
  onInventoryProgress?: Parameters<typeof createHubGovernanceSourceChecks>[3];
}
export interface HubScopedGovernanceReport extends GovernanceReport {
  scope?: HubScope & { baseRef?: string; headRef?: string; mergeBase?: string; origin: 'git' | 'file' };
}

const REMOTE_SOURCE_TYPES = new Set(['github', 'awesome-copilot', 'skills']);

/**
 * In Git mode the configuration comes from the merge base, so a PR cannot relax its own gate.
 * @param fs
 * @param request
 * @param mergeBase
 */
async function scopedConfig(fs: FileSystem, request: HubScopedGovernanceRequest, mergeBase?: string): Promise<LoadedGovernanceConfig> {
  if (request.policy !== undefined || mergeBase === undefined) {
    return loadGovernanceConfig(fs, request.repoRoot, request.policy);
  }
  try {
    return governanceConfigFromContent(await readGitBlob(request.processRunner, request.repoRoot, mergeBase, GOVERNANCE_CONFIG_FILE), GOVERNANCE_CONFIG_FILE);
  } catch {
    return { policy: {}, file: GOVERNANCE_CONFIG_FILE,
      findings: [{ ruleId: 'CFG001', severity: 'error', file: GOVERNANCE_CONFIG_FILE, message: 'Unable to read governance configuration from the PR base.' }] };
  }
}

/**
 * Validate only semantic PR changes and dependencies using shared validators.
 * @param fs Filesystem port.
 * @param request Refs or scope file, configuration and options.
 */
export async function runHubScopedGovernance(fs: FileSystem, request: HubScopedGovernanceRequest): Promise<HubScopedGovernanceReport> {
  const findings: GovernanceFinding[] = [];
  let scope: HubScopedGovernanceReport['scope'];
  let config: LoadedGovernanceConfig = { policy: {}, findings: [] };
  const mode = request.checkSources ? 'sources' : 'offline';
  const errors = (ruleId: string, messages: string[], map: (message: string) => string = (message) => message) =>
    findings.push(...messages.map((message) => ({ ruleId, severity: 'error' as const, message: map(message) })));
  try {
    if (request.scopeFile !== undefined && (request.baseRef !== undefined || request.headRef !== undefined)) {
      throw new Error('--scope-file cannot be combined with --base-ref/--head-ref.');
    }
    const configFile = request.config ?? 'hub-config.yml';
    const configPath = path.resolve(request.repoRoot, configFile);
    let head: HubScopeDocument;
    if (request.scopeFile === undefined) {
      if (request.baseRef === undefined || request.headRef === undefined) {
        throw new Error('Both --base-ref and --head-ref are required.');
      }
      const snapshot = await readGitHubScope(request.processRunner, request.repoRoot, configFile, request.baseRef, request.headRef);
      head = snapshot.head;
      scope = { ...computeHubScope(snapshot.base, head), origin: 'git', baseRef: snapshot.baseRef, headRef: snapshot.headRef, mergeBase: snapshot.mergeBase };
    } else {
      head = parseHubScopeDocument(await fs.readFile(configPath));
      const explicit = parseHubScopeFile(await fs.readFile(path.resolve(request.repoRoot, request.scopeFile)));
      scope = { ...computeHubScope(head, head, explicit), origin: 'file' };
    }
    config = await scopedConfig(fs, request, scope.mergeBase);
    findings.push(...config.findings);

    const selected = selectHubScope(head, scope);
    const staticErrors = validateHubScopeDocument(head, selected).errors;
    errors('HUB001', staticErrors, hubScopeLocationMapper(selected, head));
    const shouldCheckSources = config.findings.length === 0 && staticErrors.length === 0 && request.checkSources
      && !scope.noOp && (scope.sourceIds.length > 0 || scope.references.length > 0);
    if (shouldCheckSources) {
      const context = hubScopeInventoryDocument(head, scope);
      // Scoped Git validation must never execute APM/PR code or read checkout-local sources.
      if (selected.sources.some((s) => s.enabled && !REMOTE_SOURCE_TYPES.has(String(s.type)))
        || context.sources.some((s) => s.type === 'local-awesome-copilot')) {
        throw new Error('Scoped deep validation supports remote github, awesome-copilot and skills sources only; local/APM execution is prohibited.');
      }
      if (!request.sourceAdapterDeps) {
        throw new Error('Scoped deep validation requires source adapter dependencies.');
      }
      // Reuse authenticated GET evidence across deep validation and governance.
      // The snapshot belongs to this invocation, never a global/checkout cache.
      const deps = { ...request.sourceAdapterDeps, httpClient: new HttpSnapshot(request.sourceAdapterDeps.httpClient) };
      const deepDocument = { ...selected, profiles: selected.profiles.filter((p) => !Array.isArray(p.bundles) || p.bundles.length > 0) };
      const deep = await validateHubConfigFile(hubScopeFileSystem(fs, configPath, deepDocument), configPath,
        { deep: true, sourceAdapterDeps: deps, onProgress: request.onProgress });
      const locate = hubScopeLocationMapper(deepDocument, head);
      errors('HUB001', deep.errors, locate);
      findings.push(...(deep.warnings ?? []).map((message) => ({ ruleId: 'HUB002', severity: 'warning' as const, message: locate(message) })));

      // Changed sources are read in full; every other enabled source is context for COL004 only.
      const checks = createHubGovernanceSourceChecks(hubScopeFileSystem(fs, configPath, context), configPath, deps, request.onInventoryProgress,
        { fullSourceIds: new Set(scope.sourceIds), deadlineMs: request.inventoryDeadlineMs });
      const inventory = context.sources.length > 0
        ? await (request.collectionIndex ?? checks.collectionIndex).read()
        : { collections: [], unverifiedSources: [] };
      const evidence = scopedHubInventory(head, scope, inventory);
      findings.push(...hubCollectionFindings(evidence));
      if (evidence.unverifiedSources.length > 0) {
        const unread = [...new Set(evidence.unverifiedSources.map((entry) => entry.sourceId))];
        findings.push({ ruleId: 'HUB001', severity: 'error', verified: false,
          message: `The hub cannot be accepted yet: ${unread.length} of ${context.sources.length} enabled collection sources could not be read `
            + `(${unread.join(', ')}), so the IDs added by this PR cannot be confirmed unique across the hub. `
            + 'The reason for each source is listed under Collection validation (COL004).',
          hint: 'Fix those sources (for example update a renamed repository url or grant the token access), then re-run the check.' });
      }
      // Deep validation already reports profile references with no discovered bundle (HUB001);
      // checking their releases again would report the same problem twice.
      const discovered = new Set(inventory.collections.map((c) => `${c.sourceId}\u0000${c.id}`));
      for (const collection of (evidence.releaseCandidates ?? []).filter((c) => discovered.has(`${c.sourceId}\u0000${c.id}`))) {
        try {
          findings.push(...releaseFindings(collection, await (request.releaseLookup ?? checks.releaseLookup).lookup(collection)));
        } catch {
          findings.push(...releaseFindings(collection, { status: 'unverified' }));
        }
      }
    }
  } catch (error) {
    errors('HUB001', [error instanceof Error ? error.message : 'Scoped validation could not complete.']);
  }
  const policy = config.findings.length > 0 ? {} : config.policy;
  return { ...evaluateGovernance('hub', withDisplayPaths(findings, request.repoRoot), policy, request.minScore,
    { mode, configFile: config.file }), scope };
}
