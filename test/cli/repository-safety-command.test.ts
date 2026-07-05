import * as assert from 'node:assert';
import * as path from 'node:path';

type CliMainModule = {
  main(
    argv?: string[],
    streams?: {
      stderr: { write(chunk: string): boolean | void };
      stdout: { write(chunk: string): boolean | void };
    }
  ): Promise<number>;
};

suite('CLI repository safety command', () => {
  test('main rejects repository installs with redacted diagnostics for unsafe prompts, instructions, agents, and skills', async () => {
    const cli = await loadCliMainModule();
    const streams = createCapturedStreams();
    const fixtureBundlePath = path.join(process.cwd(), 'test', 'fixtures', 'local-library', 'unsafe-repository-bundle');

    const exitCode = await cli.main([
      'install',
      fixtureBundlePath,
      '--target',
      'vscode',
      '--scope',
      'repository'
    ], streams);

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(streams.stdout.captured, '');
    assert.ok(streams.stderr.captured.includes('secret-like-content'));
    assert.ok(streams.stderr.captured.includes('token-review'));
    assert.ok(streams.stderr.captured.includes('password-rules'));
    assert.ok(streams.stderr.captured.includes('planner'));
    assert.ok(streams.stderr.captured.includes('key-auditor'));
    assert.ok(streams.stderr.captured.includes('[REDACTED]'));
    assert.ok(!streams.stderr.captured.includes('super-secret-value'));
    assert.ok(!streams.stderr.captured.includes('abc123'));
  });
});

function createCapturedStreams() {
  const streamState = {
    stderr: '',
    stdout: ''
  };

  return {
    stderr: {
      write: (chunk: string) => {
        streamState.stderr += chunk;
      },
      get captured() {
        return streamState.stderr;
      }
    },
    stdout: {
      write: (chunk: string) => {
        streamState.stdout += chunk;
      },
      get captured() {
        return streamState.stdout;
      }
    }
  };
}

async function loadCliMainModule(): Promise<CliMainModule> {
  return import('../../src/cli/index');
}
