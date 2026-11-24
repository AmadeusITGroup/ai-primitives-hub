import type {
  HttpClient,
  HttpCredentialProvider,
  ReplicationRepository,
  ReplicationRepositoryInspector,
} from '@ai-primitives-hub/core';
import {
  RegistryError,
} from '@ai-primitives-hub/core';
import {
  resolveRepositoryMetadataUrl,
} from '../artifactory/published-object-url';

/** Read the authoritative package type before transition publication. */
export class ArtifactoryRepositoryInspector implements ReplicationRepositoryInspector {
  public constructor(private readonly http: HttpClient, private readonly credentials: HttpCredentialProvider) {}

  public async inspect(targetRoot: string): Promise<ReplicationRepository> {
    const { key, url } = resolveRepositoryMetadataUrl(targetRoot);
    const headers = await this.credentials.headersFor(url.href, {
      sourceId: targetRoot,
      trustedOrigin: url.origin,
      trustedPathPrefix: url.pathname
    });
    const response = await this.http.fetch({
      url: url.href,
      method: 'GET',
      followRedirects: false,
      headers: { ...headers, Accept: 'application/json' }
    });
    if (response.statusCode !== 200) {
      throw new RegistryError({
        code: 'ARTIFACTORY.CONFIG_INVALID',
        message: `Cannot inspect Artifactory repository "${key}": HTTP ${response.statusCode}. Verify repository metadata permissions. No artifacts were published.`
      });
    }
    if (response.finalUrl !== url.href) {
      throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Artifactory repository inspection must not redirect.' });
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: `Invalid Artifactory repository metadata for "${key}": expected JSON.` });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !('key' in value) || value.key !== key
      || !('packageType' in value) || typeof value.packageType !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(value.packageType)
      || !('rclass' in value) || typeof value.rclass !== 'string' || !/^(?:local|remote|virtual|federated)$/i.test(value.rclass)) {
      throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: `Invalid Artifactory repository metadata for "${key}": expected matching key, packageType and repository class.` });
    }
    return { key, packageType: value.packageType.toLowerCase(), rclass: value.rclass.toLowerCase() };
  }
}
