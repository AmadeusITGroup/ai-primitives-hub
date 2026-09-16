import type {
  HttpClient,
  HttpCredentialProvider,
  HubConfig,
  HubReference,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  AnonymousCredentialProvider,
} from '../artifactory/credentials';
import {
  ArtifactoryHttpClient,
} from '../artifactory/http-client';
import type {
  HubResolver,
  ResolvedHub,
} from './hub-resolver';
import {
  validateHubConfigDocument,
} from './validate-hub-config';

export type ArtifactoryCredentialProvider = (reference: HubReference, root: string) => HttpCredentialProvider;

/** Resolves a complete hub tree from a confined Artifactory repository root. */
export class ArtifactoryHubResolver implements HubResolver {
  public constructor(
    private readonly http: HttpClient,
    private readonly credentials: HttpCredentialProvider | ArtifactoryCredentialProvider,
    private readonly sourceRoot?: string
  ) {}

  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    if (ref.type !== 'artifactory') {
      throw new Error(`Artifactory resolver cannot resolve '${ref.type}' references`);
    }
    const root = this.sourceRoot ?? ref.location;
    const provider = typeof this.credentials === 'function'
      ? this.credentials(ref, root)
      : (ref.authMode === 'anonymous' ? new AnonymousCredentialProvider() : this.credentials);
    const client = new ArtifactoryHttpClient(this.http, provider, root);
    const configFile = ref.configFile ?? 'hub-config.yml';
    const text = await client.getText({ path: configFile, size: 0, sha256: '' });
    let parsed: unknown;
    try {
      parsed = yaml.load(text);
    } catch (cause) {
      throw new Error(`Failed to parse Artifactory hub config: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const validation = validateHubConfigDocument(parsed);
    if (!validation.valid) {
      throw new Error(`Invalid Artifactory hub config: ${validation.errors.join(', ')}`);
    }
    return { config: parsed as HubConfig, reference: ref };
  }
}
