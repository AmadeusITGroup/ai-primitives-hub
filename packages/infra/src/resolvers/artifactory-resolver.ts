/* eslint-disable @stylistic/max-len -- compact resolver mapping */
import {
  type ArtifactorySourceIndex,
  type BundleResolver,
  type BundleSpec,
  compareSemVer,
  type Installable,
  RegistryError,
  type RegistrySource,
  validateArtifactorySourceIndex,
} from '@ai-primitives-hub/core';
import {
  ArtifactoryHttpClient,
} from '../artifactory/http-client';

export class ArtifactoryBundleResolver implements BundleResolver {
  private index?: ArtifactorySourceIndex;
  public constructor(private readonly source: RegistrySource, private readonly client: ArtifactoryHttpClient) {}
  private async load(): Promise<ArtifactorySourceIndex> {
    if (this.index) {
      return this.index;
    }
    const result = await this.client.getIndex(this.source.config?.indexFile ?? 'index-v1.json');
    const validation = validateArtifactorySourceIndex(result.value, this.source.hubSourceId ? { hubSourceId: this.source.hubSourceId } : undefined);
    if (!validation.valid) {
      throw new RegistryError({
        code: 'ARTIFACTORY.INDEX_INVALID',
        message: `Invalid Artifactory index: ${validation.errors.join('; ')}`
      });
    }
    this.index = result.value as ArtifactorySourceIndex;
    return this.index;
  }

  public async resolve(spec: BundleSpec): Promise<Installable | null> {
    const candidates = (await this.load()).bundles.filter((entry) => entry.id === spec.bundleId && (spec.bundleVersion === undefined || spec.bundleVersion === 'latest' || entry.version === spec.bundleVersion));
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => compareSemVer(b.version, a.version));
    const selected = candidates[0];
    return { ref: { sourceId: this.source.id, sourceType: 'artifactory', bundleId: selected.id, bundleVersion: selected.version, installed: false }, downloadUrl: this.client.urlFor(selected.archive.path), integrity: `sha256:${selected.archive.sha256}` };
  }
}
