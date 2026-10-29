/**
 * Range-mapped validator for `.collection.yml` manifests.
 *
 * Combines YAML syntax parsing, AJV `COLLECTION_SCHEMA` validation, domain
 * rules (`validateCollectionId`, `validateVersion`, `validateItemKind`,
 * `isSafeRepoRelativePath`), kind-route mismatch checks, referenced file
 * existence checks, Agent Plugins 1.0.0 manifest validation, and
 * cross-collection duplicate `id`/`name` checks into structured
 * `CollectionValidationDiagnostic[]` and `CollectionInlineDecoration[]`.
 * @module collection/validate-collection-yaml
 */
import {
  COLLECTION_SCHEMA,
  type CollectionInlineDecoration,
  type CollectionManifest,
  type CollectionValidationDiagnostic,
  DEFAULT_VALIDATION_RULES,
  findKindRouteMismatch,
  formatKindRouteMismatch,
  generateSanitizedId,
  isSafeRepoRelativePath,
  type KindRoutes,
  normalizePrimitiveKind,
  normalizeRepoRelativePath,
  type SourceRange,
  validateAgentPluginItem,
  validateCollectionId,
  validateItemKind,
  validateVersion,
} from '@ai-primitives-hub/core';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import {
  defaultLayouts,
} from '../writers/default-layouts';
import {
  indexCollectionYamlRanges,
} from './collection-yaml-document';

const BUILT_IN_ROUTES: KindRoutes = Object.fromEntries(
  Object.values(defaultLayouts.layouts).flatMap((layout) =>
    [layout.user, layout.repository].flatMap((scoped) => Object.entries(scoped?.kindRoutes ?? {})))
);

const ajv = new Ajv({
  allErrors: true,
  strict: false
});
addFormats(ajv);
const validateSchema = ajv.compile(COLLECTION_SCHEMA);

export interface SiblingCollectionSummary {
  file: string;
  id?: string;
  name?: string;
}

export interface CollectionFileProbeResult {
  exists: boolean;
  isFile?: boolean;
  content?: string;
}

export interface ValidateCollectionYamlOptions {
  /** Relative file label used in diagnostic messages (e.g. `collections/my.collection.yml`). */
  fileLabel?: string;
  /** Optional file probe callback to check referenced `items[].path`, `readme.path`, and `plugin.json`. */
  checkFile?: (relPath: string) => CollectionFileProbeResult;
  /** Optional sibling collections in the workspace for duplicate `id` and `name` detection. */
  siblingCollections?: SiblingCollectionSummary[];
  /** Optional layout `kindRoutes` override (defaults to `DEFAULT_LAYOUTS.copilot.kindRoutes`). */
  kindRoutes?: KindRoutes;
}

