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
  SourceAdapter,
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
 */
export function createRegistryAdapter(source: RegistrySource): IRepositoryAdapter {
  return createCoreRegistryAdapter(source) as IRepositoryAdapter;
}

/**
 * Build the shared core adapter for services that consume the app/infra
 * ports directly, such as primitive indexing.
 * @param source - The source to build an adapter for.
 */
export function createCoreRegistryAdapter(source: RegistrySource): SourceAdapter {
  const deps = source.type === 'skills' ? silentDeps : promptingDeps;
  return createSourceAdapter(source, deps);
}
