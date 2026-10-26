/**
 * Use-case service for inspecting, mutating, and validating `hub-config.yml`
 * documents across the Visual Hub Configuration Editor, Hub Config Tree View,
 * and YAML Text Editor Intelligence.
 * @module hub-editor/hub-config-editor-service
 */
import type {
  FileSystem,
  HubChangeSummary,
  HubConfig,
  HubCursorNodeContext,
  HubInlineDecoration,
  HubProfile,
  HubSourceCatalogEntry,
  HubValidationDiagnostic,
  RegistrySource,
  SourceRange,
} from '@ai-primitives-hub/core';
import {
  consolidateSourceCatalog,
} from '@ai-primitives-hub/core';
import {
  applyHubYamlMutation,
  type HubYamlMutation,
  locateHubYamlCursor,
  summarizeHubYamlChanges,
  validateHubConfigYaml,
} from '@ai-primitives-hub/infra';
import {
  createSourceAdapter,
  type SourceAdapterFactoryDeps,
} from '../registry/create-source-adapter';
import {
  type DeepHubConfigValidationResult,
  type HubValidationProgress,
  validateHubConfigContent,
} from '../registry/validate-hub-config-file';

export {
  consolidateSourceCatalog,
  type HubSourceCatalogEntry,
} from '@ai-primitives-hub/core';

export interface HubProfileCategoryGroup {
  category: string;
  profiles: {
    index: number;
    profile: HubProfile;
  }[];
}

export interface HubConfigDocumentInspection {
  valid: boolean;
  config?: HubConfig;
  errors: string[];
  warnings: string[];
  diagnostics: HubValidationDiagnostic[];
  inlineDecorations: HubInlineDecoration[];
  nodeRanges: Map<string, SourceRange>;
  catalogsBySourceId: Record<string, HubSourceCatalogEntry[]>;
  profileCategories: HubProfileCategoryGroup[];
}

export class HubConfigEditorService {
  private readonly catalogsBySourceId = new Map<string, HubSourceCatalogEntry[]>();
  private lastDeepDiagnostics: HubValidationDiagnostic[] = [];
  private lastDeepDecorations: HubInlineDecoration[] = [];

  private recordDeepValidationResults(
    deepResult: DeepHubConfigValidationResult,
    config: HubConfig | undefined,
    nodeRanges: Map<string, SourceRange>
  ): void {
    const deepDiags: HubValidationDiagnostic[] = [];
    const deepDecos: HubInlineDecoration[] = [];

    const sourceIndexById = new Map<string, { index: number; source: HubConfig['sources'][number] }>();
    (config?.sources ?? []).forEach((s, idx) => {
      if (s?.id) {
        sourceIndexById.set(s.id, { index: idx, source: s });
      }
    });

    const profileIndexById = new Map<string, { index: number; profile: HubProfile }>();
    (config?.profiles ?? []).forEach((p, idx) => {
      if (p?.id) {
        profileIndexById.set(p.id, { index: idx, profile: p });
      }
    });

    for (const srcResult of deepResult.sources) {
      const srcMeta = sourceIndexById.get(srcResult.sourceId);
      const formattedCatalog = consolidateSourceCatalog(srcMeta?.source, srcResult.bundles);
      this.catalogsBySourceId.set(srcResult.sourceId, formattedCatalog);

      if (srcMeta) {
        const range = nodeRanges.get(`sources.${srcMeta.index}`);
        if (!srcResult.valid) {
          for (const errMsg of srcResult.errors) {
            deepDiags.push({
              code: 'HUB_SOURCE_UNREACHABLE',
              severity: 'error',
              message: `Source '${srcResult.sourceId}': ${errMsg}`,
              jsonPath: ['sources', srcMeta.index],
              range
            });
          }
        }
        if (range) {
          deepDecos.push({
            line: range.startLine,
            text: srcResult.skipped
              ? `${srcResult.sourceType} • skipped (disabled)`
              : (srcResult.valid
                ? `✓ ${srcResult.sourceType} • ${formattedCatalog.length} bundle(s) discovered`
                : `✗ ${srcResult.sourceType} • unreachable`),
            status: srcResult.valid ? 'ok' : 'error',
            jsonPath: ['sources', srcMeta.index]
          });
        }
      }
    }

    for (const profResult of deepResult.profiles) {
      const profMeta = profileIndexById.get(profResult.profileId);
      if (!profMeta) {
        continue;
      }
      const yamlBundles = Array.isArray(profMeta.profile.bundles) ? profMeta.profile.bundles : [];
      const usedYamlIndices = new Set<number>();

      profResult.bundles.forEach((bResult, bIdx) => {
        let yamlBundleIdx = yamlBundles.findIndex(
          (yb, idx) => !usedYamlIndices.has(idx)
            && yb?.id === bResult.bundleId
            && yb?.source === bResult.sourceId
            && (yb?.version || 'latest') === (bResult.requestedVersion || 'latest')
        );
        if (yamlBundleIdx === -1) {
          yamlBundleIdx = bIdx;
        } else {
          usedYamlIndices.add(yamlBundleIdx);
        }

        const bundleRange = nodeRanges.get(`profiles.${profMeta.index}.bundles.${yamlBundleIdx}.id`)
          ?? nodeRanges.get(`profiles.${profMeta.index}.bundles.${yamlBundleIdx}`);
        if (!bResult.valid) {
          for (const errMsg of bResult.errors) {
            const isVersionErr = errMsg.includes('available versions are');
            deepDiags.push({
              code: isVersionErr ? 'HUB_BUNDLE_VERSION_NOT_FOUND' : 'HUB_BUNDLE_NOT_FOUND',
              severity: bResult.required ? 'error' : 'warning',
              message: errMsg,
              jsonPath: ['profiles', profMeta.index, 'bundles', yamlBundleIdx, isVersionErr ? 'version' : 'id'],
              range: bundleRange
            });
          }
        } else if (bResult.warnings.length > 0) {
          for (const warnMsg of bResult.warnings) {
            deepDiags.push({
              code: 'HUB_BUNDLE_NOT_FOUND',
              severity: 'warning',
              message: warnMsg,
              jsonPath: ['profiles', profMeta.index, 'bundles', yamlBundleIdx, 'id'],
              range: bundleRange
            });
          }
        } else if (bundleRange && bResult.resolvedBundle) {
          deepDecos.push({
            line: bundleRange.startLine,
            text: `✓ resolved v${bResult.resolvedBundle.version} (${bResult.sourceId})`,
            status: 'ok',
            jsonPath: ['profiles', profMeta.index, 'bundles', yamlBundleIdx]
          });
        }
      });
    }

    this.lastDeepDiagnostics = deepDiags;
    this.lastDeepDecorations = deepDecos;
  }

