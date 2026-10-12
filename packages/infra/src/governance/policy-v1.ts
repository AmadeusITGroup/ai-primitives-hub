/** Parse untrusted policy YAML at the infrastructure boundary. */
import {
  GOVERNANCE_POLICY_SCHEMA_V1,
  governancePolicyErrorsV1,
  type GovernancePolicyV1,
} from '@ai-primitives-hub/core/dist/domain/governance/governance-v1';
import Ajv from 'ajv';
import * as yaml from 'js-yaml';

const validate = new Ajv({ allErrors: true, strict: true }).compile(GOVERNANCE_POLICY_SCHEMA_V1);

/**
 * Parse and validate a committed governance policy without loading remote schemas.
 * @param content Untrusted YAML document.
 */
export function parseGovernancePolicyV1(content: string): { policy?: GovernancePolicyV1; errors: string[] } {
  let document: unknown;
  try {
    document = yaml.load(content);
  } catch (error) {
    return { errors: [`Governance policy YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!validate(document)) {
    return { errors: (validate.errors ?? []).map((error) => `${error.instancePath || '$'}: ${error.message ?? 'invalid governance policy'}`) };
  }
  const policy = document as GovernancePolicyV1;
  const errors = governancePolicyErrorsV1(policy);
  return errors.length > 0 ? { errors } : { policy, errors: [] };
}
