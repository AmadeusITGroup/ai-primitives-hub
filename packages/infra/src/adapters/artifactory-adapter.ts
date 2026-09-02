/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/member-ordering, unicorn/no-array-sort -- compact mapping and deterministic ordering are intentional here */
import {
  createHash,
} from 'node:crypto';
import {
  type ArtifactoryBundleIndexEntry,
  type ArtifactorySourceIndex,
  type Bundle,
  compareSemVer,
  RegistryError,
  type RegistrySource,
  type SourceMetadata,
  validateArtifactorySourceIndex,
  type ValidationResult,
} from '@ai-primitives-hub/core';
import {
  ArtifactoryHttpClient,
} from '../artifactory/http-client';
import {
  BaseSourceAdapter,
} from './base-source-adapter';

const sizeText = (n: number): string => n < 1024 ? `${n} B` : (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export class ArtifactorySourceAdapter extends BaseSourceAdapter {
  public readonly type = 'artifactory';
  private index?: ArtifactorySourceIndex;
  public constructor(source: RegistrySource, private readonly client: ArtifactoryHttpClient) {
    super(source);
  }

  private async load(): Promise<ArtifactorySourceIndex> {
    if (this.index) {
      return this.index;
    }
    const result = await this.client.getIndex(this.source.config?.indexFile ?? 'index-v1.json');
    const validation = validateArtifactorySourceIndex(result.value, this.source.hubSourceId ? { hubSourceId: this.source.hubSourceId } : undefined);
    if (!validation.valid) {
      throw new RegistryError({ code: 'ARTIFACTORY.INDEX_INVALID', message: `Invalid Artifactory index: ${validation.errors.join('; ')}` });
    }
    this.index = result.value as ArtifactorySourceIndex;
    return this.index;
  }

  private async entry(bundle: Bundle): Promise<ArtifactoryBundleIndexEntry> {
    const found = (await this.load()).bundles.find((item) => item.id === bundle.id && item.version === bundle.version);
    if (!found) {
      throw new Error(`Bundle ${bundle.id}@${bundle.version} was not found.`);
    }
    return found;
  }

  public async fetchBundles(): Promise<Bundle[]> {
    const index = await this.load();
    return [...index.bundles].sort((a, b) => a.id.localeCompare(b.id) || compareSemVer(b.version, a.version)).map((item) => ({ id: item.id, name: item.name, version: item.version, description: item.description, author: item.author, sourceId: this.source.id, environments: item.environments, tags: item.tags, lastUpdated: item.lastUpdated, size: sizeText(item.archive.size), dependencies: item.dependencies, homepage: item.homepage, repository: item.repository, license: item.license, manifestUrl: this.client.urlFor(item.manifest.path), downloadUrl: this.client.urlFor(item.archive.path), checksum: { algorithm: 'sha256', hash: item.archive.sha256 }, readmeUrl: item.readme ? this.client.urlFor(item.readme.path) : undefined, readmeRevision: item.revision }));
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const item = await this.entry(bundle); const bytes = await this.client.getBytes(item.archive); this.verify(bytes, item.archive.sha256, item.archive.size, 'BUNDLE.ARCHIVE_INTEGRITY_MISMATCH'); return Buffer.from(bytes);
  }

  public async downloadReadme(bundle: Bundle): Promise<string | null> {
    const item = await this.entry(bundle); if (!item.readme) {
      return null;
    } const bytes = await this.client.getBytes(item.readme); this.verify(bytes, item.readme.sha256, item.readme.size, 'BUNDLE.MANIFEST_INTEGRITY_MISMATCH'); return Buffer.from(bytes).toString('utf8');
  }

  private verify(bytes: Uint8Array, expectedHash: string, expectedSize: number, code: string): void {
    if (bytes.byteLength !== expectedSize || digest(bytes) !== expectedHash) {
      throw new RegistryError({ code, message: 'Published object integrity check failed.' });
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    const index = await this.load(); return { name: index.source.name, description: index.source.description ?? '', bundleCount: index.bundles.length, lastUpdated: index.source.updatedAt, version: '1' };
  }

  public async validate(): Promise<ValidationResult> {
    try {
      const index = await this.load(); return { valid: true, errors: [], bundlesFound: index.bundles.length };
    } catch (error) {
      return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  }

  public requiresAuthentication(): boolean {
    return this.source.private === true || this.source.config?.authMode === 'bearer';
  }

  public getManifestUrl(bundleId: string, version?: string): string {
    const item = this.index?.bundles.find((b) => b.id === bundleId && (version === undefined || b.version === version)); return item ? this.client.urlFor(item.manifest.path) : '';
  }

  public getDownloadUrl(bundleId: string, version?: string): string {
    const item = this.index?.bundles.find((b) => b.id === bundleId && (version === undefined || b.version === version)); return item ? this.client.urlFor(item.archive.path) : '';
  }
}
