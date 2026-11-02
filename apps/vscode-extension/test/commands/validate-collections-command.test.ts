/**
 * ValidateCollectionsCommand: the command palette validator reports the
 * same findings as `ai-primitives-hub collection validate`.
 *
 * The regression table runs the extension's previous collection validator
 * (`SchemaValidator.validateCollection`, kept as the oracle) on each fixture
 * and checks that every error it found is still reported by the command,
 * now with the shared message wording. Unknown properties, which the
 * previous validator rejected, are now reported as warnings.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as sinon from 'sinon';
import {
  SchemaValidator,
} from '../../src/services/schema-validator';
import {
  runValidateCollections,
} from '../helpers/collection-validator-test-helpers';
import {
  rmrfSync,
} from '../helpers/e2e-test-helpers';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'collections-validator');
/** Item files the single-file fixtures reference. */
const SHARED_DIRS = ['prompts', 'instructions', 'chatmodes'];

/** One old-validator error and the message the command must report for it. */
interface Mapping {
  /** Error reported by the old validator. */
  old: string;
  /** Message the command reports, without the `collections/<file>: ` label. */
  new: string;
  /** Compare by prefix (for messages that embed parser output). */
  prefix?: boolean;
}

interface RegressionCase {
  /** Fixture path relative to the collections-validator fixtures. */
  fixture: string;
  mappings: Mapping[];
  /** How the command reports the finding (default: error). */
  severity?: 'warning';
}

/**
 * The command's warning for an unknown property.
 * @param prefix - Location, empty at the root
 * @param key - Unknown property
 * @param allowed - Properties the schema allows there
 * @returns The message, without the `collections/<file>: ` label
 */
const unknownProperty = (prefix: string, key: string, allowed: string): string =>
  `${prefix ? `${prefix}: unknown property` : 'unknown root property'} '${key}' is not in the collection schema; `
  + `remove it or rename it to one of: ${allowed}`;

const KINDS = 'prompt, instruction, chat-mode, agent, skill, plugin, hook, mcp-server, steering, spec, command, rule, output-style, tool, power, knowledge, playbook';

