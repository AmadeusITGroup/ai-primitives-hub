/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line -- transport policy kept in one adapter */
import type {
  HttpClient,
  HttpCredentialProvider,
  ReplicationPublisherPort,
} from '@ai-primitives-hub/core';
import {
  normalizeSourceRoot,
  resolveConfinedObject,
} from '../artifactory/published-object-url';

export class ArtifactoryReplicationPublisher implements ReplicationPublisherPort {
  private readonly root: URL;
  public constructor(private readonly http: HttpClient, private readonly credentials: HttpCredentialProvider, sourceRoot: string, private readonly allowUnverifiedExisting = false) {
    this.root = normalizeSourceRoot(sourceRoot);
  }

  public async publish(path: string, data: Uint8Array, mediaType: string): Promise<'uploaded' | 'skipped-existing' | 'skipped-unverified'> {
    const url = resolveConfinedObject(this.root, path).href; const headers = { ...(await this.credentials.headersFor(url, { sourceId: this.root.href, trustedOrigin: this.root.origin, trustedPathPrefix: this.root.pathname })), Accept: '*/*' }; const digest = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(data).digest('hex')); const head = await this.http.fetch({ url, method: 'HEAD', headers }); if (head.statusCode === 200 || head.statusCode === 204) {
      const remote = head.headers['x-checksum-sha256'] ?? head.headers['x-artifactory-checksum-sha256']; if (remote?.toLowerCase() === digest) {
        return 'skipped-existing';
      } if (this.allowUnverifiedExisting) {
        return 'skipped-unverified';
      } throw new Error(`Existing Artifactory object cannot be verified or conflicts at ${path}; publication stopped.`);
    } if (head.statusCode !== 404 && head.statusCode !== 410) {
      throw new Error(`Artifactory HEAD failed for ${path}: HTTP ${String(head.statusCode)}`);
    } const response = await this.http.fetch({ url, method: 'PUT', headers: { ...headers, 'Content-Type': mediaType, 'X-Checksum-Sha256': digest }, body: data }); if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Artifactory upload failed for ${path}: HTTP ${String(response.statusCode)}`);
    } return 'uploaded';
  }
}
