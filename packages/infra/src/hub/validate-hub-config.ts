/**
 * Runtime validation for untrusted, just-parsed `HubConfig` YAML.
 *
 * Ported verbatim from the extension's `src/types/hub.ts`
 * `validateHubConfig`. Deliberately lives in `infra` rather than
 * `core`'s pure domain layer, per the design note on
 * `core/src/domain/hub/validate.ts`: this kind of "parse, don't
 * validate blindly" boundary check belongs next to wherever the
 * untrusted YAML is actually parsed.
 * @module hub/validate-hub-config
 */
import {
  hasPathTraversal,
  HUB_CONFIG_SCHEMA,
  validateHubSourcePolicies,
  type ValidationResult,
} from '@ai-primitives-hub/core';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';

const ajv = new Ajv({
  allErrors: true,
  strict: false
});
addFormats(ajv);
const validateSchema = ajv.compile(HUB_CONFIG_SCHEMA);

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const containsPathTraversal = (value: string): boolean => {
  try {
    return hasPathTraversal(value);
  } catch {
    return true;
  }
};

const formatSchemaErrors = (): string[] => {
  return (validateSchema.errors ?? []).map((error) => {
    const dataPath = error.instancePath || '$';
    const params = error.params as Record<string, unknown>;

    switch (error.keyword) {
      case 'required': {
        return `${dataPath}: missing required property '${String(params.missingProperty)}'`;
      }
      case 'pattern': {
        return `${dataPath}: ${error.message ?? 'must match the required pattern'}`;
      }
      case 'enum': {
        return `${dataPath}: ${error.message ?? 'must be an allowed value'}`;
      }
      case 'format': {
        return `${dataPath}: ${error.message ?? 'must use the required format'}`;
      }
      case 'minLength':
      case 'maxLength':
      case 'minItems':
      case 'maxItems':
      case 'minimum':
      case 'maximum':
      case 'type': {
        return `${dataPath}: ${error.message ?? 'has an invalid value'}`;
      }
      default: {
        return `${dataPath}: ${error.message ?? 'validation failed'}`;
      }
    }
  });
};

/**
 * Parse a hub YAML document without applying any defaults or transformations.
 * @param content Raw YAML content.
 * @returns Parsed YAML value.
 */
export function parseHubConfigYaml(content: string): unknown {
  return yaml.load(content);
}

/**
 * Validate an already YAML-parsed, still-untrusted hub configuration.
 * @param config - Parsed hub config candidate.
 * @returns Validation result with errors if any.
 */
export function validateHubConfig(config: unknown): ValidationResult {
  const errors: string[] = [];

  const root = asRecord(config);
  if (root === undefined) {
    return {
      valid: false,
      errors: ['Hub configuration root must be a mapping.']
    };
  }

  if (root.version) {
    if (typeof root.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(root.version)) {
      errors.push('version must be in semver format (e.g., 1.0.0)');
    }
  } else {
    errors.push('version is required');
  }

  const metadata = asRecord(root.metadata);
  if (metadata === undefined) {
    errors.push('metadata is required');
  } else {
    if (!metadata.name) {
      errors.push('metadata.name is required');
    }
    if (!metadata.description) {
      errors.push('metadata.description is required');
    }
    if (!metadata.maintainer) {
      errors.push('metadata.maintainer is required');
    }
    if (!metadata.updatedAt) {
      errors.push('metadata.updatedAt is required');
    }

    if (metadata.checksum && (typeof metadata.checksum !== 'string'
      || !/^(sha256|sha512):[a-f0-9]+$/.test(metadata.checksum))) {
      errors.push('metadata.checksum must be in format "sha256:hash" or "sha512:hash"');
    }
  }

  const sources = root.sources;
  const sourceIds = new Map<string, number>();
  if (sources) {
    if (Array.isArray(sources)) {
      sources.forEach((sourceValue, index) => {
        const source = asRecord(sourceValue);
        if (source === undefined) {
          errors.push(`source[${index}] must be a mapping`);
          return;
        }

        if (source.id) {
          if (typeof source.id === 'string' && containsPathTraversal(source.id)) {
            errors.push(`source[${index}].id contains path traversal: ${source.id}`);
          }
          if (typeof source.id === 'string') {
            const previousIndex = sourceIds.get(source.id);
            if (previousIndex === undefined) {
              sourceIds.set(source.id, index);
            } else {
              errors.push(
                `Duplicate source ID '${source.id}' at source[${index}] (also at source[${previousIndex}])`
              );
            }
          }
        } else {
          errors.push(`source[${index}].id is required`);
        }
        if (!source.type) {
          errors.push(`source[${index}].type is required`);
        }
      });
    } else {
      errors.push('sources must be an array');
    }
  } else {
    errors.push('sources is required');
  }

  const profiles = root.profiles;
  if (profiles) {
    if (Array.isArray(profiles)) {
      const profileIds = new Map<string, number>();
      const sourceIdSet = new Set(sourceIds.keys());

      profiles.forEach((profileValue, pIndex) => {
        const profile = asRecord(profileValue);
        if (profile === undefined) {
          errors.push(`profile[${pIndex}] must be a mapping`);
          return;
        }

        if (!profile.id) {
          errors.push(`profile[${pIndex}].id is required`);
        } else if (typeof profile.id === 'string') {
          const previousIndex = profileIds.get(profile.id);
          if (previousIndex === undefined) {
            profileIds.set(profile.id, pIndex);
          } else {
            errors.push(
              `Duplicate profile ID '${profile.id}' at profile[${pIndex}] (also at profile[${previousIndex}])`
            );
          }
        }
        if (!profile.name) {
          errors.push(`profile[${pIndex}].name is required`);
        }

        if (profile.bundles && Array.isArray(profile.bundles)) {
          profile.bundles.forEach((bundleValue, bIndex) => {
            const bundle = asRecord(bundleValue);
            if (bundle === undefined) {
              return;
            }

            if (bundle.id && typeof bundle.id === 'string' && containsPathTraversal(bundle.id)) {
              errors.push(`profile[${pIndex}].bundle[${bIndex}].id contains path traversal: ${bundle.id}`);
            }

            if (bundle.source && typeof bundle.source === 'string' && !sourceIdSet.has(bundle.source)) {
              errors.push(`profile[${pIndex}].bundle[${bIndex}] references non-existent source: ${bundle.source}`);
            }
          });
        }
      });
    } else {
      errors.push('profiles must be an array');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate a parsed hub document with every offline validator used by the
 * hub repository: runtime safety checks, JSON Schema, and source policies.
 * @param config Parsed hub configuration.
 * @returns Combined validation result with de-duplicated errors.
 */
export function validateHubConfigDocument(config: unknown): ValidationResult {
  const runtimeResult = validateHubConfig(config);
  const schemaValid = validateSchema(config);
  const schemaErrors = schemaValid ? [] : formatSchemaErrors();
  const policyErrors = validateHubSourcePolicies(config);
  const errors = [...new Set([
    ...runtimeResult.errors,
    ...schemaErrors,
    ...policyErrors
  ])];

  return {
    valid: errors.length === 0,
    errors,
    warnings: runtimeResult.warnings ?? []
  };
}
