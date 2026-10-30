/**
 * Parse an untrusted `hub-governance.yml` at the infrastructure boundary (CFG001).
 * Semantic checks (CFG002-CFG004) run in core when the policy is evaluated.
 * @module governance/governance-config
 */
import {
  type GovernanceFinding,
  type GovernancePolicy,
  HUB_GOVERNANCE_SCHEMA,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  AjvSchemaValidator,
} from './ajv-schema-validator';

const validator = new AjvSchemaValidator({ strict: true });

export interface ParsedGovernanceConfig {
  policy?: GovernancePolicy;
  findings: GovernanceFinding[];
}

/**
 * Parse and schema-validate a governance configuration without loading remote schemas.
 * @param content Untrusted YAML document.
 * @param file Display path of the configuration file.
 */
export function parseGovernanceConfig(content: string, file?: string): ParsedGovernanceConfig {
  const error = (message: string): ParsedGovernanceConfig => ({ findings: [{ ruleId: 'CFG001', severity: 'error', message, file }] });
  let document: unknown;
  try {
    // An empty file is a valid "all defaults" configuration.
    document = yaml.load(content) ?? {};
  } catch (cause) {
    return error(`Governance configuration YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const outcome = validator.validate(HUB_GOVERNANCE_SCHEMA, document);
  if (!outcome.valid) {
    return { findings: outcome.issues.map((issue) => ({
      ruleId: 'CFG001', severity: 'error' as const, file,
      message: `${issue.instancePath || '$'}: ${issue.message}`
    })) };
  }
  return { policy: document as GovernancePolicy, findings: [] };
}
