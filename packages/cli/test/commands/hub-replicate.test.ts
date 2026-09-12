import {
  Buffer,
} from 'node:buffer';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  TokenProvider,
} from '@ai-primitives-hub/core';
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
  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    let body: Uint8Array;
    if (request.url.includes('/contents/hub-config.yml')) {
      body = new TextEncoder().encode(JSON.stringify({ content: Buffer.from(hub).toString('base64') }));
    } else if (request.url.includes('/releases')) {
      body = new TextEncoder().encode(JSON.stringify([{
        tag_name: 'bundle-v1.0.0',
        name: 'Bundle 1.0.0',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'deployment-manifest.yml', url: 'https://api.github.com/assets/manifest', size: manifest.length },
          { name: 'bundle.zip', url: 'https://api.github.com/assets/archive', size: 4 }
        ]
      }]));
    } else if (request.url.endsWith('/assets/manifest')) {
      body = new TextEncoder().encode(manifest);
    } else {
      body = new Uint8Array([80, 75, 3, 4]);
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
    const ctx = createTestContext({ env: { HOME: '/tmp/aph-replicate-test' } });
    const cacheDir = `/tmp/aph-replicate-test-cache-${process.pid}-${Date.now()}`;
    const exitCode = await runCli([
      'hub', 'replicate',
      '--source-hub', 'owner/hub',
      '--target-root', 'https://artifactory.example/replicated',
      '--mode', 'latest',
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
});
