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
  type ValidationResult,
} from '@ai-primitives-hub/core';

/**
 * Validate an already YAML-parsed, still-untrusted hub configuration.
 * @param config - Parsed hub config candidate.
 * @returns Validation result with errors if any.
 */
export function validateHubConfig(config: any): ValidationResult {
  const errors: string[] = [];

  if (config.version) {
    if (!/^\d+\.\d+\.\d+$/.test(config.version)) {
      errors.push('version must be in semver format (e.g., 1.0.0)');
    }
  } else {
    errors.push('version is required');
  }

  if (config.metadata) {
    if (!config.metadata.name) {
      errors.push('metadata.name is required');
    }
    if (!config.metadata.description) {
      errors.push('metadata.description is required');
    }
    if (!config.metadata.maintainer) {
      errors.push('metadata.maintainer is required');
    }
    if (!config.metadata.updatedAt) {
      errors.push('metadata.updatedAt is required');
    }

    if (config.metadata.checksum && !/^(sha256|sha512):[a-f0-9]+$/.test(config.metadata.checksum)) {
      errors.push('metadata.checksum must be in format "sha256:hash" or "sha512:hash"');
    }
  } else {
    errors.push('metadata is required');
  }

  if (config.sources) {
    if (Array.isArray(config.sources)) {
      config.sources.forEach((source: any, index: number) => {
        if (source.id) {
          if (hasPathTraversal(source.id)) {
            errors.push(`source[${index}].id contains path traversal: ${source.id}`);
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

  if (config.profiles) {
    if (Array.isArray(config.profiles)) {
      const sourceIds = new Set(
        Array.isArray(config.sources) ? config.sources.map((s: any) => s.id) : []
      );

      config.profiles.forEach((profile: any, pIndex: number) => {
        if (!profile.id) {
          errors.push(`profile[${pIndex}].id is required`);
        }
        if (!profile.name) {
          errors.push(`profile[${pIndex}].name is required`);
        }

        if (profile.bundles && Array.isArray(profile.bundles)) {
          profile.bundles.forEach((bundle: any, bIndex: number) => {
            if (bundle.id && hasPathTraversal(bundle.id)) {
              errors.push(`profile[${pIndex}].bundle[${bIndex}].id contains path traversal: ${bundle.id}`);
            }

            if (bundle.source && !sourceIds.has(bundle.source)) {
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
