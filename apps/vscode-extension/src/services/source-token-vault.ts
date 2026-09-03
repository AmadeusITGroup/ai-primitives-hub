import type * as vscode from 'vscode';
import type {
  RegistrySource,
} from '../types/registry';

/** Source-scoped secret storage for credentials that must never be serialized. */
export class SourceTokenVault {
  private static readonly KEY_PREFIX = 'promptregistry.source-token.';

  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public async get(sourceId: string): Promise<string | undefined> {
    return await this.secrets.get(SourceTokenVault.key(sourceId));
  }

  public async set(sourceId: string, token: string): Promise<void> {
    await this.secrets.store(SourceTokenVault.key(sourceId), token);
  }

  public async delete(sourceId: string): Promise<void> {
    await this.secrets.delete(SourceTokenVault.key(sourceId));
  }

  public async migrateLegacyTokens(sources: readonly RegistrySource[]): Promise<RegistrySource[]> {
    return await Promise.all(sources.map(async (source) => {
      if (source.token && source.token.trim()) {
        await this.set(source.id, source.token.trim());
      }
      const { token: _token, ...sanitized } = source;
      return sanitized;
    }));
  }

  public static key(sourceId: string): string {
    return `${SourceTokenVault.KEY_PREFIX}${encodeURIComponent(sourceId)}`;
  }
}
