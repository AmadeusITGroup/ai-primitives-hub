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
  hubCollectionFindings,
  type HubCollectionIndex,
  type HubCollectionInventory,
  releaseFindings,
  type ReleaseLookup,
} from '@ai-primitives-hub/core';
import {
  validateAllSkills,
} from '../collection/generate-skill';
import {
  validateHubConfigFile,
} from '../registry/validate-hub-config-file';
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
}

async function hubFindings(fs: FileSystem, request: GovernanceRequest): Promise<GovernanceFinding[]> {
  const findings: GovernanceFinding[] = [];
  const config = request.config ?? 'hub-config.yml';
  // Validate statically before calling any source evidence ports.
  const result = await validateHubConfigFile(fs, path.resolve(request.repoRoot, config));
  findings.push(...result.errors.map((message) => ({ ruleId: 'HUB001', severity: 'error' as const, message, file: config })),
    ...(result.warnings ?? []).map((message) => ({ ruleId: 'HUB002', severity: 'warning' as const, message, file: config })));
  if (!result.valid || !request.checkSources) {
    return findings;
  }
  let inventory: HubCollectionInventory;
  try {
    inventory = request.collectionIndex === undefined
      ? { collections: [], unverifiedSources: [{ sourceId: 'hub', message: 'Source inventory dependencies are required.' }] }
      : await request.collectionIndex.read();
  } catch {
    inventory = { collections: [], unverifiedSources: [{ sourceId: 'hub', message: 'Source inventory is unavailable; check access and retry.' }] };
  }
  // An incomplete inventory also leaves publication evidence unknown.
  // A COL004 exemption must not bypass floor rule COL002.
  findings.push(...hubCollectionFindings(inventory), ...inventory.unverifiedSources.map(({ sourceId, message, hint }) => ({
    ruleId: 'COL002', severity: 'error' as const, verified: false, file: sourceId,
    message: `Could not check the published releases of source '${sourceId}'. Why: ${message}`,
    hint: hint ?? 'Fix access to this source and retry.'
  })));
  for (const collection of inventory.releaseCandidates ?? inventory.collections) {
    let evidence;
    try {
      evidence = request.releaseLookup === undefined ? { status: 'unverified' as const } : await request.releaseLookup.lookup(collection);
    } catch {
      evidence = { status: 'unverified' as const };
    }
    findings.push(...releaseFindings(collection, evidence));
  }
  return findings;
}

async function primitiveSubjectFindings(fs: FileSystem, request: GovernanceRequest, onScope: (scope: PrScope) => void): Promise<GovernanceFinding[]> {
  const changes = await readPrChanges(request, request.repoRoot);
  if (changes) {
    // PR mode: only primitives the PR added or modified, under the given paths (default: whole repository).
    const roots = request.primitivePaths?.length ? request.primitivePaths : [request.skillsDir ?? '.'];
    const files = await changedPrimitiveFiles(fs, request.repoRoot, changes.files, roots);
    onScope({ baseRef: changes.baseRef, headRef: changes.headRef, mergeBase: changes.mergeBase, changedFiles: changes.files, validated: files });
    return files.length === 0 ? [] : (await validateLocalPrimitives(fs, request.repoRoot, files, request.primitiveKind)).findings;
  }
  if (request.primitivePaths !== undefined && request.primitivePaths.length > 0) {
    return (await validateLocalPrimitives(fs, request.repoRoot, request.primitivePaths, request.primitiveKind)).findings;
  }
  const skillsDir = request.skillsDir ?? 'skills';
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
    return evaluateGovernance(request.subject, config.findings, {}, request.minScore, { mode });
  }
  let findings: GovernanceFinding[];
  let prScope: PrScope | undefined;
  try {
    findings = request.subject === 'hub'
      ? await hubFindings(fs, request)
      : await primitiveSubjectFindings(fs, request, (scope) => {
        prScope = scope;
      });
  } catch (error) {
    findings = [{ ruleId: request.subject === 'hub' ? 'HUB001' : 'SKL001', severity: 'error',
      message: `Validation could not complete: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const report = evaluateGovernance(request.subject, withDisplayPaths(findings, request.repoRoot), config.policy, request.minScore,
    { mode, configFile: config.file });
  return prScope ? { ...report, prScope } : report;
}
