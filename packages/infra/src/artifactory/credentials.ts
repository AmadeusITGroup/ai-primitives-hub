import {
  type HttpCredentialProvider,
  RegistryError,
  type SourceRequestContext,
} from '@ai-primitives-hub/core';
import {
  isWithinSourceRoot,
  normalizeSourceRoot,
  resolveRepositoryMetadataUrl,
} from './published-object-url';

function bearerHeaders(env: Record<string, string | undefined>, envName: string): Readonly<Record<string, string>> {
  const token = env[envName];
  if (!token) {
    throw new RegistryError({ code: 'ARTIFACTORY.CREDENTIAL_MISSING', message: `Credential ${envName} is not available.` });
  }
  return { Authorization: `Bearer ${token}` };
}

export class AnonymousCredentialProvider implements HttpCredentialProvider {
  public async headersFor(url: string, context: SourceRequestContext): Promise<Readonly<Record<string, string>>> {
    const target = new URL(url);
    if (!isWithinSourceRoot(normalizeSourceRoot(context.trustedOrigin), target)) {
      throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Credential request is outside the trusted source root.' });
    }
    return {};
  }
}

export class ArtifactoryEnvCredentialProvider implements HttpCredentialProvider {
  public constructor(private readonly env: Record<string, string | undefined>, private readonly envName: string, private readonly sourceRoot: string) {}
  public async headersFor(url: string, context: SourceRequestContext): Promise<Readonly<Record<string, string>>> {
    const root = normalizeSourceRoot(this.sourceRoot);
    if (!isWithinSourceRoot(root, new URL(url)) || context.trustedOrigin !== root.origin) {
      throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Credential request is outside the trusted source root.' });
    }
    return bearerHeaders(this.env, this.envName);
  }
}

/** Authorize only the selected repository's metadata endpoint, not its siblings. */
export class ArtifactoryRepositoryCredentialProvider implements HttpCredentialProvider {
  public constructor(private readonly env: Record<string, string | undefined>, private readonly envName: string, private readonly sourceRoot: string) {}
  public async headersFor(url: string, context: SourceRequestContext): Promise<Readonly<Record<string, string>>> {
    const expected = resolveRepositoryMetadataUrl(this.sourceRoot).url;
    if (url !== expected.href || context.trustedOrigin !== expected.origin
      || context.trustedPathPrefix !== expected.pathname) {
      throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Credential request is outside the selected repository metadata endpoint.' });
    }
    return bearerHeaders(this.env, this.envName);
  }
}
