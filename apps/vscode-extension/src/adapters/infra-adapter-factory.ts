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
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  GhCliTokenProvider,
  NodeFileSystem,
  NodeHttpClient,
  NodeProcessRunner,
  SystemClock,
} from '@ai-primitives-hub/infra';
import type {
  RegistrySource,
} from '../types/registry';
import {
  IRepositoryAdapter,
} from './repository-adapter';
import {
  VsCodeSessionTokenProvider,
} from './vscode-session-token-provider';

const fs = new NodeFileSystem();
const clock = new SystemClock();
/**
 * Process-wide `HttpClient`. Exported so other extension-side callers that
 * need raw HTTP (e.g. `RegistryManager`'s global-token probe) share this one
 * instance instead of each constructing their own.
 */
export const sharedHttpClient = new NodeHttpClient();
const processRunner = new NodeProcessRunner();
const ghCliTokenProvider = new GhCliTokenProvider();

/**
 * The extension's GitHub credential chain, in resolution order, each entry
 * carrying a human-readable label.
 *
 * Labelled (rather than relying on `constructor.name`, which the bundler
 * may mangle) so credential diagnostics can report *where* the token that
 * GitHub rejected came from - "the VS Code session" and "whatever `gh auth
 * token` prints" need very different fixes. Exported so the diagnostics
 * command probes the exact same provider instances the adapters use,
 * rather than a look-alike chain that could resolve differently.
 */
export const githubTokenProviderChain: readonly { label: string; provider: TokenProvider }[] = [
  { label: 'VS Code GitHub session', provider: new VsCodeSessionTokenProvider(true) },
  { label: 'gh CLI (`gh auth token`)', provider: ghCliTokenProvider }
];

const promptingDeps: SourceAdapterFactoryDeps = {
  fs,
  clock,
  httpClient: sharedHttpClient,
  processRunner,
  fallbackTokenProviders: githubTokenProviderChain.map((entry) => entry.provider)
};

const silentDeps: SourceAdapterFactoryDeps = {
  fs,
  clock,
  httpClient: sharedHttpClient,
  processRunner,
  fallbackTokenProviders: [new VsCodeSessionTokenProvider(false), ghCliTokenProvider]
};

/**
 * Build the `infra`-backed adapter for a `RegistrySource`, matching the
 * shape of the extension's own `IRepositoryAdapter`.
 * @param source - The source to build an adapter for.
 */
export function createRegistryAdapter(source: RegistrySource): IRepositoryAdapter {
  const deps = source.type === 'skills' ? silentDeps : promptingDeps;
  // `core`'s `ValidationResult.warnings` is optional (a stricter-than-necessary
  // port signature); every concrete `infra` adapter always populates it as a
  // real array (never omits it), so this narrow cast is safe in practice -
  // same reasoning/precedent as the `InstalledBundle` cast in
  // `RegistryManager.listInstalledBundles`.
  return createSourceAdapter(source, deps) as IRepositoryAdapter;
}
