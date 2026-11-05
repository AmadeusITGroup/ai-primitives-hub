/** Hub governance orchestration over the shared hub validator. */
import * as path from 'node:path';
import {
  evaluateGovernance,
  type FileSystem,
  type GovernanceFinding,
  type GovernanceReport,
} from '@ai-primitives-hub/core';
import type {
  SourceAdapterFactoryDeps,
} from '../registry/create-source-adapter';
import {
  validateHubConfigFile,
} from '../registry/validate-hub-config-file';
import {
  loadGovernanceConfig,
  withDisplayPaths,
} from './load-config';

export interface GovernanceRequest {
  subject: 'hub';
  repoRoot: string;
  config?: string;
  policy?: string;
  checkSources?: boolean;
  sourceAdapterDeps?: SourceAdapterFactoryDeps;
  hubSourceErrors?: string[];
}

/**
 * Load policy, validate the hub and return the shared error-based verdict.
 * @param fs
 * @param request
 */
export async function runGovernance(fs: FileSystem, request: GovernanceRequest): Promise<GovernanceReport> {
  const config = await loadGovernanceConfig(fs, request.repoRoot, request.policy);
  const mode = request.checkSources ? 'sources' : 'offline';
  if (config.findings.length > 0) {
    return evaluateGovernance('hub', config.findings, {}, { mode });
  }
  const file = request.config ?? 'hub-config.yml';
  let findings: GovernanceFinding[];
  try {
    if (request.hubSourceErrors?.length) {
      findings = request.hubSourceErrors.map((message) => ({ ruleId: 'HUB001', severity: 'error', message, file }));
    } else {
      const result = await validateHubConfigFile(fs, path.resolve(request.repoRoot, file), request.checkSources
        ? { deep: true, sourceAdapterDeps: request.sourceAdapterDeps }
        : undefined);
      findings = [
        ...result.errors.map((message) => ({ ruleId: 'HUB001', severity: 'error' as const, message, file })),
        ...(result.warnings ?? []).map((message) => ({ ruleId: 'HUB002', severity: 'warning' as const, message, file }))
      ];
    }
  } catch (error) {
    findings = [{ ruleId: 'HUB001', severity: 'error', message: `Validation could not complete: ${error instanceof Error ? error.message : String(error)}` }];
  }
  return evaluateGovernance('hub', withDisplayPaths(findings, request.repoRoot), config.policy, { mode, configFile: config.file });
}
