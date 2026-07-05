import * as assert from 'node:assert';

type CliOutputModule = {
  renderJsonOutput<T>(input: {
    command: 'inspect' | 'install' | 'list' | 'validate';
    data: T;
    errors?: {
      code: string;
      message: string;
      resourceId?: string;
    }[];
    meta?: Record<string, unknown>;
    status?: 'error' | 'ok' | 'warning';
    warnings?: string[];
  }): string;
};

suite('CLI JSON output', () => {
  test('renderJsonOutput wraps list results in a stable envelope', async () => {
    const output = await loadCliOutputModule();

    assert.strictEqual(
      output.renderJsonOutput({
        command: 'list',
        data: [
          {
            bundleId: 'example-bundle',
            version: '1.0.0'
          }
        ]
      }),
      '{"schemaVersion":1,"command":"list","status":"ok","data":[{"bundleId":"example-bundle","version":"1.0.0"}],"warnings":[],"errors":[],"meta":{}}'
    );
  });

  test('renderJsonOutput wraps inspect results in a stable envelope', async () => {
    const output = await loadCliOutputModule();

    assert.strictEqual(
      output.renderJsonOutput({
        command: 'inspect',
        data: {
          bundleId: 'example-bundle',
          resources: ['code-review', 'bug-analyzer'],
          version: '1.0.0'
        }
      }),
      '{"schemaVersion":1,"command":"inspect","status":"ok","data":{"bundleId":"example-bundle","resources":["code-review","bug-analyzer"],"version":"1.0.0"},"warnings":[],"errors":[],"meta":{}}'
    );
  });

  test('renderJsonOutput wraps validate results in a stable envelope', async () => {
    const output = await loadCliOutputModule();

    assert.strictEqual(
      output.renderJsonOutput({
        command: 'validate',
        data: {
          diagnostics: [],
          valid: true
        }
      }),
      '{"schemaVersion":1,"command":"validate","status":"ok","data":{"diagnostics":[],"valid":true},"warnings":[],"errors":[],"meta":{}}'
    );
  });

  test('renderJsonOutput wraps install results in a stable envelope', async () => {
    const output = await loadCliOutputModule();
    const expected = [
      '{"schemaVersion":1,"command":"install","status":"ok","data":',
      '{"bundleId":"example-bundle","diagnostics":[],"success":true,',
      '"version":"1.0.0","writtenFiles":[".github/prompts/code-review.prompt.md"]}',
      ',"warnings":[],"errors":[],"meta":{}}'
    ].join('');

    assert.strictEqual(
      output.renderJsonOutput({
        command: 'install',
        data: {
          bundleId: 'example-bundle',
          diagnostics: [],
          success: true,
          version: '1.0.0',
          writtenFiles: ['.github/prompts/code-review.prompt.md']
        }
      }),
      expected
    );
  });
});

async function loadCliOutputModule(): Promise<CliOutputModule> {
  const modulePath = '../../src/cli/output';
  return import(modulePath) as Promise<CliOutputModule>;
}