  private remapDeepDiagnostics(nodeRanges: Map<string, SourceRange>): HubValidationDiagnostic[] {
    return this.lastDeepDiagnostics.map((d) => ({
      ...d,
      range: nodeRanges.get(d.jsonPath.join('.')) ?? d.range
    }));
  }

  private mergeDecorations(
    staticDecos: HubInlineDecoration[],
    deepDecos: HubInlineDecoration[],
    nodeRanges: Map<string, SourceRange>
  ): HubInlineDecoration[] {
    const byPath = new Map<string, HubInlineDecoration>();
    for (const d of staticDecos) {
      byPath.set(d.jsonPath.join('.'), d);
    }
    for (const d of deepDecos) {
      const key = d.jsonPath.join('.');
      const range = nodeRanges.get(key);
      byPath.set(key, {
        ...d,
        line: range ? range.startLine : d.line
      });
    }
    return [...byPath.values()];
  }

  private groupProfilesByCategory(profiles: HubProfile[]): HubProfileCategoryGroup[] {
    const groups = new Map<string, { index: number; profile: HubProfile }[]>();
    profiles.forEach((profile, index) => {
      if (!profile || typeof profile !== 'object') {
        return;
      }
      const category = Array.isArray(profile.path) && profile.path.length > 0
        ? profile.path.join(' / ')
        : 'Uncategorized';
      const list = groups.get(category) ?? [];
      list.push({ index, profile });
      groups.set(category, list);
    });
    return [...groups.entries()].map(([category, items]) => ({
      category,
      profiles: items
    }));
  }

  /**
   * Inspect a `hub-config.yml` string offline (syntax, schema, policies, ranges,
   * categories, and any cached deep catalogs/diagnostics).
   * @param content Raw YAML document string.
   * @returns Complete document inspection payload.
   */
  public inspectDocument(content: string): HubConfigDocumentInspection {
    const staticResult = validateHubConfigYaml(content);
    const config = (staticResult.config && typeof staticResult.config === 'object' && !Array.isArray(staticResult.config))
      ? (staticResult.config as HubConfig)
      : undefined;

    const catalogsRecord: Record<string, HubSourceCatalogEntry[]> = {};
    for (const [sourceId, bundles] of this.catalogsBySourceId.entries()) {
      catalogsRecord[sourceId] = bundles;
    }

    const profileCategories = this.groupProfilesByCategory(config?.profiles ?? []);
    const mergedDiagnostics = [...staticResult.diagnostics, ...this.remapDeepDiagnostics(staticResult.nodeRanges)];
    const mergedDecorations = this.mergeDecorations(
      staticResult.inlineDecorations,
      this.lastDeepDecorations,
      staticResult.nodeRanges
    );
    const hasErrorDiag = mergedDiagnostics.some((d) => d.severity === 'error');

    return {
      valid: staticResult.valid && !hasErrorDiag,
      config,
      errors: [
        ...staticResult.errors,
        ...mergedDiagnostics
          .filter((d) => d.severity === 'error' && !staticResult.errors.includes(d.message))
          .map((d) => d.message)
      ],
      warnings: staticResult.warnings ?? [],
      diagnostics: mergedDiagnostics,
      inlineDecorations: mergedDecorations,
      nodeRanges: staticResult.nodeRanges,
      catalogsBySourceId: catalogsRecord,
      profileCategories
    };
  }