const REGRESSION_TABLE: RegressionCase[] = [
  {
    fixture: 'invalid/invalid-id-spaces.collection.yml',
    mappings: [{ old: '/id: must match pattern "^[a-z0-9-]+$" (expected pattern: ^[a-z0-9-]+$)', new: 'Collection ID must contain only lowercase letters, numbers, and hyphens only' }]
  },
  {
    fixture: 'invalid/invalid-id-uppercase.collection.yml',
    mappings: [{ old: '/id: must match pattern "^[a-z0-9-]+$" (expected pattern: ^[a-z0-9-]+$)', new: 'Collection ID must contain only lowercase letters, numbers, and hyphens only' }]
  },
  {
    fixture: 'invalid/invalid-kind.collection.yml',
    mappings: [{ old: `/items/0/kind: must be equal to one of the allowed values (allowed values: ${KINDS})`, new: `items[0]: Invalid item kind 'unknown-type'. Must be one of: ${KINDS}` }]
  },
  {
    fixture: 'invalid/item-missing-kind.collection.yml',
    mappings: [{ old: 'Missing required field: kind', new: 'items[0]: Missing required field: kind' }]
  },
  {
    fixture: 'invalid/item-missing-path.collection.yml',
    mappings: [{ old: 'Missing required field: path', new: 'items[0]: Missing required field: path' }]
  },
  {
    fixture: 'invalid/missing-description.collection.yml',
    mappings: [{ old: 'Missing required field: description', new: 'Missing required field: description' }]
  },
  {
    fixture: 'invalid/missing-file-ref.collection.yml',
    mappings: [{ old: 'Referenced file not found: prompts/nonexistent.prompt.md', new: 'items[0] referenced file not found: prompts/nonexistent.prompt.md' }]
  },
  {
    fixture: 'invalid/missing-id.collection.yml',
    mappings: [{ old: 'Missing required field: id', new: 'Missing required field: id' }]
  },
  {
    fixture: 'invalid/missing-items.collection.yml',
    mappings: [{ old: 'Missing required field: items', new: 'Missing required field: items (array)' }]
  },
  {
    fixture: 'invalid/missing-name.collection.yml',
    mappings: [{ old: 'Missing required field: name', new: 'Missing required field: name' }]
  },
  {
    fixture: 'invalid/yaml-syntax-error.collection.yml',
    mappings: [{ old: 'Failed to parse YAML: ', new: 'YAML parse error: ', prefix: true }]
  },
  {
    fixture: 'warnings/long-description.collection.yml',
    mappings: [{ old: '/description: must NOT have more than 500 characters (maximum 500 characters)', new: 'description must be at most 500 characters (got 576)' }]
  },
  {
    fixture: 'schema/unknown-root-property.collection.yml',
    mappings: [{
      old: ': has unexpected property \'homepage\'',
      new: unknownProperty('', 'homepage', 'id, name, description, items, mcp, readme, version, author, tags, display')
    }],
    severity: 'warning'
  },
  {
    fixture: 'schema/unknown-item-property.collection.yml',
    mappings: [{ old: '/items/0: has unexpected property \'name\'', new: unknownProperty('items[0]', 'name', 'path, kind, title, description, tags') }],
    severity: 'warning'
  },
  {
    fixture: 'schema/item-title-not-string.collection.yml',
    mappings: [{ old: '/items/0/title: must be string', new: 'items[0]: title must be a string' }]
  },
  {
    fixture: 'schema/item-tags-not-strings.collection.yml',
    mappings: [{ old: '/items/0/tags/0: must be string', new: 'items[0]: tags must be an array of strings' }]
  },
  {
    fixture: 'schema/author-not-string.collection.yml',
    mappings: [{ old: '/author: must be string', new: 'author must be a string' }]
  },
  {
    fixture: 'schema/tags-not-array.collection.yml',
    mappings: [{ old: '/tags: must be array', new: 'tags must be an array' }]
  },
  {
    fixture: 'schema/tag-not-string.collection.yml',
    mappings: [{ old: '/tags/1: must be string', new: 'tags[1] must be a string' }]
  },
  {
    fixture: 'schema/long-name.collection.yml',
    mappings: [{ old: '/name: must NOT have more than 100 characters (maximum 100 characters)', new: 'name must be at most 100 characters (got 101)' }]
  },
  {
    fixture: 'schema/display-bad-ordering.collection.yml',
    mappings: [{
      old: '/display/ordering: must be equal to one of the allowed values (allowed values: manual, alphabetical)',
      new: 'display: Invalid ordering \'newest\'. Must be one of: manual, alphabetical'
    }]
  },
  {
    fixture: 'schema/display-show-badge-not-boolean.collection.yml',
    mappings: [{ old: '/display/show_badge: must be boolean', new: 'display: show_badge must be a boolean' }]
  },
  {
    fixture: 'schema/display-unknown-property.collection.yml',
    mappings: [{ old: '/display: has unexpected property \'theme\'', new: unknownProperty('display', 'theme', 'color, icon, ordering, show_badge') }],
    severity: 'warning'
  },
  {
    fixture: 'schema/mcp-unknown-property.collection.yml',
    mappings: [{ old: '/mcp: has unexpected property \'servers\'', new: unknownProperty('mcp', 'servers', 'items, inputs') }],
    severity: 'warning'
  },
  {
    fixture: 'schema/mcp-invalid-server-name.collection.yml',
    mappings: [{ old: '/mcp/items: has unexpected property \'bad name\'', new: 'mcp.items: invalid server name \'bad name\' (letters, digits, \'_\' and \'-\' only)' }]
  },
  {
    fixture: 'schema/mcp-unknown-server-property.collection.yml',
    mappings: [{
      old: '/mcp/items/demo-server: has unexpected property \'description\'',
      new: unknownProperty('mcp.items.demo-server', 'description', 'type, command, args, env, envFile, url, headers, disabled')
    }],
    severity: 'warning'
  },
  {
    fixture: 'schema/mcp-stdio-missing-command.collection.yml',
    mappings: [
      { old: 'Missing required field: command', new: 'mcp.items.demo-server: Missing required field: command' },
      { old: '/mcp/items/demo-server: must match "then" schema', new: 'mcp.items.demo-server: Missing required field: command' }
    ]
  },
  {
    fixture: 'schema/mcp-http-missing-url.collection.yml',
    mappings: [
      { old: 'Missing required field: url', new: 'mcp.items.demo-server: Missing required field: url' },
      { old: '/mcp/items/demo-server: must match "then" schema', new: 'mcp.items.demo-server: Missing required field: url' }
    ]
  },
  {
    fixture: 'schema/mcp-bad-server-type.collection.yml',
    mappings: [{
      old: '/mcp/items/demo-server/type: must be equal to one of the allowed values (allowed values: stdio, http, sse)',
      new: 'mcp.items.demo-server: Invalid type \'websocket\'. Must be one of: stdio, http, sse'
    }]
  },
  {
    fixture: 'schema/mcp-input-bad-type.collection.yml',
    mappings: [{
      old: '/mcp/inputs/0/type: must be equal to one of the allowed values (allowed values: promptString, pickString, command)',
      new: 'mcp.inputs[0]: Invalid type \'secret\'. Must be one of: promptString, pickString, command'
    }]
  },
  {
    fixture: 'schema/mcp-input-bad-id.collection.yml',
    mappings: [{ old: '/mcp/inputs/0/id: must match pattern "^[a-zA-Z0-9_-]+$" (expected pattern: ^[a-zA-Z0-9_-]+$)', new: 'mcp.inputs[0]: id must contain only letters, digits, \'_\' and \'-\'' }]
  },
  {
    fixture: 'schema/mcp-input-missing-type.collection.yml',
    mappings: [{ old: 'Missing required field: type', new: 'mcp.inputs[0]: Missing required field: type' }]
  }
];

