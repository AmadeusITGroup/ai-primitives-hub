/**
 * Unit tests for CollectionEditorService and CollectionContributionWorkflowService.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Clock,
  GitHubCollaborationPort,
  GitWorkspacePort,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  CollectionContributionWorkflowService,
} from '../../src/collection-editor/collection-contribution-workflow';
import {
  CollectionEditorService,
} from '../../src/collection-editor/collection-editor-service';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const clock: Clock = {
  now: () => 1_761_350_400_000,
  nowIso: () => '2026-10-28T00:00:00.000Z'
};

describe('CollectionEditorService', () => {
  let tmpDir: string;
  let service: CollectionEditorService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-col-editor-'));
    service = new CollectionEditorService();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates, duplicates, inspects, scaffolds primitives, and edits primitive frontmatter + content', async () => {
    // 1. Create a new collection visually
    const created = service.createCollectionFile(tmpDir, {
      id: 'python-engineering',
      name: 'Python Engineering Suite',
      description: 'Prompts and skills for Python developers',
      author: 'Platform Team',
      tags: ['python', 'backend'],
      createReadme: true
    });

    expect(created.inspection.valid).toBe(true);
    expect(created.inspection.readmeExists).toBe(true);
    expect(fs.existsSync(created.filePath)).toBe(true);

    // 2. Scaffold a new prompt primitive and automatically link it into the collection
    const scaffoldedPrompt = await service.scaffoldPrimitiveForCollection(
      tmpDir,
      created.content,
      {
        kind: 'prompt',
        name: 'Write Pytest Unit Tests',
        description: 'Generates idiomatic pytest suites',
        tools: ['grep', 'view'],
        body: '# Pytest Generator\n\nWrite clean unit tests.'
      },
      { filePath: created.filePath }
    );
    fs.writeFileSync(created.filePath, scaffoldedPrompt.updatedCollectionContent, 'utf8');
    expect(scaffoldedPrompt.createdFileRelPath).toBe('prompts/write-pytest-unit-tests.prompt.md');
    expect(scaffoldedPrompt.inspection.valid).toBe(true);
    expect(scaffoldedPrompt.inspection.itemStatuses).toHaveLength(1);
    expect(scaffoldedPrompt.inspection.itemStatuses[0].exists).toBe(true);

    // 3. Visually read & update the primitive's frontmatter and Markdown body
    const readContent = service.readPrimitiveContent(tmpDir, 'prompts/write-pytest-unit-tests.prompt.md', 'prompt');
    expect(readContent.exists).toBe(true);
    expect(readContent.frontmatter.description).toBe('Generates idiomatic pytest suites');
    expect(readContent.body).toContain('# Pytest Generator');

    const updatedPrimitive = service.writePrimitiveContent(
      tmpDir,
      'prompts/write-pytest-unit-tests.prompt.md',
      {
        kind: 'prompt',
        frontmatter: {
          ...readContent.frontmatter,
          description: 'Updated pytest generator description',
          model: 'gpt-4o'
        },
        body: '# Updated Pytest Generator\n\nUse fixtures and parametrize.'
      }
    );
    expect(updatedPrimitive.frontmatter.description).toBe('Updated pytest generator description');
    expect(updatedPrimitive.frontmatter.model).toBe('gpt-4o');
    expect(updatedPrimitive.body).toContain('Use fixtures and parametrize.');

    // 4. Scaffold an Agent Plugin and link it
    const scaffoldedPlugin = await service.scaffoldPrimitiveForCollection(
      tmpDir,
      scaffoldedPrompt.updatedCollectionContent,
      {
        kind: 'plugin',
        name: 'python-helper',
        description: 'Python helper plugin',
        author: 'Platform Team'
      },
      { filePath: created.filePath }
    );
    fs.writeFileSync(created.filePath, scaffoldedPlugin.updatedCollectionContent, 'utf8');
    expect(scaffoldedPlugin.createdFileRelPath).toBe('plugins/python-helper/plugin.json');
    expect(scaffoldedPlugin.inspection.valid).toBe(true);

    // 5. Duplicate collection and detect workspace collections
    const duplicated = service.duplicateCollectionFile(
      tmpDir,
      created.filePath,
      'python-advanced',
      'Python Advanced Suite'
    );
    expect(duplicated.inspection.valid).toBe(true);

    const overview = service.detectWorkspaceCollections(tmpDir);
    expect(overview.collections).toHaveLength(2);
    expect(overview.valid).toBe(true);

    // 6. Preserve plugin author.email/url and malformed rawFrontmatter on body save
    service.writePrimitiveContent(tmpDir, 'plugins/python-helper/plugin.json', {
      kind: 'plugin',
      pluginManifest: {
        author: { name: 'Platform Team', email: 'team@example.com', url: 'https://example.com' }
      }
    });
    const updatedPlugin = service.writePrimitiveContent(tmpDir, 'plugins/python-helper/plugin.json', {
      kind: 'plugin',
      pluginManifest: {
        description: 'Updated plugin description',
        author: { name: 'New Lead' }
      }
    });
    expect(updatedPlugin.pluginManifest?.author).toEqual({
      name: 'New Lead',
      email: 'team@example.com',
      url: 'https://example.com'
    });

    const malformedPromptPath = path.join(tmpDir, 'prompts', 'malformed.prompt.md');
    fs.writeFileSync(malformedPromptPath, '---\nname: [unterminated\n---\n\nOriginal body\n', 'utf8');
    const savedMalformed = service.writePrimitiveContent(tmpDir, 'prompts/malformed.prompt.md', {
      kind: 'prompt',
      body: 'Edited body content'
    });
    expect(savedMalformed.rawContent).toContain('name: [unterminated');
    expect(savedMalformed.body).toContain('Edited body content');

    // 7. Reject path traversal or non-collection files in deleteCollectionFile
    expect(() => service.deleteCollectionFile(tmpDir, '../outside.collection.yml')).toThrow(/outside the workspace/i);
    expect(() => service.deleteCollectionFile(tmpDir, 'prompts/write-pytest-unit-tests.prompt.md')).toThrow(/not a \.collection\.yml/i);
  });
});

describe('CollectionContributionWorkflowService', () => {
  it('enforces read-only Artifactory guard and orchestrates Fork -> Clone -> Branch -> Multi-file PR submission', async () => {
    const memFs = new InMemoryFileSystem();
    const committedFiles: string[][] = [];

    const mockGitHub: GitHubCollaborationPort = {
      getAuthenticatedUser: () => Promise.resolve({ login: 'contributor', htmlUrl: 'https://github.com/contributor' }),
      getRepository: (owner, repo) => Promise.resolve({
        owner,
        name: repo,
        fullName: `${owner}/${repo}`,
        defaultBranch: 'main',
        htmlUrl: `https://github.com/${owner}/${repo}`,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        sshUrl: `git@github.com:${owner}/${repo}.git`,
        fork: false
      }),
      ensureFork: (owner, repo) => Promise.resolve({
        owner: 'contributor',
        name: repo,
        fullName: `contributor/${repo}`,
        defaultBranch: 'main',
        htmlUrl: `https://github.com/contributor/${repo}`,
        cloneUrl: `https://github.com/contributor/${repo}.git`,
        sshUrl: `git@github.com:contributor/${repo}.git`,
        upstreamFullName: `${owner}/${repo}`
      }),
      createPullRequest: (input) => Promise.resolve({
        number: 101,
        title: input.title,
        htmlUrl: `https://github.com/${input.upstreamOwner}/${input.upstreamRepo}/pull/101`,
        state: 'open',
        draft: Boolean(input.draft),
        headRef: input.head,
        baseRef: input.base,
        upstreamFullName: `${input.upstreamOwner}/${input.upstreamRepo}`,
        updatedAt: '2026-10-28T00:00:00.000Z',
        checks: {
          state: 'success',
          totalCount: 2,
          passingCount: 2,
          failingCount: 0,
          pendingCount: 0
        }
      }),
      findPullRequestsForBranch: () => Promise.resolve([]),
      getPullRequestStatus: (owner, repo, pullNumber) => Promise.resolve({
        number: pullNumber,
        title: 'feat(collection): add 1 item(s) (python-dev)',
        htmlUrl: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
        state: 'open',
        draft: false,
        headRef: 'feat/collection-python-dev',
        baseRef: 'main',
        upstreamFullName: `${owner}/${repo}`,
        updatedAt: '2026-10-28T00:00:00.000Z'
      }),
      resolveAccessibleAccount: () => Promise.resolve({
        selectedAccount: {
          login: 'contributor',
          host: 'github.com',
          active: true,
          state: 'success',
          canAccessHub: true
        },
        accounts: [],
        accessibleAccounts: []
      })
    };

    const mockGit: GitWorkspacePort = {
      isGitRepository: () => Promise.resolve(true),
      cloneRepository: () => Promise.resolve(),
      getRemotes: () => Promise.resolve({
        origin: 'https://github.com/contributor/prompt-collections.git',
        upstream: 'https://github.com/AmadeusITGroup/prompt-collections.git'
      }),
      ensureRemote: () => Promise.resolve(),
      getCurrentBranch: () => Promise.resolve('feat/collection-python-dev'),
      fetchRemote: () => Promise.resolve(),
      checkoutBranch: () => Promise.resolve(),
      getStatus: () => Promise.resolve({
        isGitRepo: true,
        currentBranch: 'feat/collection-python-dev',
        remotes: {
          origin: 'https://github.com/contributor/prompt-collections.git',
          upstream: 'https://github.com/AmadeusITGroup/prompt-collections.git'
        },
        modifiedFiles: [
          'collections/python-dev.collection.yml',
          'prompts/new-helper.prompt.md',
          '.env.local',
          'scratch/notes.txt'
        ],
        hasUncommittedChanges: true
      }),
      getFileAtRef: () => Promise.resolve([
        'id: python-dev',
        'name: Python Dev',
        'description: Python collection',
        'items: []'
      ].join('\n')),
      commitAndPush: (_dir, files) => {
        committedFiles.push(files);
        return Promise.resolve({ commitSha: 'abc1234' });
      }
    };

    const workflow = new CollectionContributionWorkflowService({
      fs: memFs,
      clock,
      github: mockGitHub,
      git: mockGit,
      sessionStorePath: '/storage/collection-sessions.json'
    });

    // Reject Artifactory sources as read-only
    const artifactoryEval = await workflow.evaluateSourceForContribution({
      type: 'artifactory',
      url: 'https://artifactory.example.com/artifactory/ai'
    });
    expect(artifactoryEval.contributable).toBe(false);

    // Seed workspace collection file
    memFs.seed(
      '/work/prompt-collections/collections/python-dev.collection.yml',
      [
        'id: python-dev',
        'name: Python Dev',
        'description: Python collection',
        'readme:',
        '  path: docs/python-dev/README.md',
        'items:',
        '  - path: prompts/new-helper.prompt.md',
        '    kind: prompt'
      ].join('\n')
    );

    const session = await workflow.bootstrapContributionWorkspace({
      source: {
        id: 'gh-collections',
        name: 'Prompt Collections',
        type: 'github',
        url: 'https://github.com/AmadeusITGroup/prompt-collections'
      },
      bundleId: 'AmadeusITGroup-prompt-collections-python-dev-v1.0.0',
      targetDir: '/work/prompt-collections'
    });

    expect(session.collectionId).toBe('python-dev');
    expect(session.branchName).toBe('feat/collection-python-dev');
    expect(session.targetCollectionPath).toBe(
      path.join('/work/prompt-collections', 'collections/python-dev.collection.yml')
    );

    const pr = await workflow.submitPullRequest({
      workspaceDir: '/work/prompt-collections'
    });
    expect(pr.number).toBe(101);
    expect(committedFiles[0]).toEqual([
      'collections/python-dev.collection.yml',
      'prompts/new-helper.prompt.md'
    ]);
  });
});
