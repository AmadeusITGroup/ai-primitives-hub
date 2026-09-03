/**
 * Extension-side wiring for `@ai-primitives-hub/app`'s `createSourceAdapter`.
 *
 * Supplies the delivery-context-specific pieces the shared factory needs -
 * Node port implementations (`FileSystem`/`Clock`/`HttpClient`/`ProcessRunner`)
 * plus the extension's own GitHub auth fallback chain (VS Code session, then
 * the `gh` CLI) - so `RegistryManager` can build `infra`'s `SourceAdapter`s
 * instead of maintaining eight parallel `src/adapters/*` implementations.
 *
 * Per source-type auth policy: every type except `skills` passes
 * `createIfNone: true` to the VS Code session step (prompts the user to
 * sign in if no session exists yet), matching 3 of the 4 GitHub-hosted
 * extension adapters this replaces. `skills` passes `false`, matching that
 * one adapter's own existing exception (see `vscode-session-token-provider.ts`).
 * @module adapters/infra-adapter-factory
 */
import {
  createSourceAdapter,
} from '@ai-primitives-hub/app';
import type {
  SourceAdapterFactoryDeps,
} from '@ai-primitives-hub/app';
import type {
  HttpCredentialProvider,
  SourceAdapter,
  SourceRequestContext,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  GhCliTokenProvider,
  NodeFileSystem,
  NodeHttpClient,
  NodeProcessRunner,
  normalizeSourceRoot,
  SystemClock,
} from '@ai-primitives-hub/infra';
import {
  SourceTokenVault,
} from '../services/source-token-vault';
import type {
  RegistrySource,
} from '../types/registry';
import {
  IRepositoryAdapter,
} from './repository-adapter';
import {
  VsCodeSessionTokenProvider,
} from './vscode-session-token-provider';

class VaultTokenProvider implements TokenProvider {
  public constructor(private readonly vault: SourceTokenVault, private readonly sourceId: string) {}
  public async getToken(_host: string): Promise<string | undefined> {
    return await this.vault.get(this.sourceId);
  }
}

/** SecretStorage-backed Artifactory credentials scoped to one source root. */
export class SourceVaultCredentialProvider implements HttpCredentialProvider {
  public constructor(private readonly vault: SourceTokenVault, private readonly source: RegistrySource) {}

  public async headersFor(url: string, context: SourceRequestContext): Promise<Readonly<Record<string, string>>> {
    const root = normalizeSourceRoot(this.source.url);
    const target = new URL(url);
    const rootPath = root.pathname;
    if (root.origin !== target.origin || !target.pathname.startsWith(rootPath)
      || context.sourceId !== root.href || context.trustedOrigin !== root.origin
      || context.trustedPathPrefix !== rootPath) {
      throw new Error('Credential request is outside the configured source root.');
    }
    const token = await this.vault.get(this.source.id);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}

const fs = new NodeFileSystem();
const clock = new SystemClock();
const httpClient = new NodeHttpClient();
const processRunner = new NodeProcessRunner();
const ghCliTokenProvider = new GhCliTokenProvider();

const promptingDeps: SourceAdapterFactoryDeps = {
  fs,
  clock,
  httpClient,
  processRunner,
  fallbackTokenProviders: [new VsCodeSessionTokenProvider(true), ghCliTokenProvider]
};

const silentDeps: SourceAdapterFactoryDeps = {
  fs,
  clock,
  httpClient,
  processRunner,
  fallbackTokenProviders: [new VsCodeSessionTokenProvider(false), ghCliTokenProvider]
};

/**
 * Build the `infra`-backed adapter for a `RegistrySource`, matching the
 * shape of the extension's own `IRepositoryAdapter`.
 * @param source - The source to build an adapter for.
 * @param vault
 */
export function createRegistryAdapter(source: RegistrySource, vault?: SourceTokenVault): IRepositoryAdapter {
  return createCoreRegistryAdapter(source, vault) as IRepositoryAdapter;
}

/**
 * Build the shared core adapter for services that consume the app/infra
 * ports directly, such as primitive indexing.
 * @param source - The source to build an adapter for.
 * @param vault
 */
export function createCoreRegistryAdapter(source: RegistrySource, vault?: SourceTokenVault): SourceAdapter {
  const baseDeps = source.type === 'skills' ? silentDeps : promptingDeps;
  const deps: SourceAdapterFactoryDeps = vault === undefined
    ? baseDeps
    : {
      ...baseDeps,
      fallbackTokenProviders: [new VaultTokenProvider(vault, source.id), ...baseDeps.fallbackTokenProviders],
      artifactoryCredentialFactory: (currentSource) => new SourceVaultCredentialProvider(vault, currentSource)
    };
  return createSourceAdapter(source, deps);
}