/**
 * Create a temporary workspace holding the shared item files and the given
 * collection fixtures under `collections/`.
 * @param tempDirs - Directories to remove in teardown
 * @param fixtures - Fixture paths relative to FIXTURES, with optional target names
 * @returns The workspace directory
 */
function createWorkspace(tempDirs: string[], fixtures: { fixture: string; as?: string }[]): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-collections-'));
  tempDirs.push(workspaceDir);
  for (const dir of SHARED_DIRS) {
    fs.cpSync(path.join(FIXTURES, dir), path.join(workspaceDir, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(workspaceDir, 'collections'));
  for (const { fixture, as } of fixtures) {
    fs.copyFileSync(path.join(FIXTURES, fixture), path.join(workspaceDir, 'collections', as ?? path.basename(fixture)));
  }
  return workspaceDir;
}

/**
 * Errors reported by the extension's previous collection validation for a
 * fixture: YAML parse failure, else `SchemaValidator.validateCollection`.
 * @param fixture - Fixture path relative to FIXTURES
 * @param workspaceRoot - Workspace used to resolve file references
 * @returns The old validator's errors
 */
async function oldValidatorErrors(fixture: string, workspaceRoot: string): Promise<string[]> {
  let data: unknown;
  try {
    data = yaml.load(fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'));
  } catch (error) {
    return [`Failed to parse YAML: ${(error as Error).message}`];
  }

  const result = await new SchemaValidator(process.cwd()).validateCollection(data, { checkFileReferences: true, workspaceRoot });
  return result.errors;
}

const matches = (actual: string, expected: string, prefix?: boolean): boolean =>
  prefix ? actual.startsWith(expected) : actual === expected;

suite('ValidateCollectionsCommand', () => {
  const sandbox = sinon.createSandbox();
  const tempDirs: string[] = [];

  teardown(() => {
    sandbox.restore();
    for (const dir of tempDirs.splice(0)) {
      rmrfSync(dir);
    }
  });

  suite('regression: every finding of the previous validator is still reported', () => {
    for (const { fixture, mappings, severity } of REGRESSION_TABLE) {
      test(fixture, async () => {
        const workspaceDir = createWorkspace(tempDirs, [{ fixture }]);
        const label = `collections/${path.basename(fixture)}`;

        const oldErrors = await oldValidatorErrors(fixture, workspaceDir);
        assert.ok(oldErrors.length > 0, `the previous validator reports no error for ${fixture}`);
        for (const oldError of oldErrors) {
          assert.ok(
            mappings.some((mapping) => matches(oldError, mapping.old, mapping.prefix)),
            `unmapped previous-validator error for ${fixture}: ${oldError}`
          );
        }
        for (const mapping of mappings) {
          assert.ok(
            oldErrors.some((oldError) => matches(oldError, mapping.old, mapping.prefix)),
            `the previous validator no longer reports '${mapping.old}' for ${fixture}: ${JSON.stringify(oldErrors)}`
          );
        }

        const run = await runValidateCollections(sandbox, workspaceDir);
        const expected = [...new Set(mappings.map((mapping) => `${label}: ${mapping.new}`))];
        if (severity === 'warning') {
          assert.deepStrictEqual(run.errors, []);
          for (const message of expected) {
            assert.ok(run.warnings.includes(message), `missing '${message}' in ${JSON.stringify(run.warnings)}`);
          }
          assert.deepStrictEqual(run.errorNotifications, []);
          assert.deepStrictEqual(run.warningNotifications, [`Validation complete with ${run.warnings.length} warning(s)`]);
          assert.ok(run.lines.some((line) => line.includes('Valid: 1')), run.lines.join('\n'));
          return;
        }
        assert.strictEqual(run.errors.length, expected.length, `errors: ${JSON.stringify(run.errors)}`);
        for (const message of expected) {
          const prefix = mappings.some((mapping) => mapping.prefix === true && `${label}: ${mapping.new}` === message);
          assert.ok(
            run.errors.some((error) => matches(error, message, prefix)),
            `missing '${message}' in ${JSON.stringify(run.errors)}`
          );
        }
        assert.deepStrictEqual(run.errorNotifications, [`Validation failed with ${expected.length} error(s)`]);
      });
    }

    test('warnings/many-tags.collection.yml', async () => {
      const fixture = 'warnings/many-tags.collection.yml';
      const tags = (yaml.load(fs.readFileSync(path.join(FIXTURES, fixture), 'utf8')) as { tags: string[] }).tags;
      assert.ok(tags.length > 10, 'the fixture has more than 10 tags');
      const workspaceDir = createWorkspace(tempDirs, [{ fixture }]);

      const run = await runValidateCollections(sandbox, workspaceDir);

      assert.deepStrictEqual(run.errors, []);
      assert.ok(
        run.warnings.includes('collections/many-tags.collection.yml: More than 10 tags (recommended max)'),
        `warnings: ${JSON.stringify(run.warnings)}`
      );
    });
  });

  test('reports the Agent Plugin manifest errors of a plugin item', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-collections-plugin-'));
    tempDirs.push(workspaceDir);
    fs.cpSync(path.join(FIXTURES, 'plugin'), workspaceDir, { recursive: true });
    const prefix = 'collections/demo-invalid.collection.yml: items[0] plugin plugins/demo-invalid/plugin.json: ';

    const run = await runValidateCollections(sandbox, workspaceDir);

    assert.deepStrictEqual(run.errors, [
      `${prefix}"name" must be 1-64 characters of lowercase letters, digits, "." or "-", start and end with a letter or digit, and contain no "--" or ".." (got "Not_Valid Name")`,
      `${prefix}"author" must be an object with optional string fields "name", "email", "url" (got a string)`,
      `${prefix}plugin name "Not_Valid Name" must match its directory "demo-invalid" (AI Primitives Hub packaging rule: `
      + 'the plugin root is the directory that contains plugin.json, and it is bundled and installed under that directory name). '
      + 'Rename the directory or the "name" field, and keep plugin.json at the plugin root'
    ]);
    assert.deepStrictEqual(run.errorNotifications, ['Validation failed with 3 error(s)']);
  });

  test('reports duplicate collection ids and names once under the cross-collection heading', async () => {
    const workspaceDir = createWorkspace(tempDirs, [
      { fixture: 'valid/good.collection.yml', as: 'a.collection.yml' },
      { fixture: 'valid/good.collection.yml', as: 'b.collection.yml' }
    ]);
    const duplicateId = 'collections/b.collection.yml: Duplicate collection ID \'test-collection\' (also in collections/a.collection.yml)';
    const duplicateName = 'collections/b.collection.yml: Duplicate collection name \'Test Collection\' (also in collections/a.collection.yml)';

    const run = await runValidateCollections(sandbox, workspaceDir);

    assert.deepStrictEqual(run.errors, [duplicateId, duplicateName]);
    const heading = run.lines.findIndex((line) => line.includes('Cross-collection errors:'));
    assert.ok(heading !== -1, `no cross-collection heading in ${JSON.stringify(run.lines)}`);
    const idLine = run.lines.findIndex((line) => line.endsWith(duplicateId));
    const nameLine = run.lines.findIndex((line) => line.endsWith(duplicateName));
    assert.ok(idLine > heading && nameLine > heading, 'duplicate errors are printed under the heading');
    assert.ok(run.lines.some((line) => line.includes('Errors: 2')), 'the summary counts the duplicate errors');
    assert.deepStrictEqual(run.errorNotifications, ['Validation failed with 2 error(s)']);
  });

  test('lists name, id, description, item count and tags in list-only mode', async () => {
    const workspaceDir = createWorkspace(tempDirs, [{ fixture: 'valid/good.collection.yml' }]);

    const run = await runValidateCollections(sandbox, workspaceDir, { listOnly: true });

    const output = run.lines.join('\n');
    assert.ok(output.includes('📦 Test Collection (id: test-collection)'), output);
    assert.ok(output.includes('Description: A valid test collection for unit tests'), output);
    assert.ok(output.includes('Items: 3'), output);
    assert.ok(output.includes('Tags: testing, validation'), output);
    assert.deepStrictEqual(run.errorNotifications, []);
  });

  test('reports no errors for a valid collection', async () => {
    const workspaceDir = createWorkspace(tempDirs, [{ fixture: 'valid/good.collection.yml' }]);

    const run = await runValidateCollections(sandbox, workspaceDir);

    assert.deepStrictEqual(run.errors, []);
    assert.deepStrictEqual(run.errorNotifications, []);
    assert.ok(run.lines.some((line) => line.includes('Valid: 1')), run.lines.join('\n'));
  });

  test('reports no errors for a collection with more than 50 items', async () => {
    const workspaceDir = createWorkspace(tempDirs, [{ fixture: 'valid/many-items.collection.yml' }]);

    const run = await runValidateCollections(sandbox, workspaceDir);

    assert.deepStrictEqual(run.errors, []);
    assert.deepStrictEqual(run.errorNotifications, []);
    assert.ok(run.lines.some((line) => line.includes('Valid: 1')), run.lines.join('\n'));
  });
});
