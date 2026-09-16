import {
  type HttpCredentialProvider,
  RegistryError,
  type SourceRequestContext,
} from '@ai-primitives-hub/core';
import {
  isWithinSourceRoot,
  normalizeSourceRoot,
} from './published-object-url';

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
    const token = this.env[this.envName];
    if (!token) {
      throw new RegistryError({ code: 'ARTIFACTORY.CREDENTIAL_MISSING', message: `Credential ${this.envName} is not available.` });
    }
    return { Authorization: `Bearer ${token}` };
  }
}
