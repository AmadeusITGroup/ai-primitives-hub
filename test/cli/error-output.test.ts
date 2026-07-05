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

suite('CLI error output', () => {
  test('main writes invalid output-flag errors to stderr and returns exit code 1', async () => {
    const cli = await loadCliMainModule();
    const streams = createCapturedStreams();

    const exitCode = await cli.main(['inspect', 'example-bundle', '--output', 'yaml'], streams);

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(streams.stdout.captured, '');
    assert.strictEqual(streams.stderr.captured, 'The --output flag requires either "text" or "json".\n');
  });

  test('main requires install targets and reports the error on stderr', async () => {
    const cli = await loadCliMainModule();
    const streams = createCapturedStreams();
    const fixtureBundlePath = path.join(process.cwd(), 'test', 'fixtures', 'local-library', 'example-bundle');

    const exitCode = await cli.main(['install', fixtureBundlePath], streams);

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(streams.stdout.captured, '');
    assert.strictEqual(streams.stderr.captured, 'install: --target <type> is required\n');
  });

  test('main rejects unsupported install targets with actionable stderr output', async () => {
    const cli = await loadCliMainModule();
    const streams = createCapturedStreams();
    const fixtureBundlePath = path.join(process.cwd(), 'test', 'fixtures', 'local-library', 'example-bundle');

    const exitCode = await cli.main(['install', fixtureBundlePath, '--target', 'eclipse'], streams);

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(streams.stdout.captured, '');
    assert.strictEqual(
      streams.stderr.captured,
      'install: unsupported target type "eclipse". Supported targets: vscode, vscode-insiders, copilot-cli, kiro, windsurf, claude-code.\n'
    );
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
