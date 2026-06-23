/**
 * Index command tests - verifies CLI options are properly recognized
 * by the class-based command implementations.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  IndexHarvestCommand,
} from '../../src/commands/index-harvest';
import {
  IndexReportCommand,
} from '../../src/commands/index-report';
import {
  IndexSearchCommand,
} from '../../src/commands/index-search';
import {
  IndexShortlistAddCommand,
  IndexShortlistListCommand,
  IndexShortlistNewCommand,
  IndexShortlistRemoveCommand,
} from '../../src/commands/index-shortlist';
import {
  IndexStatsCommand,
} from '../../src/commands/index-stats';
import {
  runCommand,
} from '../../src/framework';
import {
  createNodeFsAdapter,
} from '../helpers/node-fs-adapter';

describe('index commands - CLI option recognition', () => {
  const context = { cwd: '/tmp', fs: createNodeFsAdapter(), env: {} };

  describe('index search', () => {
    it('recognizes --query option', async () => {
      const { stderr } = await runCommand(
        ['index', 'search', '--query', 'test'],
        {
          commandClasses: [IndexSearchCommand],
          context
        }
      );
      // Should not produce "Unsupported option name" error
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --index option', async () => {
      const { stderr } = await runCommand(
        ['index', 'search', '--index', '/tmp/index.json'],
        {
          commandClasses: [IndexSearchCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --kinds option', async () => {
      const { stderr } = await runCommand(
        ['index', 'search', '--kinds', 'prompt'],
        {
          commandClasses: [IndexSearchCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes -o/--output option', async () => {
      const { stderr } = await runCommand(
        ['index', 'search', '-o', 'json'],
        {
          commandClasses: [IndexSearchCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });

  describe('index stats', () => {
    it('recognizes --index option', async () => {
      const { stderr } = await runCommand(
        ['index', 'stats', '--index', '/tmp/index.json'],
        {
          commandClasses: [IndexStatsCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes -o/--output option', async () => {
      const { stderr } = await runCommand(
        ['index', 'stats', '-o', 'json'],
        {
          commandClasses: [IndexStatsCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });

  describe('index harvest', () => {
    it('recognizes --hub-repo option', async () => {
      const { stderr } = await runCommand(
        ['index', 'harvest', '--hub-repo', 'owner/repo'],
        {
          commandClasses: [IndexHarvestCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --hub-config-file option', async () => {
      const { stderr } = await runCommand(
        ['index', 'harvest', '--hub-config-file', '/tmp/hub-config.yml'],
        {
          commandClasses: [IndexHarvestCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes -o/--output option', async () => {
      const { stderr } = await runCommand(
        ['index', 'harvest', '-o', 'json'],
        {
          commandClasses: [IndexHarvestCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });

  describe('index report', () => {
    it('recognizes --hub-repo option', async () => {
      const { stderr } = await runCommand(
        ['index', 'report', '--hub-repo', 'owner/repo'],
        {
          commandClasses: [IndexReportCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --progress-file option', async () => {
      const { stderr } = await runCommand(
        ['index', 'report', '--progress-file', '/tmp/progress.jsonl'],
        {
          commandClasses: [IndexReportCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes -o/--output option', async () => {
      const { stderr } = await runCommand(
        ['index', 'report', '-o', 'json'],
        {
          commandClasses: [IndexReportCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });

  describe('index shortlist new', () => {
    it('recognizes --name option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'new', '--name', 'test-list'],
        {
          commandClasses: [IndexShortlistNewCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --description option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'new', '--name', 'test-list', '--description', 'Test'],
        {
          commandClasses: [IndexShortlistNewCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --index option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'new', '--name', 'test-list', '--index', '/tmp/index.json'],
        {
          commandClasses: [IndexShortlistNewCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });

  describe('index shortlist add', () => {
    it('recognizes --id option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'add', '--id', 'test-list', '--primitive', 'test-id'],
        {
          commandClasses: [IndexShortlistAddCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --primitive option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'add', '--id', 'test-list', '--primitive', 'test-id'],
        {
          commandClasses: [IndexShortlistAddCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });

  describe('index shortlist remove', () => {
    it('recognizes --id option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'remove', '--id', 'test-list', '--primitive', 'test-id'],
        {
          commandClasses: [IndexShortlistRemoveCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes --primitive option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'remove', '--id', 'test-list', '--primitive', 'test-id'],
        {
          commandClasses: [IndexShortlistRemoveCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });

  describe('index shortlist list', () => {
    it('recognizes --index option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'list', '--index', '/tmp/index.json'],
        {
          commandClasses: [IndexShortlistListCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });

    it('recognizes -o/--output option', async () => {
      const { stderr } = await runCommand(
        ['index', 'shortlist', 'list', '-o', 'json'],
        {
          commandClasses: [IndexShortlistListCommand],
          context
        }
      );
      expect(stderr).not.toMatch(/Unsupported option name/);
    });
  });
});
