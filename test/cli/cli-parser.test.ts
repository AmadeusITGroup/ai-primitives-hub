import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type CliModule = {
  parseCliArguments(argv: string[]): {
    command: 'help' | 'inspect' | 'install' | 'list' | 'uninstall' | 'update' | 'validate';
    options: {
      help: boolean;
      output: 'json' | 'text';
    };
    positionals: string[];
  };
  renderCliHelp(): string;
};

suite('CLI parser', () => {
  test('package.json exposes the prompt-registry bin entrypoint', async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')
    ) as {
      bin?: Record<string, string>;
    };

    assert.strictEqual(packageJson.bin?.['prompt-registry'], './out/cli/index.js');
  });

  test('renderCliHelp lists the supported top-level commands', async () => {
    const cli = await loadCliModule();

    const helpText = cli.renderCliHelp();

    assert.match(helpText, /Usage: prompt-registry <command> \[options\]/);
    assert.match(helpText, /list/);
    assert.match(helpText, /validate/);
    assert.match(helpText, /install/);
    assert.match(helpText, /update/);
    assert.match(helpText, /uninstall/);
    assert.match(helpText, /inspect/);
  });

  test('parseCliArguments parses the list command', async () => {
    const cli = await loadCliModule();

    assert.deepStrictEqual(cli.parseCliArguments(['list']), {
      command: 'list',
      options: {
        help: false,
        output: 'text'
      },
      positionals: []
    });
  });

  test('parseCliArguments parses the validate command', async () => {
    const cli = await loadCliModule();

    assert.deepStrictEqual(cli.parseCliArguments(['validate', 'bundle.tgz']), {
      command: 'validate',
      options: {
        help: false,
        output: 'text'
      },
      positionals: ['bundle.tgz']
    });
  });

  test('parseCliArguments parses the install command', async () => {
    const cli = await loadCliModule();

    assert.deepStrictEqual(cli.parseCliArguments(['install', 'bundle.tgz']), {
      command: 'install',
      options: {
        help: false,
        output: 'text'
      },
      positionals: ['bundle.tgz']
    });
  });

  test('parseCliArguments parses the update command', async () => {
    const cli = await loadCliModule();

    assert.deepStrictEqual(cli.parseCliArguments(['update', 'sample-bundle']), {
      command: 'update',
      options: {
        help: false,
        output: 'text'
      },
      positionals: ['sample-bundle']
    });
  });

  test('parseCliArguments parses the uninstall command', async () => {
    const cli = await loadCliModule();

    assert.deepStrictEqual(cli.parseCliArguments(['uninstall', 'sample-bundle']), {
      command: 'uninstall',
      options: {
        help: false,
        output: 'text'
      },
      positionals: ['sample-bundle']
    });
  });

  test('parseCliArguments parses the inspect command with json output', async () => {
    const cli = await loadCliModule();

    assert.deepStrictEqual(cli.parseCliArguments(['inspect', 'sample-bundle', '--output', 'json']), {
      command: 'inspect',
      options: {
        help: false,
        output: 'json'
      },
      positionals: ['sample-bundle']
    });
  });
});

async function loadCliModule(): Promise<CliModule> {
  const modulePath = path.join(__dirname, '..', '..', 'src', 'cli', 'cli.js');
  return import(modulePath) as Promise<CliModule>;
}
