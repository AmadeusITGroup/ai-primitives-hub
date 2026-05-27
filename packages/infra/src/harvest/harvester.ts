/**
 * Harvester — walks a BundleProvider and yields Primitives.
 *
 * Caller supplies the provider; the harvester stays adapter-agnostic so
 * identical code runs from the extension, the CLI, or a skill.
 */

import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
  Primitive,
} from '../search/types';
import {
  extractFromFile,
  extractMcpPrimitives,
} from './extractor';

/**
 * Options for harvesting primitives.
 */
export interface HarvestOptions {
  /** Hard cap to bound runaway providers (default 500). */
  maxFilesPerBundle?: number;
  /**
   * If the provider cannot enumerate files, we derive the candidate file
   * list from `manifest.items[].path`. Enabled by default.
   */
  useManifestItemPaths?: boolean;
  /** Optional per-bundle progress hook. */
  onBundle?: (ref: BundleRef, produced: number) => void;
  /** Optional error sink so a bad bundle does not abort the whole harvest. */
  onError?: (ref: BundleRef | null, err: unknown) => void;
}

/**
 * Harvest primitives from every bundle produced by a provider.
 * @param provider - Bundle source.
 * @param opts - Optional per-run caps and hooks.
 * @returns Array of harvested primitives.
 */
export async function harvest(
  provider: BundleProvider,
  opts: HarvestOptions = {}
): Promise<Primitive[]> {
  const out: Primitive[] = [];
  for await (const ref of provider.listBundles()) {
    try {
      const produced = await harvestBundle(provider, ref, opts);
      out.push(...produced);
      opts.onBundle?.(ref, produced.length);
    } catch (err) {
      opts.onError?.(ref, err);
    }
  }
  return out;
}

/**
 * Harvest primitives from a single bundle reference.
 * @param provider - Bundle source.
 * @param ref - Bundle to harvest.
 * @param opts - Optional per-run caps and hooks.
 * @returns Array of harvested primitives.
 */
export async function harvestBundle(
  provider: BundleProvider,
  ref: BundleRef,
  opts: HarvestOptions = {}
): Promise<Primitive[]> {
  const useItems = opts.useManifestItemPaths !== false;
  const maxFiles = opts.maxFilesPerBundle ?? 500;

  const manifest = await provider.readManifest(ref);
  const produced: Primitive[] = [];
  const seenPaths = new Set<string>();

  if (useItems && Array.isArray(manifest.items)) {
    const itemPrims = await harvestManifestItems(provider, ref, manifest, maxFiles, seenPaths, opts);
    produced.push(...itemPrims);
  }

  const mcpPrims = extractMcpPrimitives({ ref, manifest });
  for (const p of mcpPrims) {
    if (!seenPaths.has(p.path)) {
      produced.push(p);
      seenPaths.add(p.path);
    }
  }

  return produced;
}

/**
 * Harvest primitives from manifest items.
 * @param provider Bundle provider.
 * @param ref Bundle reference.
 * @param manifest Bundle manifest.
 * @param maxFiles Maximum files to process.
 * @param seenPaths Set of already seen paths.
 * @param opts Harvest options.
 * @returns Array of harvested primitives.
 */
async function harvestManifestItems(
  provider: BundleProvider,
  ref: BundleRef,
  manifest: BundleManifest,
  maxFiles: number,
  seenPaths: Set<string>,
  opts: HarvestOptions
): Promise<Primitive[]> {
  const produced: Primitive[] = [];
  const paths = (manifest.items ?? [])
    .map((i: unknown) => (i && typeof i === 'object' && 'path' in i && typeof i.path === 'string' ? i.path : ''))
    .filter(Boolean)
    .slice(0, maxFiles);
  const dedupedPaths = paths.filter((p: string) => {
    if (seenPaths.has(p)) {
      return false;
    }
    seenPaths.add(p);
    return true;
  });

  const settled = await Promise.allSettled(
    dedupedPaths.map(async (relPath: string) => ({
      relPath,
      content: await provider.readFile(ref, relPath)
    }))
  );

  for (const [i, r] of settled.entries()) {
    const relPath = dedupedPaths[i];
    if (r.status === 'rejected') {
      opts.onError?.(ref, r.reason);
      continue;
    }
    const prim = extractFromFile({ ref, manifest }, { path: relPath, content: r.value.content });
    if (prim) {
      produced.push(prim);
    }
  }

  return produced;
}
