/**
 * Reuse and hydrate README content for source bundles.
 * @module registry/hydrate-source-readmes
 */
import type {
  Bundle,
  SourceAdapter,
} from '@ai-primitives-hub/core';

/** Maximum number of concurrent README downloads per source. */
export const README_DOWNLOAD_CONCURRENCY = 5;

export interface HydrateSourceReadmesPorts {
  cacheSourceBundles(sourceId: string, bundles: Bundle[]): Promise<void>;
  onReadmesDownloaded?(event: { sourceId: string; bundleIds: string[] }): void;
  onReadmesComplete?(event: { sourceId: string; succeeded: string[]; failed: string[] }): void;
}

/**
 * Reuse cached README content when the source revision is unchanged.
 * @param bundles Freshly fetched bundles to enrich in place.
 * @param cachedBundles Bundles cached by the last completed sync.
 */
export function reuseCachedSourceReadmes(bundles: Bundle[], cachedBundles: Bundle[]): void {
  const cachedById = new Map((cachedBundles ?? []).map((bundle) => [bundle.id, bundle]));

  for (const bundle of bundles) {
    const previous = cachedById.get(bundle.id);
    if (
      previous?.readme
      && previous.readmeRevision !== undefined
      && previous.readmeRevision === bundle.readmeRevision
    ) {
      bundle.readme = previous.readme;
    }
  }
}

/**
 * Download missing README content in bounded batches without failing source sync.
 * @param sourceId Source cache key.
 * @param bundles Bundles to enrich in place.
 * @param adapter Source adapter used to download README content.
 * @param ports Cache and event callbacks.
 */
export async function hydrateSourceReadmes(
  sourceId: string,
  bundles: Bundle[],
  adapter: SourceAdapter,
  ports: HydrateSourceReadmesPorts
): Promise<void> {
  const candidates = bundles.filter((bundle) => bundle.readmeUrl && !bundle.readme);
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (let index = 0; index < candidates.length; index += README_DOWNLOAD_CONCURRENCY) {
    const batch = candidates.slice(index, index + README_DOWNLOAD_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (bundle) => adapter.downloadReadme(bundle))
    );
    const downloaded: string[] = [];

    for (const [resultIndex, result] of results.entries()) {
      const bundle = batch[resultIndex];
      if (result.status === 'fulfilled' && result.value) {
        bundle.readme = result.value;
        downloaded.push(bundle.id);
      } else {
        failed.push(bundle.id);
      }
    }

    if (downloaded.length > 0) {
      succeeded.push(...downloaded);
      await ports.cacheSourceBundles(sourceId, bundles);
      ports.onReadmesDownloaded?.({ sourceId, bundleIds: downloaded });
    }
  }

  ports.onReadmesComplete?.({ sourceId, succeeded, failed });
}
