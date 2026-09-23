/**
 * Validate a hub-config YAML file from a repository working tree.
 *
 * The app layer coordinates file access and the infra boundary validator;
 * parsing and policy logic remain below the delivery layer so the CLI and
 * future authoring integrations use the same behavior.
 * @module registry/validate-hub-config-file
 */
import type {
  Bundle,
  FileSystem,
  HubProfileBundle,
  RegistrySource,
  SourceType,
  ValidationResult,
} from '@ai-primitives-hub/core';
import {
  compareVersions,
  extractBundleIdentity,
} from '@ai-primitives-hub/core';
import {
  parseHubConfigYaml,
  validateHubConfigDocument,
} from '@ai-primitives-hub/infra';
import {
  createSourceAdapter,
  type SourceAdapterFactoryDeps,
} from './create-source-adapter';

export interface HubConfigFileValidationResult extends ValidationResult {
  file: string;
}

export interface HubCatalogBundle {
  id: string;
  version: string;
}

export interface HubSourceDeepValidationResult extends ValidationResult {
  sourceId: string;
  sourceType: string;
  enabled: boolean;
  bundles: HubCatalogBundle[];
  skipped?: boolean;
}

export interface HubProfileBundleDeepValidationResult {
  sourceId: string;
  bundleId: string;
  requestedVersion: string;
  required: boolean;
  valid: boolean;
  resolvedBundle?: HubCatalogBundle;
  errors: string[];
  warnings: string[];
}

export interface HubProfileDeepValidationResult {
  profileId: string;
  valid: boolean;
  bundles: HubProfileBundleDeepValidationResult[];
  errors: string[];
  warnings: string[];
}

export interface DeepHubConfigValidationResult extends HubConfigFileValidationResult {
  deep: true;
  sources: HubSourceDeepValidationResult[];
  profiles: HubProfileDeepValidationResult[];
  bundlesFound: number;
}

export type HubValidationProgress =
  | {
    phase: 'started';
    sourcesTotal: number;
    profilesTotal: number;
  }
  | {
    phase: 'source';
    status: 'started' | 'completed';
    current: number;
    total: number;
    sourceId: string;
    sourceType: string;
    enabled: boolean;
    valid?: boolean;
    bundlesFound?: number;
    skipped?: boolean;
  }
  | {
    phase: 'catalog';
    status: 'started' | 'completed';
    current: number;
    total: number;
    sourceId: string;
    sourceType: string;
    bundlesFound?: number;
  }
  | {
    phase: 'profile';
    status: 'started' | 'completed';
    current: number;
    total: number;
    profileId: string;
    bundlesTotal: number;
    valid?: boolean;
    errors?: number;
    warnings?: number;
  }
  | {
    phase: 'completed';
    sourcesTotal: number;
    profilesTotal: number;
    bundlesFound: number;
    valid: boolean;
  };

export interface HubConfigFileValidationOptions {
  /** Perform source accessibility, catalog discovery, and profile resolution checks. */
  deep?: boolean;
  /** Dependencies used to construct the configured source adapters. */
  sourceAdapterDeps?: SourceAdapterFactoryDeps;
  /** Receive deterministic progress events during deep validation. */
  onProgress?: (event: HubValidationProgress) => void;
}

const failure = (file: string, message: string): HubConfigFileValidationResult => ({
  file,
  valid: false,
  errors: [message],
  warnings: []
});

/**
 * Read and validate one hub configuration file.
 * @param fs Filesystem port used to read the repository file.
 * @param filePath Absolute or repository-relative file path.
 * @param options
 * @returns File path and combined validation result.
 */
export async function validateHubConfigFile(
  fs: FileSystem,
  filePath: string,
  options: HubConfigFileValidationOptions = {}
): Promise<HubConfigFileValidationResult | DeepHubConfigValidationResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    return failure(
      filePath,
      `Unable to read hub configuration '${filePath}': ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let config: unknown;
  try {
    config = parseHubConfigYaml(content);
  } catch (error) {
    return failure(
      filePath,
      `YAML parse error in '${filePath}': ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const staticResult: HubConfigFileValidationResult = {
    file: filePath,
    ...validateHubConfigDocument(config)
  };

  if (!options.deep) {
    return staticResult;
  }

  if (!options.sourceAdapterDeps) {
    return {
      ...staticResult,
      deep: true,
      sources: [],
      profiles: [],
      bundlesFound: 0,
      valid: false,
      errors: [...staticResult.errors, 'Deep validation requires source adapter dependencies.']
    };
  }

  if (!staticResult.valid) {
    return {
      ...staticResult,
      deep: true,
      sources: [],
      profiles: [],
      bundlesFound: 0
    };
  }

  return validateHubConfigDeep(config, filePath, options.sourceAdapterDeps, options.onProgress);
}

