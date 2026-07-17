/**
 * Tests for `ai-primitives-hub discover`.
 *
 * The command detects project context, searches a primitive index, and
 * returns ranked recommendations. The AI and interactive flags are
 * reserved and currently fail with structured errors.
 * @module test/commands/discover
 */
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Primitive,
} from '@ai-primitives-hub/core';
import {
  PrimitiveIndex,
  saveIndex,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  DiscoverCommand,
} from '../../src/commands/discover';
import {
  runCommand,
} from '../../src/framework';

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

const run = (argv: string[], workspace: string): ReturnType<typeof runCommand> =>
  runCommand(argv, {
    commandClasses: [DiscoverCommand],
    context: {
      cwd: workspace,
      env: {
        HOME: workspace,
        XDG_CACHE_HOME: workspace,
        USERPROFILE: workspace
      }
    }
  });

const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

describe('discover command', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-discover-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const createIndex = (indexPath: string): void => {
    const primitive: Primitive = {
      id: 'ts/prompt',
      bundle: {
        sourceId: 'local',
        sourceType: 'local',
        bundleId: 'ts-bundle',
        bundleVersion: '1.0.0',
        installed: false
      },
      kind: 'prompt',
      title: 'TypeScript prompt',
      description: 'A prompt for TypeScript projects',
      path: 'prompt.md',
      tags: ['typescript'],
      bodyPreview: 'typescript best practices',
      contentHash: 'abc123'
    };

    const idx = PrimitiveIndex.fromPrimitives([primitive]);
    saveIndex(idx, indexPath);
  };

  const writePackageJson = async (): Promise<void> => {
    const pkg = JSON.stringify({ dependencies: { typescript: '5.0.0' } });
    await writeFile(path.join(workspace, 'package.json'), pkg, 'utf8');
  };

  it('returns ranked recommendations from the index', async () => {
    const indexPath = path.join(workspace, 'index.json');
    createIndex(indexPath);
    await writePackageJson();

    const result = await run(['discover', '--index', indexPath], workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Detected Context:');
    expect(result.stdout).toContain('Languages: TypeScript');
    expect(result.stdout).toContain('Recommendations (1):');
    expect(result.stdout).toContain('TypeScript prompt');
  });

  it('returns results as JSON', async () => {
    const indexPath = path.join(workspace, 'index.json');
    createIndex(indexPath);
    await writePackageJson();

    const result = await run(['discover', '--index', indexPath, '-o', 'json'], workspace);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ results: { primitive: { title: string } }[] }>(result.stdout);
    expect(envelope.status).toBe('ok');
    expect(envelope.data.results).toHaveLength(1);
    expect(envelope.data.results[0].primitive.title).toBe('TypeScript prompt');
  });

  it('filters by primitive kind', async () => {
    const indexPath = path.join(workspace, 'index.json');
    createIndex(indexPath);
    await writePackageJson();

    const result = await run(['discover', '--index', indexPath, '-o', 'json', '--kinds', 'prompt'], workspace);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ results: { primitive: { title: string } }[] }>(result.stdout);
    expect(envelope.data.results).toHaveLength(1);
    expect(envelope.data.results[0].primitive.title).toBe('TypeScript prompt');

    const noMatch = await run(['discover', '--index', indexPath, '-o', 'json', '--kinds', 'skill'], workspace);
    expect(noMatch.exitCode).toBe(0);
    const noMatchEnvelope = parseJson<{ results: { primitive: { title: string } }[] }>(noMatch.stdout);
    expect(noMatchEnvelope.data.results).toHaveLength(0);
  });

  it('limits the number of results', async () => {
    const indexPath = path.join(workspace, 'index.json');
    const primitives: Primitive[] = [
      {
        id: 'ts/prompt',
        bundle: { sourceId: 'local', sourceType: 'local', bundleId: 'ts-bundle', bundleVersion: '1.0.0', installed: false },
        kind: 'prompt',
        title: 'TypeScript prompt',
        description: 'First prompt',
        path: 'prompt1.md',
        tags: ['typescript'],
        bodyPreview: 'typescript first',
        contentHash: 'abc1'
      },
      {
        id: 'ts/prompt2',
        bundle: { sourceId: 'local', sourceType: 'local', bundleId: 'ts-bundle', bundleVersion: '1.0.0', installed: false },
        kind: 'prompt',
        title: 'TypeScript second',
        description: 'Second prompt',
        path: 'prompt2.md',
        tags: ['typescript'],
        bodyPreview: 'typescript second',
        contentHash: 'abc2'
      }
    ];
    const idx = PrimitiveIndex.fromPrimitives(primitives);
    saveIndex(idx, indexPath);
    await writePackageJson();

    const result = await run(['discover', '--index', indexPath, '-o', 'json', '--limit', '1'], workspace);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ results: unknown[] }>(result.stdout);
    expect(envelope.data.results.length).toBeLessThanOrEqual(1);
  });

  it('fails when --ai is provided', async () => {
    const result = await run(['discover', '--ai'], workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('USAGE.AI_NOT_IMPLEMENTED');
  });

  it('fails when --interactive is provided', async () => {
    const result = await run(['discover', '--interactive'], workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('USAGE.INTERACTIVE_NOT_IMPLEMENTED');
  });

  it('fails for an invalid index file', async () => {
    const result = await run(['discover', '--index', path.join(workspace, 'missing.json')], workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INDEX.NOT_FOUND');
  });

  it('fails for invalid --kinds values', async () => {
    const indexPath = path.join(workspace, 'index.json');
    createIndex(indexPath);
    await writePackageJson();

    const result = await run(['discover', '--index', indexPath, '--kinds', 'not-a-kind'], workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('USAGE.INVALID_FLAG');
  });

  it('uses the default index path when --index is omitted', async () => {
    const defaultIndexDir = path.join(workspace, 'ai-primitives-hub');
    const defaultIndexPath = path.join(defaultIndexDir, 'primitive-index.json');
    await mkdir(defaultIndexDir, { recursive: true });
    createIndex(defaultIndexPath);
    await writePackageJson();

    const result = await run(['discover'], workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('TypeScript prompt');
  });
});