export interface CollectionYamlValidationResult {
  config: unknown;
  manifest?: CollectionManifest;
  valid: boolean;
  errors: string[];
  warnings: string[];
  diagnostics: CollectionValidationDiagnostic[];
  inlineDecorations: CollectionInlineDecoration[];
  nodeRanges: Map<string, SourceRange>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const lookupRange = (
  ranges: Map<string, SourceRange>,
  jsonPath: (string | number)[]
): SourceRange | undefined => {
  for (let len = jsonPath.length; len >= 1; len--) {
    const key = jsonPath.slice(0, len).join('.');
    const found = ranges.get(key);
    if (found) {
      return found;
    }
  }
  return ranges.get('');
};

/**
 * Validate a raw `.collection.yml` YAML string and produce range-mapped
 * diagnostics, quick fixes, and inline editor decorations.
 * @param content Raw YAML document string.
 * @param options Optional file-existence and cross-collection context.
 * @returns Structured validation result.
 */
export function validateCollectionYaml(
  content: string,
  options: ValidateCollectionYamlOptions = {}
): CollectionYamlValidationResult {
  const fileLabel = options.fileLabel ?? 'collection.yml';
  const nodeRanges = indexCollectionYamlRanges(content);
  const diagnostics: CollectionValidationDiagnostic[] = [];
  const inlineDecorations: CollectionInlineDecoration[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  const pushDiagnostic = (diag: CollectionValidationDiagnostic): void => {
    const range = diag.range ?? lookupRange(nodeRanges, diag.jsonPath);
    const enriched: CollectionValidationDiagnostic = { ...diag, range };
    diagnostics.push(enriched);
    if (diag.severity === 'error') {
      errors.push(`${fileLabel}: ${diag.message}`);
    } else if (diag.severity === 'warning') {
      warnings.push(`${fileLabel}: ${diag.message}`);
    }
  };

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    const yamlErr = err as yaml.YAMLException;
    const line = typeof yamlErr.mark?.line === 'number' ? yamlErr.mark.line : 0;
    const col = typeof yamlErr.mark?.column === 'number' ? yamlErr.mark.column : 0;
    const message = `YAML syntax error: ${yamlErr.reason || yamlErr.message}`;
    pushDiagnostic({
      code: 'COLLECTION_YAML_SYNTAX_ERROR',
      severity: 'error',
      message,
      jsonPath: [],
      range: {
        startLine: line,
        startColumn: col,
        endLine: line,
        endColumn: col + 1
      }
    });
    return {
      config: undefined,
      manifest: undefined,
      valid: false,
      errors,
      warnings,
      diagnostics,
      inlineDecorations,
      nodeRanges
    };
  }

  const root = asRecord(parsed);
  if (!root) {
    pushDiagnostic({
      code: 'COLLECTION_MISSING_REQUIRED_FIELD',
      severity: 'error',
      message: 'YAML did not parse to an object',
      jsonPath: []
    });
    return {
      config: parsed,
      manifest: undefined,
      valid: false,
      errors,
      warnings,
      diagnostics,
      inlineDecorations,
      nodeRanges
    };
  }

  // 1. Required fields & domain field checks
  if (!root.id || typeof root.id !== 'string') {
    pushDiagnostic({
      code: 'COLLECTION_MISSING_REQUIRED_FIELD',
      severity: 'error',
      message: 'Missing required field: id',
      jsonPath: ['id'],
      quickFix: {
        title: 'Generate valid collection ID',
        kind: 'sanitize-collection-id',
        jsonPath: ['id'],
        replacementValue: generateSanitizedId(typeof root.name === 'string' ? root.name : 'my-collection')
      }
    });
  } else {
    const idCheck = validateCollectionId(root.id);
    if (!idCheck.valid) {
      const sanitized = generateSanitizedId(root.id) || 'my-collection';
      pushDiagnostic({
        code: 'COLLECTION_INVALID_ID',
        severity: 'error',
        message: idCheck.error ?? 'Invalid collection ID',
        jsonPath: ['id'],
        quickFix: {
          title: `Sanitize ID to '${sanitized}'`,
          kind: 'sanitize-collection-id',
          jsonPath: ['id'],
          replacementValue: sanitized
        }
      });
    }
  }

  if (!root.name || typeof root.name !== 'string' || root.name.trim().length === 0) {
    pushDiagnostic({
      code: 'COLLECTION_MISSING_REQUIRED_FIELD',
      severity: 'error',
      message: 'Missing required field: name',
      jsonPath: ['name']
    });
  }

  if (!root.description || typeof root.description !== 'string' || root.description.trim().length === 0) {
    pushDiagnostic({
      code: 'COLLECTION_MISSING_REQUIRED_FIELD',
      severity: 'error',
      message: 'Missing required field: description',
      jsonPath: ['description']
    });
  }

  if (root.version !== undefined) {
    const verCheck = validateVersion(root.version as string);
    if (!verCheck.valid) {
      pushDiagnostic({
        code: 'COLLECTION_INVALID_VERSION',
        severity: 'error',
        message: verCheck.error ?? 'Invalid version format',
        jsonPath: ['version'],
        quickFix: {
          title: `Reset version to '${DEFAULT_VALIDATION_RULES.version.default}'`,
          kind: 'fix-version',
          jsonPath: ['version'],
          replacementValue: DEFAULT_VALIDATION_RULES.version.default
        }
      });
    }
  }

  // 2. Cross-collection duplicate ID & Name checks
  if (options.siblingCollections && options.siblingCollections.length > 0) {
    for (const sibling of options.siblingCollections) {
      if (sibling.file === fileLabel) {
        continue;
      }
      if (typeof root.id === 'string' && root.id.length > 0 && sibling.id === root.id) {
        pushDiagnostic({
          code: 'COLLECTION_DUPLICATE_ID',
          severity: 'error',
          message: `Duplicate collection ID '${root.id}' (also in ${sibling.file})`,
          jsonPath: ['id']
        });
      }
      if (typeof root.name === 'string' && root.name.length > 0 && sibling.name === root.name) {
        pushDiagnostic({
          code: 'COLLECTION_DUPLICATE_NAME',
          severity: 'error',
          message: `Duplicate collection name '${root.name}' (also in ${sibling.file})`,
          jsonPath: ['name']
        });
      }
    }
  }

  // 3. Tags validation
  if (root.tags !== undefined && Array.isArray(root.tags)) {
    if (root.tags.length > 10) {
      pushDiagnostic({
        code: 'COLLECTION_TAG_WARNING',
        severity: 'warning',
        message: 'More than 10 tags (recommended maximum is 10)',
        jsonPath: ['tags']
      });
    }
    root.tags.forEach((tag, idx) => {
      if (typeof tag === 'string' && tag.length > 30) {
        pushDiagnostic({
          code: 'COLLECTION_TAG_WARNING',
          severity: 'warning',
          message: `Tag '${tag}' is longer than 30 characters`,
          jsonPath: ['tags', idx]
        });
      }
    });
  }

  // 4. README checks
  if (root.readme === undefined) {
    const idForReadme = typeof root.id === 'string' && root.id ? root.id : 'collection';
    pushDiagnostic({
      code: 'COLLECTION_README_MISSING',
      severity: 'warning',
      message: 'Collection has no readme. Consider adding a readme to help users understand this collection.',
      jsonPath: ['id'],
      quickFix: {
        title: 'Add README.md to collection',
        kind: 'scaffold-missing-readme',
        jsonPath: ['readme', 'path'],
        filePath: `docs/${idForReadme}/README.md`
      }
    });
  } else {
    const readmeRec = asRecord(root.readme);
    if (!readmeRec || typeof readmeRec.path !== 'string' || readmeRec.path.trim().length === 0) {
      pushDiagnostic({
        code: 'COLLECTION_INVALID_PATH',
        severity: 'error',
        message: 'readme.path must be a non-empty string',
        jsonPath: ['readme', 'path']
      });
    } else if (!isSafeRepoRelativePath(readmeRec.path)) {
      pushDiagnostic({
        code: 'COLLECTION_INVALID_PATH',
        severity: 'error',
        message: `readme.path has an invalid path (must be repo-root relative): ${readmeRec.path}`,
        jsonPath: ['readme', 'path']
      });
    } else if (options.checkFile) {
      const normalizedReadme = normalizeRepoRelativePath(readmeRec.path);
      const probe = options.checkFile(normalizedReadme);
      const readmeRange = nodeRanges.get('readme.path') ?? nodeRanges.get('readme');
      if (!probe.exists) {
        pushDiagnostic({
          code: 'COLLECTION_README_FILE_NOT_FOUND',
          severity: 'error',
          message: `readme referenced file not found: ${normalizedReadme}`,
          jsonPath: ['readme', 'path'],
          quickFix: {
            title: `Create missing README '${normalizedReadme}'`,
            kind: 'scaffold-missing-readme',
            jsonPath: ['readme', 'path'],
            filePath: normalizedReadme
          }
        });
        if (readmeRange) {
          inlineDecorations.push({
            line: readmeRange.startLine,
            text: `✗ missing README (${normalizedReadme})`,
            status: 'error',
            jsonPath: ['readme', 'path']
          });
        }
      } else if (readmeRange) {
        inlineDecorations.push({
          line: readmeRange.startLine,
          text: `✓ README exists (${normalizedReadme})`,
          status: 'ok',
          jsonPath: ['readme', 'path']
        });
      }
    }
  }

  // 5. Items validation
  const kindRoutes = options.kindRoutes ?? BUILT_IN_ROUTES;
  if (Array.isArray(root.items)) {
    const seenPaths = new Map<string, number>();

    root.items.forEach((rawItem, idx) => {
      const itemRec = asRecord(rawItem);
      if (!itemRec) {
        pushDiagnostic({
          code: 'COLLECTION_SCHEMA_VIOLATION',
          severity: 'error',
          message: `items[${idx}]: must be an object`,
          jsonPath: ['items', idx]
        });
        return;
      }

      let normalizedPath: string | undefined;
      if (!itemRec.path || typeof itemRec.path !== 'string') {
        pushDiagnostic({
          code: 'COLLECTION_MISSING_REQUIRED_FIELD',
          severity: 'error',
          message: `items[${idx}]: Missing required field: path`,
          jsonPath: ['items', idx, 'path']
        });
      } else {
        try {
          normalizedPath = normalizeRepoRelativePath(itemRec.path);
          const prevIdx = seenPaths.get(normalizedPath);
          if (prevIdx === undefined) {
            seenPaths.set(normalizedPath, idx);
          } else {
            pushDiagnostic({
              code: 'COLLECTION_DUPLICATE_ITEM_PATH',
              severity: 'warning',
              message: `items[${idx}]: Duplicate item path '${normalizedPath}' (also at items[${prevIdx}])`,
              jsonPath: ['items', idx, 'path']
            });
          }
        } catch {
          pushDiagnostic({
            code: 'COLLECTION_INVALID_PATH',
            severity: 'error',
            message: `items[${idx}]: Invalid path (must be repo-root relative): ${itemRec.path}`,
            jsonPath: ['items', idx, 'path']
          });
        }
      }

      let validKind = false;
      if (!itemRec.kind || typeof itemRec.kind !== 'string') {
        pushDiagnostic({
          code: 'COLLECTION_MISSING_REQUIRED_FIELD',
          severity: 'error',
          message: `items[${idx}]: Missing required field: kind`,
          jsonPath: ['items', idx, 'kind']
        });
      } else {
        const kindRes = validateItemKind(itemRec.kind);
        if (kindRes.valid) {
          validKind = true;
        } else {
          pushDiagnostic({
            code: kindRes.deprecated ? 'COLLECTION_DEPRECATED_ITEM_KIND' : 'COLLECTION_INVALID_ITEM_KIND',
            severity: 'error',
            message: `items[${idx}]: ${kindRes.error}`,
            jsonPath: ['items', idx, 'kind'],
            ...(kindRes.deprecated && kindRes.replacement
              ? {
                quickFix: {
                  title: `Replace deprecated kind '${itemRec.kind}' with '${kindRes.replacement}'`,
                  kind: 'fix-deprecated-kind',
                  jsonPath: ['items', idx, 'kind'],
                  replacementValue: kindRes.replacement
                }
              }
              : {})
          });
        }
      }

      const itemLineRange = nodeRanges.get(`items.${idx}.path`) ?? nodeRanges.get(`items.${idx}`);
      if (normalizedPath && validKind && typeof itemRec.kind === 'string') {
        const canonicalKind = normalizePrimitiveKind(itemRec.kind);
        const mismatch = canonicalKind
          ? findKindRouteMismatch(normalizedPath, canonicalKind, kindRoutes)
          : null;

        if (mismatch) {
          pushDiagnostic({
            code: 'COLLECTION_KIND_ROUTE_MISMATCH',
            severity: 'warning',
            message: formatKindRouteMismatch(fileLabel, idx, normalizedPath, itemRec.kind, mismatch)
              .replace(`${fileLabel}: `, ''),
            jsonPath: ['items', idx, 'kind'],
            quickFix: {
              title: `Change kind to '${mismatch.routeKind}' to match folder '${mismatch.routePrefix}'`,
              kind: 'fix-kind-route',
              jsonPath: ['items', idx, 'kind'],
              replacementValue: mismatch.routeKind
            }
          });
        }

        if (options.checkFile) {
          const probe = options.checkFile(normalizedPath);
          if (probe.exists) {
            if (canonicalKind === 'plugin') {
              const pluginCheck = validateAgentPluginItem({
                itemPath: normalizedPath,
                manifestText: probe.isFile === false ? null : (probe.content ?? null)
              });
              for (const issue of pluginCheck.issues) {
                const isFatal = issue.severity === 'fatal';
                pushDiagnostic({
                  code: isFatal ? 'COLLECTION_PLUGIN_MANIFEST_ERROR' : 'COLLECTION_PLUGIN_MANIFEST_WARNING',
                  severity: isFatal ? 'error' : 'warning',
                  message: `items[${idx}] (${normalizedPath}): ${issue.message}`,
                  jsonPath: ['items', idx, 'path']
                });
              }
            }

            if (itemLineRange) {
              inlineDecorations.push({
                line: itemLineRange.startLine,
                text: mismatch
                  ? `⚠ ${itemRec.kind} (route matches ${mismatch.routeKind}) • file exists`
                  : `✓ ${itemRec.kind} • file exists`,
                status: mismatch ? 'warning' : 'ok',
                jsonPath: ['items', idx]
              });
            }
          } else {
            pushDiagnostic({
              code: 'COLLECTION_ITEM_FILE_NOT_FOUND',
              severity: 'error',
              message: `items[${idx}] referenced file not found: ${normalizedPath}`,
              jsonPath: ['items', idx, 'path'],
              quickFix: {
                title: `Create missing ${itemRec.kind} file '${normalizedPath}' from template`,
                kind: 'scaffold-missing-item',
                jsonPath: ['items', idx, 'path'],
                filePath: normalizedPath,
                itemKind: itemRec.kind
              }
            });
            if (itemLineRange) {
              inlineDecorations.push({
                line: itemLineRange.startLine,
                text: `✗ ${itemRec.kind} • missing file (${normalizedPath})`,
                status: 'error',
                jsonPath: ['items', idx]
              });
            }
          }
        }
      }
    });
  } else {
    pushDiagnostic({
      code: 'COLLECTION_MISSING_REQUIRED_FIELD',
      severity: 'error',
      message: 'Missing required field: items (array)',
      jsonPath: ['items']
    });
  }

  // 6. AJV schema validation for any additional structural rules (e.g. mcp, display, maxLength)
  const schemaOk = validateSchema(root);
  if (!schemaOk && Array.isArray(validateSchema.errors)) {
    const existingKeys = new Set(
      diagnostics.map((d) => `${d.jsonPath.join('.')}:${d.code}`)
    );
    for (const ajvErr of validateSchema.errors) {
      const pointer = ajvErr.instancePath || '';
      const pathSegments = pointer
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
      if (ajvErr.keyword === 'required' && typeof (ajvErr.params as { missingProperty?: unknown })?.missingProperty === 'string') {
        pathSegments.push((ajvErr.params as { missingProperty: string }).missingProperty);
      }
      const dotKey = pathSegments.join('.');
      if (
        dotKey === 'id'
        || dotKey === 'name'
        || dotKey === 'description'
        || dotKey === 'version'
        || dotKey === 'items'
        || /^items\.\d+\.(?:path|kind)$/.test(dotKey)
        || existingKeys.has(`${dotKey}:COLLECTION_SCHEMA_VIOLATION`)
      ) {
        continue;
      }
      existingKeys.add(`${dotKey}:COLLECTION_SCHEMA_VIOLATION`);
      const isMcp = dotKey.startsWith('mcp');
      pushDiagnostic({
        code: isMcp ? 'COLLECTION_MCP_INVALID' : 'COLLECTION_SCHEMA_VIOLATION',
        severity: 'error',
        message: `${dotKey || '$'}: ${ajvErr.message ?? 'schema validation failed'}`,
        jsonPath: pathSegments
      });
    }
  }

  // 7. MCP inline decorations
  const mcpObj = asRecord(root.mcp);
  const mcpItems = asRecord(mcpObj?.items);
  if (mcpItems) {
    for (const [serverKey, srvVal] of Object.entries(mcpItems)) {
      const srvRec = asRecord(srvVal);
      const srvRange = nodeRanges.get(`mcp.items.${serverKey}`);
      if (srvRange && srvRec) {
        const transport = typeof srvRec.type === 'string' ? srvRec.type : 'stdio';
        const target = transport === 'stdio'
          ? (typeof srvRec.command === 'string' ? srvRec.command : '')
          : (typeof srvRec.url === 'string' ? srvRec.url : '');
        inlineDecorations.push({
          line: srvRange.startLine,
          text: `🔌 MCP (${transport})${target ? ` • ${target}` : ''}${srvRec.disabled ? ' [disabled]' : ''}`,
          status: 'info',
          jsonPath: ['mcp', 'items', serverKey]
        });
      }
    }
  }

  const valid = diagnostics.every((d) => d.severity !== 'error');
  return {
    config: parsed,
    manifest: root as unknown as CollectionManifest,
    valid,
    errors,
    warnings,
    diagnostics,
    inlineDecorations,
    nodeRanges
  };
}
