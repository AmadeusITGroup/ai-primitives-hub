/**
 * Governance use cases for whole hub configurations and primitives.
 * Collection runs delegate to `validateCollectionGovernance`; PR-scoped hub runs to `runHubScopedGovernance`.
 * @module app/governance/run-governance
 */
import * as path from 'node:path';
import {
  evaluateGovernance,
  type FileSystem,
  type GovernanceFinding,
  type GovernanceReport,
  type GovernanceSubject,
  type GovernedPrimitiveKind,
  type HubCollectionIndex,
  type HubEntity,
  type ReleaseLookup,
} from '@ai-primitives-hub/core';
import type {
  SourceAdapterFactoryDeps,
} from '../registry/create-source-adapter';
import {
  validateHubConfigFile,
} from '../registry/validate-hub-config-file';
import {
  validateHubSourcePrimitives,
} from './hub-source-primitives';
import {
  type LoadedGovernanceConfig,
  loadScopedGovernanceConfig,
  withDisplayPaths,
} from './load-config';
import {
  changedPrimitiveFiles,
  type PrScope,
  type PrScopeRequest,
  readPrChanges,
} from './pr-scope';
import {
  validateLocalPrimitives,
} from './primitive-governance';
import {
  changedGitHubSources,
  type HubSourceAccess,
  validateCollectionGovernance,
} from './validate-collection-governance';

export interface GovernanceRequest extends PrScopeRequest {
  subject: GovernanceSubject;
  repoRoot: string;
  /** Hub configuration file for the hub subject. */
  config?: string;
  /** Explicit governance configuration; otherwise `hub-governance.yml` is discovered. */
  policy?: string;
  collectionFiles?: string[];
  /** Primitive subject: files or directories validated with the content rules. */
  primitivePaths?: string[];
  primitiveKind?: GovernedPrimitiveKind;
  checkSources?: boolean;
  checkReleases?: boolean;
  repository?: string;
  collectionIndex?: HubCollectionIndex;
  releaseLookup?: ReleaseLookup;
  /** Source access and reference resolution for hub --check-sources. */
  sourceAdapterDeps?: SourceAdapterFactoryDeps;
  /** Hub authentication preflight failures, reported under HUB001 before network validation. */
  hubSourceErrors?: string[];
  /** Collection or primitive subject in PR mode: downloads hub sources the PR added or modified. */
  hubSources?: HubSourceAccess;
}

async function hubFindings(fs: FileSystem, request: GovernanceRequest): Promise<GovernanceFinding[]> {
  const findings: GovernanceFinding[] = [];
  const config = request.config ?? 'hub-config.yml';
  if (request.hubSourceErrors?.length) {
    return request.hubSourceErrors.map((message) => ({ ruleId: 'HUB001', severity: 'error', message, file: config }));
  }
  // Validate statically before calling any source evidence ports.
  const result = await validateHubConfigFile(fs, path.resolve(request.repoRoot, config), request.checkSources
    ? { deep: true, sourceAdapterDeps: request.sourceAdapterDeps }
    : undefined);
  findings.push(...result.errors.map((message) => ({ ruleId: 'HUB001', severity: 'error' as const, message, file: config })),
    ...(result.warnings ?? []).map((message) => ({ ruleId: 'HUB002', severity: 'warning' as const, message, file: config })));
  return findings;
}

async function primitiveSubjectFindings(
  fs: FileSystem, request: GovernanceRequest, changes: Awaited<ReturnType<typeof readPrChanges>>,
  onScope: (scope: PrScope) => void, applicable: Set<string>
): Promise<GovernanceFinding[]> {
  const inspect = async (root: string, inputs: string[], kind?: GovernedPrimitiveKind) => {
    const localResult = await validateLocalPrimitives(fs, root, inputs, kind);
    for (const id of localResult.applicableRules) {
      applicable.add(id);
    }
    return localResult;
  };
  if (changes) {
    // PR mode: only primitives the PR added or modified, under the given paths (default: whole repository).
    const roots = request.primitivePaths?.length ? request.primitivePaths : ['.'];
    const files = await changedPrimitiveFiles(fs, request.repoRoot, changes.files, roots, request.primitiveKind);
    // Local findings are kept when hub source discovery fails.
    const local = files.length === 0 ? undefined : await inspect(request.repoRoot, files, request.primitiveKind);
    const findings = local?.findings ?? [];
    const validated = [...local?.files ?? []];
    let sources: HubEntity[] = [];
    try {
      sources = await changedGitHubSources(request, changes);
    } catch (error) {
      findings.push({ ruleId: 'VAL001', severity: 'error', file: request.config ?? 'hub-config.yml',
        message: `Hub sources changed by the PR could not be read: ${error instanceof Error ? error.message : String(error)}` });
    }
    for (const source of sources) {
      const sourceResult = await validateHubSourcePrimitives(fs, source, request.hubSources);
      findings.push(...sourceResult.findings);
      for (const id of sourceResult.applicableRules) {
        applicable.add(id);
      }
      validated.push(...sourceResult.files);
    }
    onScope({ baseRef: changes.baseRef, headRef: changes.headRef, mergeBase: changes.mergeBase, changedFiles: changes.files,
      validated: [...new Set(validated)].toSorted(), ...(sources.length > 0 ? { sources: sources.map((source) => source.id).toSorted() } : {}) });
    return findings;
  }
  if (!request.primitivePaths?.length) {
    throw new Error('Give at least one primitive file or directory, or the PR base and head refs.');
  }
  return (await inspect(request.repoRoot, request.primitivePaths, request.primitiveKind)).findings;
}

/**
 * Load configuration and orchestrate the subject's validators.
 * @param fs Filesystem port.
 * @param request Subject, root, inputs and options.
 */
export async function runGovernance(fs: FileSystem, request: GovernanceRequest): Promise<GovernanceReport & { prScope?: PrScope }> {
  if (request.subject === 'collection') {
    return validateCollectionGovernance(fs, request);
  }
  let config: LoadedGovernanceConfig = { policy: {}, findings: [] };
  const mode = request.subject === 'hub' && request.checkSources ? 'sources' : 'offline';
  let findings: GovernanceFinding[];
  let prScope: PrScope | undefined;
  const applicable = new Set<string>();
  try {
    const changes = request.subject === 'primitive' ? await readPrChanges(request, request.repoRoot) : undefined;
    config = await loadScopedGovernanceConfig(fs, request, changes?.mergeBase);
    if (config.findings.length > 0) {
      const invalid = evaluateGovernance(request.subject, config.findings, {}, { mode, configFile: config.file });
      return request.subject === 'primitive' ? { ...invalid, applicableRules: [] } : invalid;
    }
    findings = request.subject === 'hub'
      ? await hubFindings(fs, request)
      : await primitiveSubjectFindings(fs, request, changes, (scope) => {
        prScope = scope;
      }, applicable);
  } catch (error) {
    findings = [{ ruleId: request.subject === 'hub' ? 'HUB001' : 'VAL001', severity: 'error',
      message: `Validation could not complete: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const report = evaluateGovernance(request.subject, withDisplayPaths(findings, request.repoRoot), config.policy,
    { mode: prScope?.sources?.length ? 'sources' : mode, configFile: config.file });
  if (request.subject === 'primitive') {
    report.applicableRules = [...new Set([...applicable, ...findings.map((finding) => finding.ruleId)])].toSorted();
  }
  return prScope ? { ...report, prScope } : report;
}
