/**
 * `bundle build` release planning use case.
 *
 * Plans the governed release from the committed revision and, only when
 * that revision carries no license evidence, falls back to the legacy
 * working-tree release with a warning. The fallback rule and warning text
 * live in core (`isMissingSourceLicenseError`, `LEGACY_RELEASE_WARNING`).
 *
 * Every `kind: plugin` item is checked against Agent Plugins 1.0.0 (core
 * `validateAgentPluginItem`) on the tree that is packaged: the committed
 * revision, or only the working tree on the legacy fallback. Messages are the ones `collection validate` reports. Fatal
 * issues reject with `PLUGIN.INVALID_MANIFEST`; non-fatal issues are
 * returned as warnings.
 * @module release/plan-bundle-release
 */
import * as path from 'node:path';
import {
  createLegacyReleaseManifestPlan,
  createReleaseManifestPlan,
  isMissingSourceLicenseError,
  LEGACY_RELEASE_WARNING,
  normalizePrimitiveKind,
  normalizeRepoRelativePath,
  RegistryError,
  type ReleaseManifestPlan,
  type ReleaseSourceReader,
  type ReleaseSourceTree,
  type RevisionedReleaseSourceTree,
  validateAgentPluginItem,
} from '@ai-primitives-hub/core';
import {
  NodeReleaseSourceReader,
} from '@ai-primitives-hub/infra';
import * as yaml from 'js-yaml';
import {
  type PluginItemFindings,
  referencedFileNotFoundMessage,
  splitPluginItemIssues,
} from '../collection/plugin-item-issues';

/** Inputs for {@link planBundleRelease}. */
export interface PlanBundleReleaseOptions {
  /** Absolute repository root. */
  repoRoot: string;
  /** Collection file, repo-relative or absolute under `repoRoot`. */
  collectionFile: string;
  version: string;
  /** Source reader; defaults to {@link NodeReleaseSourceReader}. */
  sources?: ReleaseSourceReader;
}

/** A release plan and the warnings raised while planning it. */
export interface BundleReleasePlan {
  plan: ReleaseManifestPlan;
  warnings: string[];
}

/** Decodes like `fs.readFileSync(file, 'utf8')` (a BOM is kept), as `collection validate` reads. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

const PLUGIN_ERROR_HINT = 'Fix plugin.json (see docs/author-guide/validation.md#plugin-manifests) and commit it; '
  + '`bundle build` packages the committed revision. Run `ai-primitives-hub collection validate` to check the working tree.';

/**
 * Pin the first opened trees so plugin validation and the core planner read
 * the same commit (and open each tree once). `planBundleRelease` only opens
 * `HEAD` of one `repoRoot`, so later calls' arguments are intentionally ignored.
 * @param sources - Underlying source reader.
 * @returns A reader that always returns the first opened revision and working tree.
 */
const pinSourceTrees = (sources: ReleaseSourceReader): ReleaseSourceReader => {
  let revision: Promise<RevisionedReleaseSourceTree> | undefined;
  let workingTree: ReleaseSourceTree | undefined;
  return {
    openRevision: (repoRoot, rev) => {
      revision ??= sources.openRevision(repoRoot, rev);
      return revision;
    },
    openWorkingTree: (repoRoot) => {
      workingTree ??= sources.openWorkingTree(repoRoot);
      return workingTree;
    },
    readRemoteUrl: (repoRoot) => sources.readRemoteUrl(repoRoot)
  };
};

/**
 * Read a collection's items from a release tree. Any failure returns null so
 * the core planner raises its own canonical error for it.
 * @param tree - Tree to read from.
 * @param repoRoot - Absolute repository root.
 * @param collectionFile - Collection file, repo-relative or absolute.
 * @returns The normalized collection path and raw items, or null.
 */
const readCollectionItems = async (
  tree: ReleaseSourceTree | Promise<ReleaseSourceTree>,
  repoRoot: string,
  collectionFile: string
): Promise<{ collectionRel: string; tree: ReleaseSourceTree; items: unknown[] } | null> => {
  try {
    const collectionRel = normalizeRepoRelativePath(
      path.isAbsolute(collectionFile) ? path.relative(repoRoot, collectionFile) : collectionFile
    );
    const opened = await tree;
    const collection = yaml.load(utf8.decode(await opened.readFile(collectionRel))) as { items?: unknown } | null;
    if (!Array.isArray(collection?.items)) {
      return null;
    }
    return { collectionRel, tree: opened, items: collection.items };
  } catch {
    return null;
  }
};

/**
 * Read a plugin item's manifest from a release tree.
 * @param tree - Tree to read from.
 * @param itemPath - Normalized repo-relative item path.
 * @returns The file text, null when the path is a directory, or undefined when it is absent.
 */
