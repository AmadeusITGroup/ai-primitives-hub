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
  deriveExpectedBundlePrefix,
  formatHubBundleId,
  hasPathTraversal,
  HUB_CONFIG_SCHEMA,
  type HubInlineDecoration,
  type HubValidationDiagnostic,
  type SourceRange,
  validateHubSourcePolicies,
  type ValidationResult,
} from '@ai-primitives-hub/core';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import {
  indexHubYamlRanges,
} from './hub-yaml-document';

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

export interface HubYamlValidationResult extends ValidationResult {
  config?: unknown;
  diagnostics: HubValidationDiagnostic[];
  inlineDecorations: HubInlineDecoration[];
  nodeRanges: Map<string, SourceRange>;
}

/**
 * Parse and validate raw `hub-config.yml` text, returning line-mapped
 * `HubValidationDiagnostic` entries (with optional `quickFix` payloads) and
 * inline editor decorations.
 * @param content Raw YAML document string.
 * @returns Structured validation result with diagnostics, ranges, and decorations.
 */
export function validateHubConfigYaml(content: string): HubYamlValidationResult {
  const nodeRanges = indexHubYamlRanges(content);
  const lines = content.split(/\r?\n/);

  let config: unknown;
  try {
    config = parseHubConfigYaml(content);
  } catch (error) {
    const yamlErr = error as yaml.YAMLException;
    const errLine = typeof yamlErr?.mark?.line === 'number'
      ? Math.min(Math.max(0, yamlErr.mark.line), Math.max(0, lines.length - 1))
      : 0;
    const errCol = typeof yamlErr?.mark?.column === 'number' ? Math.max(0, yamlErr.mark.column) : 0;
    const lineText = lines[errLine] ?? '';
    const message = `YAML syntax error: ${error instanceof Error ? error.message : String(error)}`;
    return {
      valid: false,
      errors: [message],
      warnings: [],
      diagnostics: [
        {
          code: 'HUB_YAML_SYNTAX_ERROR',
          severity: 'error',
          message,
          jsonPath: [],
          range: {
            startLine: errLine,
            startColumn: errCol,
            endLine: errLine,
            endColumn: Math.max(errCol + 1, lineText.length)
          }
        }
      ],
      inlineDecorations: [],
      nodeRanges
    };
  }

  const docResult = validateHubConfigDocument(config);
  const diagnostics: HubValidationDiagnostic[] = [];
  const inlineDecorations: HubInlineDecoration[] = [];

  const resolveRange = (pathSegments: (string | number)[]): SourceRange | undefined => {
    for (let len = pathSegments.length; len >= 0; len--) {
      const candidate = pathSegments.slice(0, len).join('.');
      const found = nodeRanges.get(candidate);
      if (found) {
        return found;
      }
    }
    return nodeRanges.get('');
  };

  const root = asRecord(config);
  if (!root) {
    diagnostics.push({
      code: 'HUB_SCHEMA_VIOLATION',
      severity: 'error',
      message: 'Hub configuration root must be a mapping.',
      jsonPath: [],
      range: resolveRange([])
    });
    return {
      ...docResult,
      config,
      diagnostics,
      inlineDecorations,
      nodeRanges
    };
  }

  // 1. Version & Metadata checks
  if (!root.version) {
    diagnostics.push({
      code: 'HUB_MISSING_REQUIRED_FIELD',
      severity: 'error',
      message: 'version is required',
      jsonPath: ['version'],
      range: resolveRange(['version'])
    });
  } else if (typeof root.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(root.version)) {
    diagnostics.push({
      code: 'HUB_INVALID_SEMVER',
      severity: 'error',
      message: 'version must be in semver format (e.g., 1.0.0)',
      jsonPath: ['version'],
      range: resolveRange(['version'])
    });
  }

  const metadata = asRecord(root.metadata);
  if (metadata === undefined) {
    diagnostics.push({
      code: 'HUB_MISSING_REQUIRED_FIELD',
      severity: 'error',
      message: 'metadata is required',
      jsonPath: ['metadata'],
      range: resolveRange(['metadata'])
    });
  } else {
    for (const field of ['name', 'description', 'maintainer', 'updatedAt'] as const) {
      if (!metadata[field]) {
        diagnostics.push({
          code: 'HUB_MISSING_REQUIRED_FIELD',
          severity: 'error',
          message: `metadata.${field} is required`,
          jsonPath: ['metadata', field],
          range: resolveRange(['metadata', field]),
          ...(field === 'updatedAt'
            ? {
              quickFix: {
                title: 'Set metadata.updatedAt to current ISO timestamp',
                kind: 'update-timestamp',
                jsonPath: ['metadata', 'updatedAt']
              }
            }
            : {})
        });
      }
    }

    const updatedAtRange = nodeRanges.get('metadata.updatedAt');
    if (updatedAtRange && typeof metadata.updatedAt === 'string') {
      inlineDecorations.push({
        line: updatedAtRange.startLine,
        text: `Last updated: ${metadata.updatedAt}`,
        status: 'info',
        jsonPath: ['metadata', 'updatedAt']
      });
    }
  }

  // 2. Sources checks + inline decorations
  const sourcesMap = new Map<string, { index: number; source: Record<string, unknown> }>();
  if (Array.isArray(root.sources)) {
    root.sources.forEach((sourceVal, sIdx) => {
      const source = asRecord(sourceVal);
      if (!source) {
        return;
      }
      const sourceId = typeof source.id === 'string' ? source.id : undefined;
      const sourceType = typeof source.type === 'string' ? source.type : undefined;

      if (sourceId) {
        if (containsPathTraversal(sourceId)) {
          diagnostics.push({
            code: 'HUB_PATH_TRAVERSAL',
            severity: 'error',
            message: `source[${sIdx}].id contains path traversal: ${sourceId}`,
            jsonPath: ['sources', sIdx, 'id'],
            range: resolveRange(['sources', sIdx, 'id'])
          });
        }
        const prev = sourcesMap.get(sourceId);
        if (prev === undefined) {
          sourcesMap.set(sourceId, { index: sIdx, source });
        } else {
          diagnostics.push({
            code: 'HUB_DUPLICATE_SOURCE_ID',
            severity: 'error',
            message: `Duplicate source ID '${sourceId}' at source[${sIdx}] (also at source[${prev.index}])`,
            jsonPath: ['sources', sIdx, 'id'],
            range: resolveRange(['sources', sIdx, 'id'])
          });
        }
      } else {
        diagnostics.push({
          code: 'HUB_MISSING_REQUIRED_FIELD',
          severity: 'error',
          message: `source[${sIdx}].id is required`,
          jsonPath: ['sources', sIdx, 'id'],
          range: resolveRange(['sources', sIdx, 'id'])
        });
      }

      if (!sourceType) {
        diagnostics.push({
          code: 'HUB_MISSING_REQUIRED_FIELD',
          severity: 'error',
          message: `source[${sIdx}].type is required`,
          jsonPath: ['sources', sIdx, 'type'],
          range: resolveRange(['sources', sIdx, 'type'])
        });
      }

      const hasConfig = Object.prototype.hasOwnProperty.call(source, 'config');
      if (sourceType === 'github' && hasConfig) {
        diagnostics.push({
          code: 'HUB_SOURCE_FORBIDDEN_CONFIG',
          severity: 'error',
          message: `Source '${sourceId ?? `#${sIdx + 1}`}' has type 'github' and must not define 'config'.`,
          jsonPath: ['sources', sIdx, 'config'],
          range: resolveRange(['sources', sIdx, 'config']),
          quickFix: {
            title: `Remove forbidden 'config' block from github source '${sourceId ?? `#${sIdx + 1}`}'`,
            kind: 'remove-source-config',
            jsonPath: ['sources', sIdx, 'config']
          }
        });
      } else if (sourceType === 'awesome-copilot' && !hasConfig) {
        diagnostics.push({
          code: 'HUB_SOURCE_REQUIRED_CONFIG',
          severity: 'error',
          message: `Source '${sourceId ?? `#${sIdx + 1}`}' has type 'awesome-copilot' and must define 'config'.`,
          jsonPath: ['sources', sIdx],
          range: resolveRange(['sources', sIdx]),
          quickFix: {
            title: `Add default 'config' block to awesome-copilot source '${sourceId ?? `#${sIdx + 1}`}'`,
            kind: 'add-source-config',
            jsonPath: ['sources', sIdx, 'config'],
            replacementValue: { branch: 'main', collectionsPath: 'collections' }
          }
        });
      }

      const srcRange = nodeRanges.get(`sources.${sIdx}`);
      if (srcRange && sourceId) {
        const prefixHint = deriveExpectedBundlePrefix({
          type: sourceType,
          url: typeof source.url === 'string' ? source.url : undefined,
          repository: typeof source.repository === 'string' ? source.repository : undefined
        });
        const enabledLabel = source.enabled === false ? 'disabled' : 'enabled';
        const priorityLabel = typeof source.priority === 'number' ? `priority ${source.priority}` : 'no priority';
        inlineDecorations.push({
          line: srcRange.startLine,
          text: `${sourceType ?? 'unknown'} • ${enabledLabel} • ${priorityLabel}${prefixHint ? ` • prefix: ${prefixHint}*` : ''}`,
          status: source.enabled === false ? 'warning' : 'ok',
          jsonPath: ['sources', sIdx]
        });
      }
    });
  }

  // 3. Profiles & Bundles checks + inline decorations
  const profileIds = new Map<string, number>();
  if (Array.isArray(root.profiles)) {
    root.profiles.forEach((profileVal, pIdx) => {
      const profile = asRecord(profileVal);
      if (!profile) {
        return;
      }
      const profileId = typeof profile.id === 'string' ? profile.id : undefined;
      if (profileId) {
        const prev = profileIds.get(profileId);
        if (prev === undefined) {
          profileIds.set(profileId, pIdx);
        } else {
          diagnostics.push({
            code: 'HUB_DUPLICATE_PROFILE_ID',
            severity: 'error',
            message: `Duplicate profile ID '${profileId}' at profile[${pIdx}] (also at profile[${prev}])`,
            jsonPath: ['profiles', pIdx, 'id'],
            range: resolveRange(['profiles', pIdx, 'id'])
          });
        }
      } else {
        diagnostics.push({
          code: 'HUB_MISSING_REQUIRED_FIELD',
          severity: 'error',
          message: `profile[${pIdx}].id is required`,
          jsonPath: ['profiles', pIdx, 'id'],
          range: resolveRange(['profiles', pIdx, 'id'])
        });
      }

      const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
      let profileHasError = false;

      bundles.forEach((bundleVal, bIdx) => {
        const bundle = asRecord(bundleVal);
        if (!bundle) {
          return;
        }
        const bundleId = typeof bundle.id === 'string' ? bundle.id : '';
        const sourceId = typeof bundle.source === 'string' ? bundle.source : '';

        if (bundleId && containsPathTraversal(bundleId)) {
          profileHasError = true;
          diagnostics.push({
            code: 'HUB_PATH_TRAVERSAL',
            severity: 'error',
            message: `profile[${pIdx}].bundle[${bIdx}].id contains path traversal: ${bundleId}`,
            jsonPath: ['profiles', pIdx, 'bundles', bIdx, 'id'],
            range: resolveRange(['profiles', pIdx, 'bundles', bIdx, 'id'])
          });
        }

        if (sourceId && !sourcesMap.has(sourceId)) {
          profileHasError = true;
          diagnostics.push({
            code: 'HUB_UNKNOWN_SOURCE_REFERENCE',
            severity: 'error',
            message: `profile[${pIdx}].bundle[${bIdx}] references non-existent source: ${sourceId}`,
            jsonPath: ['profiles', pIdx, 'bundles', bIdx, 'source'],
            range: resolveRange(['profiles', pIdx, 'bundles', bIdx, 'source']),
            quickFix: {
              title: `Create source '${sourceId}' in sources list`,
              kind: 'create-missing-source',
              jsonPath: ['sources'],
              replacementValue: sourceId
            }
          });
        } else if (sourceId && sourcesMap.has(sourceId)) {
          const targetSource = sourcesMap.get(sourceId)!.source;
          const expectedPrefix = deriveExpectedBundlePrefix({
            type: typeof targetSource.type === 'string' ? targetSource.type : undefined,
            url: typeof targetSource.url === 'string' ? targetSource.url : undefined,
            repository: typeof targetSource.repository === 'string' ? targetSource.repository : undefined
          });
          if (expectedPrefix && (!bundleId || !bundleId.toLowerCase().startsWith(expectedPrefix.toLowerCase()))) {
            profileHasError = true;
            const sourceKindLabel = targetSource.type === 'skills' ? 'skills' : 'GitHub';
            const fixedId = formatHubBundleId(
              {
                type: typeof targetSource.type === 'string' ? targetSource.type : undefined,
                url: typeof targetSource.url === 'string' ? targetSource.url : undefined,
                repository: typeof targetSource.repository === 'string' ? targetSource.repository : undefined
              },
              bundleId || 'bundle'
            );
            diagnostics.push({
              code: 'HUB_INVALID_BUNDLE_PREFIX',
              severity: 'error',
              message: `Profile '${profileId ?? `#${pIdx + 1}`}' bundle #${bIdx + 1} must reference ${sourceKindLabel} source '${sourceId}' with an ID starting '${expectedPrefix}'.`,
              jsonPath: ['profiles', pIdx, 'bundles', bIdx, 'id'],
              range: resolveRange(['profiles', pIdx, 'bundles', bIdx, 'id']),
              quickFix: {
                title: `Prefix bundle ID as '${fixedId}'`,
                kind: 'fix-bundle-prefix',
                jsonPath: ['profiles', pIdx, 'bundles', bIdx, 'id'],
                replacementValue: fixedId
              }
            });
          }
        }
      });

      const profRange = nodeRanges.get(`profiles.${pIdx}`);
      if (profRange && profileId) {
        const pathLabel = Array.isArray(profile.path) && profile.path.length > 0
          ? profile.path.join(' / ')
          : 'Uncategorized';
        inlineDecorations.push({
          line: profRange.startLine,
          text: `${pathLabel} • ${bundles.length} bundle(s)`,
          status: profileHasError ? 'error' : 'ok',
          jsonPath: ['profiles', pIdx]
        });
      }
    });
  }

  // 4. Add any remaining schema/policy errors not already represented at the same path/message
  if (!docResult.valid) {
    const existingMessages = new Set(diagnostics.map((d) => d.message));
    const existingPaths = new Set(diagnostics.map((d) => d.jsonPath.join('.')));

    for (const err of (validateSchema.errors ?? [])) {
      const segments = (err.instancePath || '')
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
      const params = err.params as Record<string, unknown>;
      if (err.keyword === 'required' && typeof params?.missingProperty === 'string') {
        segments.push(params.missingProperty);
        if (existingPaths.has(segments.join('.'))) {
          continue;
        }
      }
      const formatted = `${err.instancePath || '$'}: ${
        err.keyword === 'required'
          ? `missing required property '${String(params.missingProperty)}'`
          : (err.message ?? 'validation failed')
      }`;
      if (!existingMessages.has(formatted)) {
        existingMessages.add(formatted);
        existingPaths.add(segments.join('.'));
        diagnostics.push({
          code: 'HUB_SCHEMA_VIOLATION',
          severity: 'error',
          message: formatted,
          jsonPath: segments,
          range: resolveRange(segments)
        });
      }
    }

    for (const docErr of docResult.errors) {
      if (!existingMessages.has(docErr)) {
        existingMessages.add(docErr);
        diagnostics.push({
          code: 'HUB_SCHEMA_VIOLATION',
          severity: 'error',
          message: docErr,
          jsonPath: [],
          range: resolveRange([])
        });
      }
    }
  }

  return {
    ...docResult,
    valid: docResult.valid && !diagnostics.some((d) => d.severity === 'error'),
    config,
    diagnostics,
    inlineDecorations,
    nodeRanges
  };
}
