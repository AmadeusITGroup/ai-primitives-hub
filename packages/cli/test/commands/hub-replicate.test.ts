import {
  Buffer,
} from 'node:buffer';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  buildZip,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  HubReplicateCommand,
} from '../../src/commands/hub-replicate';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

const manifest = `id: bundle
version: 1.0.0
name: Replicated bundle
description: Test bundle
author: Test
environments: [vscode]
tags: [test]
license: Apache-2.0
`;
const hub = `version: 1.0.0
metadata:
  name: Private source hub
  description: Test hub
  maintainer: Test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: source
    name: Source
    type: github
    url: https://github.com/owner/repo
    enabled: true
    priority: 1
profiles:
  - id: default
    name: Default
    description: Default
    bundles:
      - id: owner-repo-bundle
        version: latest
        source: source
        required: true
`;

class RecordingHttp implements HttpClient {
  public readonly requests: HttpRequest[] = [];
  public constructor(
    private readonly unverifiedSuffix?: string,
    private readonly noncompliantRelease = false,
    private readonly releaseArchive?: Uint8Array,
    private readonly repositoryResponse = {
      statusCode: 200,
      body: JSON.stringify({ key: 'replicated', rclass: 'local', packageType: 'AgentPackages', repoLayoutRef: 'agent-packages-default' })
    }
  ) {}

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    if (request.url === 'https://artifactory.example/artifactory/api/repositories/replicated') {
      return {
        statusCode: this.repositoryResponse.statusCode,
        body: new TextEncoder().encode(this.repositoryResponse.body),
        finalUrl: request.url,
        headers: {}
      };
    }
    if (request.url.startsWith('https://artifactory.example/')) {
      const unverified = this.unverifiedSuffix !== undefined && request.url.endsWith(this.unverifiedSuffix) && !request.url.includes('/indexes/');
      const headStatus = unverified ? 200 : 404;
      return { statusCode: request.method === 'HEAD' ? headStatus : 201, body: new Uint8Array(), finalUrl: request.url, headers: {} };
    }
    let body: Uint8Array;
    if (request.url.includes('/contents/hub-config.yml')) {
      body = new TextEncoder().encode(JSON.stringify({ content: Buffer.from(hub).toString('base64') }));
    } else if (request.url.includes('/releases')) {
      body = new TextEncoder().encode(JSON.stringify([{
        tag_name: this.noncompliantRelease ? '1.0.0' : 'bundle-v1.0.0',
        name: this.noncompliantRelease ? '1.0.0' : 'bundle-v1.0.0',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'deployment-manifest.yml', url: 'https://api.github.com/assets/manifest', size: manifest.length },
          { name: this.noncompliantRelease ? 'bundle.zip' : 'bundle.bundle.zip', url: 'https://api.github.com/assets/archive', size: 4 }
        ]
      }]));
    } else if (request.url.endsWith('/assets/manifest')) {
      body = new TextEncoder().encode(manifest);
    } else {
      body = this.releaseArchive ?? new Uint8Array([80, 75, 3, 4]);
    }
    return { statusCode: 200, body, finalUrl: request.url, headers: {} };
  }
}

const tokenProvider: TokenProvider = {
  getToken: async (host) => host === 'api.github.com' ? 'github-private-token' : undefined
};