interface SourceCatalog {
  source: RegistrySource;
  result: HubSourceDeepValidationResult;
  bundles: Bundle[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const asString = (value: unknown, fallback: string): string => (
  typeof value === 'string' ? value : fallback
);

const sourceTypeFrom = (value: unknown): SourceType | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value as SourceType;
};

function toRegistrySource(value: Record<string, unknown>): RegistrySource | undefined {
  const id = typeof value.id === 'string' ? value.id : undefined;
  const type = sourceTypeFrom(value.type);
  const url = typeof value.url === 'string'
    ? value.url
    : (typeof value.repository === 'string'
      ? `https://github.com/${value.repository}`
      : undefined);

  if (!id || !type || !url) {
    return undefined;
  }

  const config = isRecord(value.config) ? value.config : undefined;
  const topLevelBranch = typeof value.branch === 'string' ? value.branch : undefined;
  const normalizedConfig = topLevelBranch === undefined || config?.branch !== undefined
    ? config
    : { ...config, branch: topLevelBranch };

  return {
    id,
    name: asString(value.name, id),
    type,
    url,
    enabled: value.enabled === true,
    priority: typeof value.priority === 'number' ? value.priority : 0,
    private: value.private === true,
    token: typeof value.token === 'string' ? value.token : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
    config: normalizedConfig
  };
}

function bundleMatchesReference(bundle: Bundle, reference: HubProfileBundle, sourceType: SourceType): boolean {
  if (bundle.id === reference.id) {
    return true;
  }
  if (sourceType !== 'github') {
    return false;
  }

  return extractBundleIdentity(bundle.id, sourceType) === extractBundleIdentity(reference.id, sourceType);
}

function compareCatalogVersions(left: HubCatalogBundle, right: HubCatalogBundle): number {
  try {
    const versionOrder = compareVersions(right.version, left.version);
    if (versionOrder !== 0) {
      return versionOrder;
    }
  } catch {
    const versionOrder = right.version.localeCompare(left.version);
    if (versionOrder !== 0) {
      return versionOrder;
    }
  }
  return left.id.localeCompare(right.id);
}

function sortBundles(bundles: Bundle[]): Bundle[] {
  return bundles.toSorted((left, right) => {
    const idOrder = left.id.localeCompare(right.id);
    if (idOrder !== 0) {
      return idOrder;
    }
    return compareCatalogVersions(
      { id: left.id, version: left.version },
      { id: right.id, version: right.version }
    );
  });
}

function selectLatestBundle(bundles: Bundle[]): Bundle | undefined {
  return bundles
    .toSorted((left, right) => compareCatalogVersions(
      { id: left.id, version: left.version },
      { id: right.id, version: right.version }
    ))[0];
}

function availableVersions(bundles: Bundle[]): string {
  return [...new Set(bundles.map((bundle) => bundle.version))]
    .toSorted((left, right) => {
      try {
        return compareVersions(left, right);
      } catch {
        return left.localeCompare(right);
      }
    })
    .join(', ');
}

async function validateSource(
  source: RegistrySource,
  deps: SourceAdapterFactoryDeps,
  onProgress: ((event: HubValidationProgress) => void) | undefined,
  current: number,
  total: number
): Promise<SourceCatalog> {
  onProgress?.({
    phase: 'source',
    status: 'started',
    current,
    total,
    sourceId: source.id,
    sourceType: source.type,
    enabled: source.enabled
  });

  if (!source.enabled) {
    onProgress?.({
      phase: 'source',
      status: 'completed',
      current,
      total,
      sourceId: source.id,
      sourceType: source.type,
      enabled: false,
      valid: true,
      bundlesFound: 0,
      skipped: true
    });
    return {
      source,
      bundles: [],
      result: {
        sourceId: source.id,
        sourceType: source.type,
        enabled: false,
        valid: true,
        errors: [],
        warnings: ['Source is disabled; accessibility and catalog checks were skipped.'],
        bundles: [],
        bundlesFound: 0,
        skipped: true
      }
    };
  }

  let adapter;
  try {
    adapter = createSourceAdapter(source, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.({
      phase: 'source',
      status: 'completed',
      current,
      total,
      sourceId: source.id,
      sourceType: source.type,
      enabled: true,
      valid: false,
      bundlesFound: 0
    });
    return {
      source,
      bundles: [],
      result: {
        sourceId: source.id,
        sourceType: source.type,
        enabled: true,
        valid: false,
        errors: [`Failed to create source adapter: ${message}`],
        warnings: [],
        bundles: [],
        bundlesFound: 0
      }
    };
  }

  let validation: ValidationResult;
  try {
    validation = await adapter.validate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    validation = {
      valid: false,
      errors: [`Source validation failed: ${message}`],
      warnings: []
    };
  }

  if (!validation.valid) {
    onProgress?.({
      phase: 'source',
      status: 'completed',
      current,
      total,
      sourceId: source.id,
      sourceType: source.type,
      enabled: true,
      valid: false,
      bundlesFound: 0
    });
    return {
      source,
      bundles: [],
      result: {
        sourceId: source.id,
        sourceType: source.type,
        enabled: true,
        valid: false,
        errors: validation.errors,
        warnings: validation.warnings ?? [],
        bundles: [],
        bundlesFound: 0
      }
    };
  }

  onProgress?.({
    phase: 'catalog',
    status: 'started',
    current,
    total,
    sourceId: source.id,
    sourceType: source.type
  });

  let bundles: Bundle[];
  try {
    bundles = sortBundles(await adapter.fetchBundles());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.({
      phase: 'catalog',
      status: 'completed',
      current,
      total,
      sourceId: source.id,
      sourceType: source.type,
      bundlesFound: 0
    });
    onProgress?.({
      phase: 'source',
      status: 'completed',
      current,
      total,
      sourceId: source.id,
      sourceType: source.type,
      enabled: true,
      valid: false,
      bundlesFound: 0
    });
    return {
      source,
      bundles: [],
      result: {
        sourceId: source.id,
        sourceType: source.type,
        enabled: true,
        valid: false,
        errors: [`Failed to discover bundles: ${message}`],
        warnings: validation.warnings ?? [],
        bundles: [],
        bundlesFound: 0
      }
    };
  }

  const catalog = bundles.map(({ id, version }) => ({ id, version }));
  onProgress?.({
    phase: 'catalog',
    status: 'completed',
    current,
    total,
    sourceId: source.id,
    sourceType: source.type,
    bundlesFound: bundles.length
  });
  onProgress?.({
    phase: 'source',
    status: 'completed',
    current,
    total,
    sourceId: source.id,
    sourceType: source.type,
    enabled: true,
    valid: true,
    bundlesFound: bundles.length
  });
  return {
    source,
    bundles,
    result: {
      sourceId: source.id,
      sourceType: source.type,
      enabled: true,
      valid: true,
      errors: [],
      warnings: validation.warnings ?? [],
      bundles: catalog,
      bundlesFound: bundles.length
    }
  };
}

function resolveProfileBundle(
  profileId: string,
  reference: HubProfileBundle,
  catalog: SourceCatalog | undefined
): HubProfileBundleDeepValidationResult {
  const base = {
    sourceId: reference.source,
    bundleId: reference.id,
    requestedVersion: reference.version,
    required: reference.required
  };

  const diagnostic = (message: string): HubProfileBundleDeepValidationResult => ({
    ...base,
    valid: !reference.required,
    errors: reference.required ? [message] : [],
    warnings: reference.required ? [] : [message]
  });

  if (!catalog) {
    return diagnostic(`Profile '${profileId}' references unknown source '${reference.source}'.`);
  }
  if (!catalog.source.enabled) {
    return diagnostic(`Profile '${profileId}' references disabled source '${reference.source}'.`);
  }
  if (!catalog.result.valid) {
    return diagnostic(`Profile '${profileId}' cannot resolve bundle '${reference.id}' because source '${reference.source}' failed validation.`);
  }

  const candidates = catalog.bundles.filter((bundle) => bundleMatchesReference(bundle, reference, catalog.source.type));
  if (candidates.length === 0) {
    return diagnostic(
      `Profile '${profileId}' references bundle '${reference.id}' from source '${reference.source}', `
      + 'but no matching bundle was discovered.'
    );
  }

  if (reference.version === 'latest') {
    const latest = selectLatestBundle(candidates);
    if (!latest) {
      return diagnostic(`Profile '${profileId}' references bundle '${reference.id}' from source '${reference.source}', but no matching bundle was discovered.`);
    }
    return {
      ...base,
      valid: true,
      resolvedBundle: { id: latest.id, version: latest.version },
      errors: [],
      warnings: []
    };
  }

  const exactVersion = candidates.find((bundle) => bundle.version === reference.version);
  if (!exactVersion) {
    return diagnostic(
      `Profile '${profileId}' requires bundle '${reference.id}' at version '${reference.version}' `
      + `from source '${reference.source}', but available versions are: ${availableVersions(candidates)}.`
    );
  }

  return {
    ...base,
    valid: true,
    resolvedBundle: { id: exactVersion.id, version: exactVersion.version },
    errors: [],
    warnings: []
  };
}

async function validateHubConfigDeep(
  config: unknown,
  filePath: string,
  deps: SourceAdapterFactoryDeps,
  onProgress: ((event: HubValidationProgress) => void) | undefined
): Promise<DeepHubConfigValidationResult> {
  const root = config as Record<string, unknown>;
  const sourceValues = Array.isArray(root.sources) ? root.sources.filter((value) => isRecord(value)) : [];
  const sourceEntries = sourceValues
    .map((value, index) => ({ value, index, id: asString(value.id, `#${index + 1}`) }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const profileValues = Array.isArray(root.profiles) ? root.profiles.filter((value) => isRecord(value)) : [];
  const profileEntries = profileValues
    .map((value, index) => ({ value, index, id: asString(value.id, `#${index + 1}`) }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const catalogs = new Map<string, SourceCatalog>();

  onProgress?.({
    phase: 'started',
    sourcesTotal: sourceEntries.length,
    profilesTotal: profileEntries.length
  });

  for (const [sourceIndex, entry] of sourceEntries.entries()) {
    const source = toRegistrySource(entry.value);
    if (!source) {
      const sourceType = asString(entry.value.type, 'unknown');
      onProgress?.({
        phase: 'source',
        status: 'started',
        current: sourceIndex + 1,
        total: sourceEntries.length,
        sourceId: entry.id,
        sourceType,
        enabled: entry.value.enabled === true
      });
      catalogs.set(entry.id, {
        source: {
          id: entry.id,
          name: entry.id,
          type: sourceType as SourceType,
          url: '',
          enabled: entry.value.enabled === true,
          priority: typeof entry.value.priority === 'number' ? entry.value.priority : 0
        },
        bundles: [],
        result: {
          sourceId: entry.id,
          sourceType,
          enabled: entry.value.enabled === true,
          valid: false,
          errors: [`Source '${entry.id}' must define a supported type and URL for deep validation.`],
          warnings: [],
          bundles: [],
          bundlesFound: 0
        }
      });
      onProgress?.({
        phase: 'source',
        status: 'completed',
        current: sourceIndex + 1,
        total: sourceEntries.length,
        sourceId: entry.id,
        sourceType,
        enabled: entry.value.enabled === true,
        valid: false,
        bundlesFound: 0
      });
      continue;
    }

    catalogs.set(entry.id, await validateSource(
      source,
      deps,
      onProgress,
      sourceIndex + 1,
      sourceEntries.length
    ));
  }

  const sourceResults = sourceEntries.map((entry) => catalogs.get(entry.id)!.result);

  const profileResults = profileEntries.map((entry, profileIndex) => {
    const rawBundles = Array.isArray(entry.value.bundles)
      ? entry.value.bundles.filter((value) => isRecord(value))
      : [];
    const references = rawBundles
      .map((value) => ({
        id: asString(value.id, ''),
        version: asString(value.version, ''),
        source: asString(value.source, ''),
        required: value.required === true
      }))
      .toSorted((left, right) => {
        const sourceOrder = left.source.localeCompare(right.source);
        if (sourceOrder !== 0) {
          return sourceOrder;
        }
        const idOrder = left.id.localeCompare(right.id);
        if (idOrder !== 0) {
          return idOrder;
        }
        return left.version.localeCompare(right.version);
      }) as HubProfileBundle[];
    onProgress?.({
      phase: 'profile',
      status: 'started',
      current: profileIndex + 1,
      total: profileEntries.length,
      profileId: entry.id,
      bundlesTotal: references.length
    });
    const bundleResults = references.map((reference) => resolveProfileBundle(entry.id, reference, catalogs.get(reference.source)));
    const profileResult = {
      profileId: entry.id,
      valid: bundleResults.every((bundle) => bundle.valid),
      bundles: bundleResults,
      errors: bundleResults.flatMap((bundle) => bundle.errors),
      warnings: bundleResults.flatMap((bundle) => bundle.warnings)
    };
    onProgress?.({
      phase: 'profile',
      status: 'completed',
      current: profileIndex + 1,
      total: profileEntries.length,
      profileId: entry.id,
      bundlesTotal: references.length,
      valid: profileResult.valid,
      errors: profileResult.errors.length,
      warnings: profileResult.warnings.length
    });
    return profileResult;
  });

  const sourceErrors = sourceResults.flatMap((source) => source.errors);
  const profileErrors = profileResults.flatMap((profile) => profile.errors);
  const warnings = [
    ...sourceResults.flatMap((source) => source.warnings ?? []),
    ...profileResults.flatMap((profile) => profile.warnings)
  ];
  const bundlesFound = sourceResults.reduce(
    (total, source) => total + (source.bundlesFound ?? 0),
    0
  );
  const valid = sourceErrors.length === 0 && profileErrors.length === 0;

  onProgress?.({
    phase: 'completed',
    sourcesTotal: sourceEntries.length,
    profilesTotal: profileEntries.length,
    bundlesFound,
    valid
  });

  return {
    file: filePath,
    deep: true,
    valid,
    errors: [...sourceErrors, ...profileErrors],
    warnings,
    sources: sourceResults,
    profiles: profileResults,
    bundlesFound
  };
}
