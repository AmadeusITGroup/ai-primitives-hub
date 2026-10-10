import {
  createHash,
} from 'node:crypto';
import {
  RegistryError,
  verifyArchiveIntegrity,
} from '@ai-primitives-hub/core';
import type {
  BundleDownloader,
  DownloadResult,
  Installable,
} from '@ai-primitives-hub/core';
import type {
  ArtifactoryHttpClient,
} from '../artifactory/http-client';

/** Downloads an Artifactory archive through the source-scoped HTTP client. */
export class ArtifactoryBundleDownloader implements BundleDownloader {
  public constructor(private readonly client: ArtifactoryHttpClient) {}

  private digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  public async download(installable: Installable): Promise<DownloadResult> {
    const bytes = installable.inlineBytes ?? await this.client.getBytesAt(installable.downloadUrl);
    const sha256 = this.digest(bytes);
    if (installable.integrity !== undefined && !verifyArchiveIntegrity(bytes, installable.integrity)) {
      throw new RegistryError({
        code: 'BUNDLE.ARCHIVE_INTEGRITY_MISMATCH',
        message: 'Artifactory archive integrity verification failed.'
      });
    }
    return { bytes, sha256 };
  }
}
