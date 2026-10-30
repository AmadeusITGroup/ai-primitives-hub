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
  type ReleaseLookup,
} from '@ai-primitives-hub/core';
import {
  validateAllSkills,
} from '../collection/generate-skill';
import type {
  SourceAdapterFactoryDeps,
} from '../registry/create-source-adapter';
import {
  validateHubConfigFile,
} from '../registry/validate-hub-config-file';
import {
  validateHubSourcePrimitives,
} from './hub-source-primitives-v1';
import {
  loadGovernanceConfig,
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
  /** Primitive subject: a skills directory validated with the folder-level skill validator. */
  skillsDir?: string;
  /** Primitive subject: files or directories validated with the content rules. */
  primitivePaths?: string[];
  primitiveKind?: GovernedPrimitiveKind;
  minScore?: number;
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
  fs: FileSystem, request: GovernanceRequest, onScope: (scope: PrScope) => void, applicable: Set<string>
): Promise<GovernanceFinding[]> {
  const inspect = async (root: string, inputs: string[], kind?: GovernedPrimitiveKind) => {
    const localResult = await validateLocalPrimitives(fs, root, inputs, kind);
    for (const id of localResult.applicableRules) {
      applicable.add(id);
    }
    return localResult;
  };
  const changes = await readPrChanges(request, request.repoRoot);
  if (changes) {
    // PR mode: only primitives the PR added or modified, under the given paths (default: whole repository).
    const roots = request.primitivePaths?.length ? request.primitivePaths : [request.skillsDir ?? '.'];
    const files = await changedPrimitiveFiles(fs, request.repoRoot, changes.files, roots);
    const sources = await changedGitHubSources(request, changes);
    const local = files.length === 0 ? undefined : await inspect(request.repoRoot, files, request.primitiveKind);
    const findings = local?.findings ?? [];
    const validated = [...local?.files ?? []];
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
  if (request.primitivePaths !== undefined && request.primitivePaths.length > 0) {
    return (await inspect(request.repoRoot, request.primitivePaths, request.primitiveKind)).findings;
  }
  const skillsDir = request.skillsDir ?? 'skills';
  if (await fs.exists(path.resolve(request.repoRoot, skillsDir))) {
    const safe = await inspect(request.repoRoot, [skillsDir]);
    if (safe.findings.some((finding) => finding.ruleId === 'PTH001')) {
      return safe.findings;
    }
    const legacy = validateAllSkills(request.repoRoot, skillsDir);
    return [...safe.findings, ...legacy.skills.flatMap((skill) => skill.errors.map((message) => ({
      ruleId: 'SKL001', severity: 'error' as const, message, file: path.posix.join(skillsDir, skill.folderName, 'SKILL.md')
    })))].filter((finding, index, all) => all.findIndex((entry) => entry.ruleId === finding.ruleId && entry.file === finding.file && entry.message === finding.message) === index);
  }
  const result = validateAllSkills(request.repoRoot, skillsDir);
  if (result.totalSkills === 0) {
    return [{ ruleId: 'SKL001', severity: 'error', message: 'No skills found in the supplied skills directory.', file: skillsDir }];
  }
  return result.skills.flatMap((skill) => skill.errors.map((message) => ({
    ruleId: 'SKL001', severity: 'error' as const, message, file: path.posix.join(skillsDir, skill.folderName, 'SKILL.md')
  })));
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
  const config = await loadGovernanceConfig(fs, request.repoRoot, request.policy);
  const mode = request.subject === 'hub' && request.checkSources ? 'sources' : 'offline';
  if (config.findings.length > 0) {
    const invalid = evaluateGovernance(request.subject, config.findings, {}, request.minScore, { mode });
    return request.subject === 'primitive' ? { ...invalid, applicableRules: [] } : invalid;
  }
  let findings: GovernanceFinding[];
  let prScope: PrScope | undefined;
  const applicable = new Set<string>();
  try {
    findings = request.subject === 'hub'
      ? await hubFindings(fs, request)
      : await primitiveSubjectFindings(fs, request, (scope) => {
        prScope = scope;
      }, applicable);
  } catch (error) {
    findings = [{ ruleId: request.subject === 'hub' ? 'HUB001' : 'SKL001', severity: 'error',
      message: `Validation could not complete: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const report = evaluateGovernance(request.subject, withDisplayPaths(findings, request.repoRoot), config.policy, request.minScore,
    { mode: prScope?.sources?.length ? 'sources' : mode, configFile: config.file });
  if (request.subject === 'primitive') {
    report.applicableRules = [...new Set([...applicable, ...findings.map((finding) => finding.ruleId)])].toSorted();
  }
  return prScope ? { ...report, prScope } : report;
}
