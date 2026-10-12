/** Offline orchestration over the existing Hub, collection and skill validators. */
import * as path from 'node:path';
import type {
  FileSystem,
} from '@ai-primitives-hub/core';
import {
  collectionGovernanceFindingsV1,
  evaluateGovernanceV1,
  type GovernanceFindingV1,
  type GovernancePolicyV1,
  type GovernanceReportV1,
  type GovernanceSubjectV1,
} from '@ai-primitives-hub/core/dist/domain/governance/governance-v1';
import {
  parseGovernancePolicyV1,
} from '@ai-primitives-hub/infra/dist/governance/policy-v1';
import {
  validateAllSkills,
} from '../collection/generate-skill';
import {
  listCollectionFiles,
  validateAllCollections,
} from '../collection/read-collection';
import {
  validateHubConfigFile,
} from '../registry/validate-hub-config-file';

export interface GovernanceRequestV1 {
  subject: GovernanceSubjectV1;
  repoRoot: string;
  config?: string;
  policy?: string;
  collectionFiles?: string[];
  skillsDir?: string;
  minScore?: number;
}

/**
 * Load optional policy and orchestrate the subject's existing offline validator.
 * @param fs Filesystem port for configuration access.
 * @param request Consumer subject, root, input paths, and optional score threshold.
 */
export async function runGovernanceV1(fs: FileSystem, request: GovernanceRequestV1): Promise<GovernanceReportV1> {
  let policy: GovernancePolicyV1 = {};
  const findings: GovernanceFindingV1[] = [];
  const add = (ruleId: string, messages: string[], severity: 'error' | 'warning', file?: string): void => {
    findings.push(...messages.map((message) => ({ ruleId, severity, message, file })));
  };
  const resolve = (file: string): string => path.resolve(request.repoRoot, file);
  if (request.policy !== undefined) {
    try {
      const parsed = parseGovernancePolicyV1(await fs.readFile(resolve(request.policy)));
      if (!parsed.policy) {
        add('CFG001', parsed.errors, 'error', request.policy);
        return evaluateGovernanceV1(request.subject, findings);
      }
      policy = parsed.policy;
    } catch (error) {
      add('CFG001', [`Unable to read governance policy: ${error instanceof Error ? error.message : String(error)}`], 'error', request.policy);
      return evaluateGovernanceV1(request.subject, findings);
    }
  }
  try {
    switch (request.subject) {
      case 'hub': {
        const config = request.config ?? 'hub-config.yml';
        // No source adapter, HTTP client, token provider or deep option is constructed.
        const result = await validateHubConfigFile(fs, resolve(config));
        add('HUB001', result.errors, 'error', config);
        add('HUB002', result.warnings ?? [], 'warning', config);
        break;
      }
      case 'collection': {
        const files = request.collectionFiles?.length ? request.collectionFiles : listCollectionFiles(request.repoRoot);
        if (files.length === 0) {
          add('COL005', ['No collection files found. Supply --collection-file or a non-empty collections/ directory.'], 'error');
          break;
        }
        const result = validateAllCollections(request.repoRoot, files);
        findings.push(...collectionGovernanceFindingsV1(result));
        break;
      }
      case 'skill': {
        const skillsDir = request.skillsDir ?? 'skills';
        const result = validateAllSkills(request.repoRoot, skillsDir);
        if (result.totalSkills === 0) {
          add('SKL001', ['No skills found in the supplied skills directory.'], 'error', skillsDir);
        }
        for (const skill of result.skills) {
          add('SKL001', skill.errors, 'error', path.join(skillsDir, skill.folderName, 'SKILL.md'));
        }
        break;
      }
    }
  } catch (error) {
    const ruleId = request.subject === 'hub' ? 'HUB001' : (request.subject === 'collection' ? 'COL005' : 'SKL001');
    add(ruleId, [`Validation could not complete: ${error instanceof Error ? error.message : String(error)}`], 'error');
  }
  return evaluateGovernanceV1(request.subject, findings, policy, request.minScore);
}