  /**
   * Apply a comment-preserving CRUD or quick-fix mutation to `hub-config.yml`
   * and return the updated content along with its fresh inspection.
   * @param content Current YAML content.
   * @param mutation Mutation to apply.
   */
  public applyMutation(
    content: string,
    mutation: HubYamlMutation
  ): { updatedContent: string; inspection: HubConfigDocumentInspection } {
    this.lastDeepDiagnostics = [];
    this.lastDeepDecorations = [];
    const updatedContent = applyHubYamlMutation(content, mutation);
    return {
      updatedContent,
      inspection: this.inspectDocument(updatedContent)
    };
  }

  /**
   * Locate the semantic node enclosing a 0-based line number in `hub-config.yml`.
   * @param content Raw YAML content.
   * @param line 0-based line number.
   */
  public locateCursor(content: string, line: number): HubCursorNodeContext {
    return locateHubYamlCursor(content, line);
  }

  /**
   * Summarize structural changes between a base `hub-config.yml` and an edited
   * `hub-config.yml` for commit messages and PR descriptions.
   * @param baseContent Base YAML content.
   * @param currentContent Edited YAML content.
   */
  public summarizeChanges(baseContent: string, currentContent: string): HubChangeSummary {
    return summarizeHubYamlChanges(baseContent, currentContent);
  }

  /**
   * Validate a single source and discover its bundle catalog for the Bundle Picker.
   * @param source Source definition to probe.
   * @param sourceAdapterDeps Dependencies for creating the source adapter.
   */
  public async discoverSourceBundles(
    source: RegistrySource,
    sourceAdapterDeps: SourceAdapterFactoryDeps
  ): Promise<{ valid: boolean; errors: string[]; bundles: HubSourceCatalogEntry[] }> {
    try {
      const adapter = createSourceAdapter(source, sourceAdapterDeps);
      const validation = await adapter.validate();
      if (!validation.valid) {
        this.catalogsBySourceId.delete(source.id);
        return {
          valid: false,
          errors: validation.errors,
          bundles: []
        };
      }
      const rawBundles = adapter.fetchCatalog
        ? await adapter.fetchCatalog()
        : await adapter.fetchBundles();
      const catalog = consolidateSourceCatalog(source, rawBundles);
      this.catalogsBySourceId.set(source.id, catalog);
      return {
        valid: true,
        errors: [],
        bundles: catalog
      };
    } catch (error) {
      this.catalogsBySourceId.delete(source.id);
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
        bundles: []
      };
    }
  }

  /**
   * Run deep hub configuration validation (source reachability, catalog
   * discovery, and profile bundle/version resolution) and map results onto
   * YAML line ranges and inline decorations.
   * @param _fs Filesystem port (retained for signature compatibility).
   * @param filePath Path to `hub-config.yml`.
   * @param content Current YAML content.
   * @param options Deep validation options.
   * @param options.sourceAdapterDeps
   * @param options.onProgress
   */
  public async validateDeep(
    _fs: FileSystem,
    filePath: string,
    content: string,
    options: {
      sourceAdapterDeps: SourceAdapterFactoryDeps;
      onProgress?: (event: HubValidationProgress) => void;
    }
  ): Promise<HubConfigDocumentInspection> {
    const staticCheck = validateHubConfigYaml(content);
    if (!staticCheck.valid) {
      return this.inspectDocument(content);
    }

    const result = await validateHubConfigContent(content, filePath, {
      deep: true,
      sourceAdapterDeps: options.sourceAdapterDeps,
      onProgress: options.onProgress
    });

    if (!('deep' in result) || !result.deep) {
      return this.inspectDocument(content);
    }

    this.recordDeepValidationResults(
      result,
      staticCheck.config as HubConfig | undefined,
      staticCheck.nodeRanges
    );

    return this.inspectDocument(content);
  }
}