const readPluginManifest = async (tree: ReleaseSourceTree, itemPath: string): Promise<string | null | undefined> => {
  const listed = await tree.listFiles(path.posix.dirname(itemPath));
  if (listed.includes(itemPath)) {
    return utf8.decode(await tree.readFile(itemPath));
  }
  return listed.some((file) => file.startsWith(`${itemPath}/`)) ? null : undefined;
};

/**
 * Validate every plugin item of a collection on one release tree.
 * @param tree - Tree that will be packaged.
 * @param repoRoot - Absolute repository root.
 * @param collectionFile - Collection file, repo-relative or absolute.
 * @returns Error and warning messages, worded as `collection validate` words them.
 */
const validatePluginItems = async (
  tree: ReleaseSourceTree | Promise<ReleaseSourceTree>,
  repoRoot: string,
  collectionFile: string
): Promise<PluginItemFindings> => {
  const findings: PluginItemFindings = { errors: [], warnings: [] };
  const collection = await readCollectionItems(tree, repoRoot, collectionFile);
  if (collection === null) {
    return findings;
  }
  for (const [index, item] of collection.items.entries()) {
    const { kind, path: rawPath } = (item ?? {}) as { kind?: unknown; path?: unknown };
    if (typeof rawPath !== 'string' || normalizePrimitiveKind(kind) !== 'plugin') {
      continue;
    }
    let itemPath: string;
    try {
      itemPath = normalizeRepoRelativePath(rawPath);
    } catch {
      continue;
    }
    const manifestText = await readPluginManifest(collection.tree, itemPath);
    if (manifestText === undefined) {
      findings.errors.push(referencedFileNotFoundMessage(collection.collectionRel, index, itemPath));
      continue;
    }
    const { issues } = validateAgentPluginItem({ itemPath, manifestText });
    const itemFindings = splitPluginItemIssues(collection.collectionRel, index, itemPath, issues);
    findings.errors.push(...itemFindings.errors);
    findings.warnings.push(...itemFindings.warnings);
  }
  return findings;
};

/**
 * Reject when any plugin finding is fatal.
 * @param findings - Findings for the tree about to be packaged.
 * @throws {RegistryError} `PLUGIN.INVALID_MANIFEST`, one `collection validate` message per line.
 */
const assertNoFatalPluginIssues = (findings: PluginItemFindings): void => {
  if (findings.errors.length > 0) {
    throw new RegistryError({
      code: 'PLUGIN.INVALID_MANIFEST',
      message: findings.errors.join('\n'),
      hint: PLUGIN_ERROR_HINT,
      context: { errors: findings.errors, warnings: findings.warnings }
    });
  }
};

/**
 * Plan the release archive for one collection.
 * @param options - Planning inputs.
 * @returns The governed plan, or the legacy plan plus {@link LEGACY_RELEASE_WARNING};
 * non-fatal Agent Plugin issues of the packaged tree are appended to `warnings`.
 * Rejects with `PLUGIN.INVALID_MANIFEST` when a plugin item is invalid, and with
 * any planning failure other than missing license evidence.
 */
export async function planBundleRelease(options: PlanBundleReleaseOptions): Promise<BundleReleasePlan> {
  const sources = pinSourceTrees(options.sources ?? new NodeReleaseSourceReader());
  const planOptions = {
    repoRoot: options.repoRoot,
    collectionFile: options.collectionFile,
    version: options.version
  };
  // A revision that cannot be opened yields no findings; the planner rethrows
  // the same (pinned) rejection.
  const revision = sources.openRevision(options.repoRoot);
  revision.catch(() => undefined);
  const revisionFindings = await validatePluginItems(revision, options.repoRoot, options.collectionFile);
  let plan: ReleaseManifestPlan;
  try {
    plan = await createReleaseManifestPlan(planOptions, sources);
  } catch (err) {
    if (!isMissingSourceLicenseError(err)) {
      // Plugin errors of the committed tree take precedence over other planner errors.
      assertNoFatalPluginIssues(revisionFindings);
      throw err;
    }
    // The legacy fallback packages the working tree, so committed-tree findings do not apply.
    const workingTreeFindings = await validatePluginItems(
      sources.openWorkingTree(options.repoRoot),
      options.repoRoot,
      options.collectionFile
    );
    assertNoFatalPluginIssues(workingTreeFindings);
    return {
      plan: await createLegacyReleaseManifestPlan(planOptions, sources),
      warnings: [LEGACY_RELEASE_WARNING, ...workingTreeFindings.warnings]
    };
  }
  assertNoFatalPluginIssues(revisionFindings);
  return { plan, warnings: revisionFindings.warnings };
}
