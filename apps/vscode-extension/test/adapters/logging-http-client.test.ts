/**
 * LoggingHttpClient Tests
 */

import * as assert from 'node:assert';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import * as sinon from 'sinon';
import {
  describeRequestTarget,
  LoggingHttpClient,
} from '../../src/adapters/logging-http-client';
import {
  Logger,
} from '../../src/utils/logger';

function respondWith(statusCode: number, finalUrl = 'https://raw.githubusercontent.com/o/r/main/hub-config.yml'): HttpClient {
  return {
    fetch: async (): Promise<HttpResponse> => ({
      statusCode,
      body: new Uint8Array(),
      finalUrl,
      headers: {}
    })
  };
}

function failWith(error: Error): HttpClient {
  return { fetch: (): Promise<HttpResponse> => Promise.reject(error) };
}

const HUB_URL = 'https://raw.githubusercontent.com/Amadeus-xDLC/genai.prompt-registry-config/main/hub-config.yml?t=1755764203321';

suite('describeRequestTarget', () => {
  test('drops the cache-busting timestamp the hub resolver appends', () => {
    assert.strictEqual(
      describeRequestTarget(HUB_URL),
      'raw.githubusercontent.com/Amadeus-xDLC/genai.prompt-registry-config/main/hub-config.yml'
    );
  });

  test('keeps a meaningful query string', () => {
    assert.strictEqual(
      describeRequestTarget('https://api.github.com/repos/o/r/releases?per_page=100'),
      'api.github.com/repos/o/r/releases?per_page=100'
    );
  });

  test('masks a credential passed in the query string', () => {
    const described = describeRequestTarget('https://example.com/x?token=ghp_secretValue');
    assert.ok(!described.includes('ghp_secretValue'));
    assert.ok(described.includes('token=***'));
  });

  test('returns an unparseable url unchanged rather than throwing', () => {
    assert.strictEqual(describeRequestTarget('not a url'), 'not a url');
  });
});

suite('LoggingHttpClient', () => {
  let sandbox: sinon.SinonSandbox;
  let warnStub: sinon.SinonStub;
  let debugStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    const logger = Logger.getInstance();
    warnStub = sandbox.stub(logger, 'warn');
    debugStub = sandbox.stub(logger, 'debug');
  });

  teardown(() => {
    sandbox.restore();
  });

  const warnLines = (): string[] => warnStub.getCalls().map((call) => String(call.args[0]));
  const debugLines = (): string[] => debugStub.getCalls().map((call) => String(call.args[0]));

  const request: HttpRequest = { url: HUB_URL, headers: { Authorization: 'token ghp_secretValue' } };

  test('reports a failing status with the request, status, and duration', async () => {
    const client = new LoggingHttpClient(respondWith(404));

    await client.fetch(request);

    assert.strictEqual(warnLines().length, 1);
    const line = warnLines()[0];
    assert.ok(line.includes('GET raw.githubusercontent.com/Amadeus-xDLC/genai.prompt-registry-config/main/hub-config.yml'));
    assert.ok(line.includes('-> 404'));
    assert.ok(/\(\d+ms\)/.test(line), line);
  });

  test('reports a transport failure with the elapsed time, which reveals a hung socket', async () => {
    const client = new LoggingHttpClient(failWith(new Error('connect ETIMEDOUT 140.82.121.4:443')));

    await assert.rejects(async () => client.fetch(request), /ETIMEDOUT/);

    const line = warnLines()[0];
    assert.ok(line.includes('failed after'));
    assert.ok(line.includes('ETIMEDOUT'));
  });

  test('rethrows the original error so behaviour is unchanged', async () => {
    const boom = new Error('boom');
    const client = new LoggingHttpClient(failWith(boom));

    await assert.rejects(async () => client.fetch(request), (error) => error === boom);
  });

  test('stays silent on success when tracing is off', async () => {
    const client = new LoggingHttpClient(respondWith(200));

    await client.fetch(request);

    assert.deepStrictEqual([...warnLines(), ...debugLines()], []);
  });

  test('reports a successful request when tracing is on', async () => {
    const client = new LoggingHttpClient(respondWith(200), { trace: true });

    await client.fetch(request);

    assert.ok(debugLines()[0].includes('-> 200'));
  });

  test('reports whether credentials were attached, never their value', async () => {
    const withAuth = new LoggingHttpClient(respondWith(403));
    await withAuth.fetch(request);

    const withoutAuth = new LoggingHttpClient(respondWith(403));
    await withoutAuth.fetch({ url: HUB_URL });

    assert.ok(warnLines()[0].includes('auth=yes'));
    assert.ok(warnLines()[1].includes('auth=no'));
    assert.ok(!warnLines().join('\n').includes('ghp_secretValue'));
  });

  test('detects a lower-cased authorization header', async () => {
    const client = new LoggingHttpClient(respondWith(403));

    await client.fetch({ url: HUB_URL, headers: { authorization: 'token ghp_secretValue' } });

    assert.ok(warnLines()[0].includes('auth=yes'));
  });

  test('returns the response unchanged', async () => {
    const client = new LoggingHttpClient(respondWith(200));

    const response = await client.fetch(request);

    assert.strictEqual(response.statusCode, 200);
  });
});
