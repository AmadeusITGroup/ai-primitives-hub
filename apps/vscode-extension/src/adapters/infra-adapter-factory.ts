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
 *
 * Also the point where token resolution becomes visible: every chain built
 * here carries a source-labelled `createAuthEventLogger` handler, so the
 * output channel reports which origin supplied the token rather than
 * leaving a failed private-source sync unexplained.
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
  createAuthEventLogger,
} from './auth-event-logger';
import {
  isHttpTraceEnabled,
  LoggingHttpClient,
} from './logging-http-client';
import {
  IRepositoryAdapter,
} from './repository-adapter';
import {
  VsCodeSessionTokenProvider,
} from './vscode-session-token-provider';

const fs = new NodeFileSystem();
const clock = new SystemClock();
// Failed requests are always reported, so a 404 or an unresponsive host is
// visible without a setting; successes need `promptregistry.logging.httpTrace`.
const httpClient = new LoggingHttpClient(new NodeHttpClient(), { trace: isHttpTraceEnabled() });
const processRunner = new NodeProcessRunner();

/**
 * Build the dependency set for one source.
 *
 * Deliberately per-source rather than the two shared singletons this
 * replaced: the auth-event logger needs the source id to label its lines,
 * so a concurrent multi-source sync stays readable. The stateless Node
 * ports above are still shared, and the VS Code session provider's token
 * cache is process-wide static, so nothing is duplicated by constructing
 * a provider per source (which the extension already did).
 * @param source - The source whose adapter is being built.
 * @returns Deps carrying a source-labelled auth-event handler.
 */
function buildDeps(source: RegistrySource): SourceAdapterFactoryDeps {
  const onAuthEvent = createAuthEventLogger(source.id);
  // `skills` is the one type that must not prompt for sign-in.
  const createIfNone = source.type !== 'skills';

  return {
    fs,
    clock,
    httpClient,
    processRunner,
    fallbackTokenProviders: [
      new VsCodeSessionTokenProvider(createIfNone, onAuthEvent),
      new GhCliTokenProvider(undefined, onAuthEvent)
    ],
    onAuthEvent
  };
}

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
  return createSourceAdapter(source, buildDeps(source));
}
