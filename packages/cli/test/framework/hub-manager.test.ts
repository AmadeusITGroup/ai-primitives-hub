/**
 * Tests for `framework/hub-manager.ts`.
 *
 * The factory wires the default `HubManager` (HTTP client, token provider,
 * resolvers, stores) that hub and profile commands use.
 */
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createHttpClientAndTokens,
  createHubManager,
  createTestContext,
} from '../../src/framework';

describe('createHubManager', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-hub-manager-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('creates a HubManager with default dependencies', () => {
    const ctx = createTestContext({
      fs: new NodeFileSystem(),
      env: { XDG_CONFIG_HOME: path.join(workspace, '.config') }
    });
    const mgr = createHubManager({ ctx });
    expect(mgr).toBeDefined();
    expect(typeof mgr.getHub).toBe('function');
  });

  it('uses provided http client and token provider when given', () => {
    const ctx = createTestContext({
      fs: new NodeFileSystem(),
      env: { XDG_CONFIG_HOME: path.join(workspace, '.config') }
    });
    const http = { fetch: () => Promise.resolve({ status: 200, text: () => Promise.resolve('') }) } as unknown as import('@ai-primitives-hub/core').HttpClient;
    const tokens = { getToken: () => Promise.resolve('token') } as unknown as import('@ai-primitives-hub/core').TokenProvider;
    const mgr = createHubManager({ ctx, http, tokens });
    expect(mgr).toBeDefined();
  });
});

describe('createHttpClientAndTokens', () => {
  it('returns the provided http and token providers when present', () => {
    const http = { fetch: () => Promise.resolve({ status: 200, text: () => Promise.resolve('') }) } as unknown as import('@ai-primitives-hub/core').HttpClient;
    const tokens = { getToken: () => Promise.resolve('token') } as unknown as import('@ai-primitives-hub/core').TokenProvider;
    const [resultHttp, resultTokens] = createHttpClientAndTokens(http, createTestContext(), tokens);
    expect(resultHttp).toBe(http);
    expect(resultTokens).toBe(tokens);
  });

  it('creates NodeHttpClient and EnvTokenProvider when none are provided', () => {
    const ctx = createTestContext({ env: { GITHUB_TOKEN: 'abc' } });
    const [http, tokens] = createHttpClientAndTokens(undefined, ctx, undefined);
    expect(http).toBeDefined();
    expect(tokens).toBeDefined();
  });
});