describe('hub replicate command', () => {
  it('uses the supplied GitHub credential for a private source hub without leaking it', async () => {
    const http = new RecordingHttp();
    const ctx = createTestContext({ env: { HOME: path.join(os.tmpdir(), 'aph-replicate-test') } });
    const cacheDir = `${path.join(os.tmpdir(), 'aph-replicate-test-cache')}-${process.pid}-${Date.now()}`;
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/replicated',
      '--mode', 'latest',
      '--output', 'json',
      '--cache-dir', cacheDir
    ], {
      ctx,
      http,
      tokens: tokenProvider,
      commandClasses: [HubReplicateCommand],
      commands: [],
      name: 'ai-primitives-hub',
      version: 'test'
    });

    expect(exitCode).toBe(0);
    expect(http.requests.length).toBeGreaterThan(0);
    expect(http.requests.map((request) => request.headers?.Authorization)).toEqual([
      'token github-private-token',
      'token github-private-token',
      'token github-private-token'
    ]);
    expect(ctx.stdout.captured()).not.toContain('github-private-token');
    expect(JSON.parse(ctx.stdout.captured()).data.selectedBundles).toBe(1);
  });

  it('surfaces release and profile exclusions in warning output without publishing', async () => {
    const http = new RecordingHttp(undefined, true);
    const ctx = createTestContext({ env: { HOME: path.join(os.tmpdir(), 'aph-replicate-test') } });
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/replicated',
      '--mode', 'latest',
      '--output', 'json',
      '--cache-dir', `${path.join(os.tmpdir(), 'aph-replicate-warning')}-${process.pid}-${Date.now()}`
    ], {
      ctx,
      http,
      tokens: tokenProvider,
      commandClasses: [HubReplicateCommand],
      commands: [],
      name: 'ai-primitives-hub',
      version: 'test'
    });

    expect(exitCode).toBe(2);
    const output = JSON.parse(ctx.stdout.captured());
    expect(output.status).toBe('warning');
    expect(output.data.diagnostics).toEqual(output.warnings);
    expect(output.data.unresolvedProfiles).toEqual(output.warnings);
    expect(output.warnings.some((warning: string) => warning.includes('release name must match <collectionid>-vX.Y.Z'))).toBe(true);
    expect(output.warnings.some((warning: string) => warning.includes('Excluded profile "default"'))).toBe(true);
    expect(http.requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('uploads the hub config at the target root and everything else under sources/replicated', async () => {
    const http = new RecordingHttp();
    const ctx = createTestContext({ env: { HOME: path.join(os.tmpdir(), 'aph-replicate-test'), ARTIFACTORY_PUBLISHER_TOKEN: 'publisher-token' } });
    const cacheDir = `${path.join(os.tmpdir(), 'aph-replicate-test-cache-publish')}-${process.pid}-${Date.now()}`;
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/replicated',
      '--mode', 'latest',
      '--output', 'json',
      '--publish', '--review',
      '--cache-dir', cacheDir
    ], {
      ctx,
      http,
      tokens: tokenProvider,
      commandClasses: [HubReplicateCommand],
      commands: [],
      name: 'ai-primitives-hub',
      version: 'test'
    });

    expect(exitCode).toBe(0);
    const base = 'https://artifactory.example/replicated';
    expect(http.requests.filter((request) => request.method === 'PUT').map((request) => request.url)).toEqual([
      `${base}/sources/replicated/bundles/owner-repo-bundle/1.0.0/deployment-manifest.yml`,
      `${base}/sources/replicated/bundles/owner-repo-bundle/1.0.0/owner-repo-bundle-1.0.0.zip`,
      expect.stringMatching(/^https:\/\/artifactory.example\/replicated\/sources\/replicated\/indexes\/[a-f0-9]{64}\/index-v1.json$/),
      `${base}/sources/replicated/index-v1.json`,
      `${base}/hub-config.yml`
    ]);
    expect(ctx.stdout.captured()).not.toContain('publisher-token');
  });

  it('requires publication review before enabling temporary APM translation', async () => {
    const http = new RecordingHttp();
    const ctx = createTestContext({ env: { HOME: '/tmp/aph-replicate-test' } });
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/replicated',
      '--apm-transition',
      '--output', 'json'
    ], {
      ctx, http, tokens: tokenProvider, commandClasses: [HubReplicateCommand], commands: [], name: 'ai-primitives-hub', version: 'test'
    });

    expect(exitCode).toBe(1);
    expect(ctx.stderr.captured()).toContain('--apm-transition is temporary');
    expect(http.requests).toHaveLength(0);
  });

  it('publishes APM-ready archives unchanged at Agent Packages coordinates', async () => {
    const archive = buildZip([
      { path: 'deployment-manifest.yml', bytes: new TextEncoder().encode(manifest) },
      { path: 'apm.yml', bytes: new TextEncoder().encode('name: bundle\nversion: 1.0.0\ndependencies:\n  apm: []\n  mcp: []\nincludes: auto\n') },
      { path: '.apm/instructions/test.instructions.md', bytes: new TextEncoder().encode('Test instructions') }
    ]);
    const http = new RecordingHttp(undefined, false, archive);
    const ctx = createTestContext({ env: { HOME: '/tmp/aph-replicate-test', ARTIFACTORY_PUBLISHER_TOKEN: 'publisher-token' } });
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/artifactory/replicated',
      '--output', 'json',
      '--publish', '--review', '--apm-transition',
      '--cache-dir', `/tmp/aph-apm-ready-${process.pid}-${Date.now()}`
    ], {
      ctx, http, tokens: tokenProvider, commandClasses: [HubReplicateCommand], commands: [], name: 'ai-primitives-hub', version: 'test'
    });

    expect(exitCode).toBe(0);
    const base = 'https://artifactory.example/artifactory/replicated';
    expect(http.requests[0]).toMatchObject({
      url: 'https://artifactory.example/artifactory/api/repositories/replicated',
      method: 'GET',
      followRedirects: false,
      headers: { Authorization: 'Bearer publisher-token' }
    });
    const puts = http.requests.filter((request) => request.method === 'PUT');
    expect(puts.map((request) => request.url)).toEqual([
      `${base}/__CONFIG__/manifests/owner-repo-bundle/1.0.0/deployment-manifest.yml`,
      `${base}/owner/bundle/bundle-1.0.0.zip`,
      expect.stringMatching(/^https:\/\/artifactory\.example\/artifactory\/replicated\/__CONFIG__\/indexes\/[a-f0-9]{64}-index-v1\.json$/),
      `${base}/__CONFIG__/index-v1.json`,
      expect.stringMatching(/^https:\/\/artifactory\.example\/artifactory\/replicated\/__CONFIG__\/hub-config\/[a-f0-9]{64}-hub-config\.yml$/),
      `${base}/__CONFIG__/hub-config.yml`
    ]);
    expect(puts[1]?.body).toEqual(archive);
    const output = JSON.parse(ctx.stdout.captured());
    expect(output.status).toBe('ok');
    expect(output.data.transitionMode).toBe('temporary-apm');
    expect(output.data.targetRepository).toEqual({ key: 'replicated', rclass: 'local', packageType: 'agentpackages' });
    expect(ctx.stdout.captured()).not.toContain('publisher-token');
  });

  it.each([
    { statusCode: 200, body: JSON.stringify({ key: 'replicated', rclass: 'local', packageType: 'generic', repoLayoutRef: 'agent-packages-default' }), error: 'reports packageType "generic"' },
    { statusCode: 200, body: JSON.stringify({ key: 'replicated', rclass: 'local' }), error: 'Invalid Artifactory repository metadata' },
    { statusCode: 200, body: JSON.stringify({ key: 'another', rclass: 'local', packageType: 'agentpackages' }), error: 'Invalid Artifactory repository metadata' },
    { statusCode: 401, body: '', error: 'HTTP 401' },
    { statusCode: 403, body: '', error: 'HTTP 403' },
    { statusCode: 404, body: '', error: 'HTTP 404' }
  ])('stops transition before source reads or writes when repository inspection fails: $error', async (response) => {
    const http = new RecordingHttp(undefined, false, undefined, response);
    const ctx = createTestContext({ env: { HOME: '/tmp/aph-replicate-test', ARTIFACTORY_PUBLISHER_TOKEN: 'publisher-token' } });
    const exitCode = await runCli([
      'hub', 'replicate', '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/artifactory/replicated',
      '--publish', '--review', '--apm-transition', '--output', 'json',
      '--cache-dir', `/tmp/aph-repository-rejection-${process.pid}-${Date.now()}`
    ], {
      ctx, http, tokens: tokenProvider, commandClasses: [HubReplicateCommand], commands: [], name: 'ai-primitives-hub', version: 'test'
    });

    expect(exitCode).toBe(1);
    expect(ctx.stderr.captured()).toContain(response.error);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.method).toBe('GET');
    expect(ctx.stderr.captured()).not.toContain('publisher-token');
  });

  it.each(['deployment-manifest.yml', '.zip'])('reports unverified %s objects as a warning and publishes no bundle references', async (suffix) => {
    const http = new RecordingHttp(suffix);
    const ctx = createTestContext({ env: { HOME: path.join(os.tmpdir(), 'aph-replicate-test'), ARTIFACTORY_PUBLISHER_TOKEN: 'publisher-token' } });
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/replicated',
      '--output', 'json',
      '--publish', '--review', '--allow-unverified-existing',
      '--cache-dir', `${path.join(os.tmpdir(), 'aph-replicate-unverified')}-${suffix}-${process.pid}-${Date.now()}`
    ], {
      ctx, http, tokens: tokenProvider, commandClasses: [HubReplicateCommand], commands: [], name: 'ai-primitives-hub', version: 'test'
    });

    expect(exitCode).toBe(2);
    const output = JSON.parse(ctx.stdout.captured());
    expect(output.status).toBe('warning');
    expect(output.warnings).toHaveLength(2);
    expect(output.warnings[0]).toContain('owner-repo-bundle@1.0.0');
    expect(output.warnings[1]).toContain('Excluded profile "default"');
    expect(output.data.index.bundles).toEqual([]);
    const indexPut = http.requests.find((request) => request.method === 'PUT' && request.url.endsWith('/index-v1.json'));
    const hubPut = http.requests.find((request) => request.method === 'PUT' && request.url.endsWith('/hub-config.yml'));
    expect(indexPut).toBeDefined();
    expect(hubPut).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(indexPut?.body as Uint8Array)).bundles).toEqual([]);
    expect(JSON.parse(new TextDecoder().decode(hubPut?.body as Uint8Array)).profiles).toEqual([]);
    expect(ctx.stdout.captured()).not.toContain('publisher-token');
    expect(ctx.stdout.captured()).not.toContain('github-private-token');
  });

  it.each(['index-v1.json', 'hub-config.yml'])('fails publication when existing %s metadata cannot be verified', async (suffix) => {
    const http = new RecordingHttp(suffix);
    const ctx = createTestContext({ env: { HOME: path.join(os.tmpdir(), 'aph-replicate-test'), ARTIFACTORY_PUBLISHER_TOKEN: 'publisher-token' } });
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/replicated',
      '--output', 'json',
      '--publish', '--review', '--allow-unverified-existing',
      '--cache-dir', `${path.join(os.tmpdir(), 'aph-replicate-unverified-metadata')}-${suffix}-${process.pid}-${Date.now()}`
    ], {
      ctx, http, tokens: tokenProvider, commandClasses: [HubReplicateCommand], commands: [], name: 'ai-primitives-hub', version: 'test'
    });

    expect(exitCode).toBe(1);
    expect(ctx.stderr.captured()).toContain('Unverified existing metadata');
    expect(http.requests.some((request) => request.method === 'PUT' && request.url.endsWith('/hub-config.yml'))).toBe(false);
    expect(ctx.stderr.captured()).not.toContain('publisher-token');
  });
});
