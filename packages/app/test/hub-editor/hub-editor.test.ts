/**
 * Unit tests for HubConfigEditorService and HubContributionWorkflowService.
 */
import * as path from 'node:path';
import type {
  Clock,
  GitHubCollaborationPort,
  GitWorkspacePort,
  HttpClient,
  HubConfig,
  ProcessRunner,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  consolidateSourceCatalog,
  HubConfigEditorService,
} from '../../src/hub-editor/hub-config-editor-service';
import {
  HubContributionWorkflowService,
} from '../../src/hub-editor/hub-contribution-workflow';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const SAMPLE_YAML = `# yaml-language-server: $schema=https://raw.githubusercontent.com/AmadeusITGroup/prompt-registry/refs/heads/main/schemas/hub-config.schema.json
version: 1.0.0
metadata:
  name: Community Hub
  description: Community AI Primitives Hub
  maintainer: Hub Team
  updatedAt: "2026-10-20T00:00:00.000Z"
sources:
  - id: local-source
    name: Local Source
    type: local
    url: /registry
    enabled: true
    priority: 10
profiles:
  # Roles
  - id: backend-dev
    name: Backend Developer
    description: Backend engineering tools
    icon: "⚙️"
    path: ["Roles"]
    bundles:
      - id: existing-bundle
        version: latest
        source: local-source
        required: true
`;

const clock: Clock = {
  now: () => 1_761_350_400_000,
  nowIso: () => '2026-10-25T00:00:00.000Z'
};

const noopHttp: HttpClient = {
  fetch: () => Promise.reject(new Error('No network in unit test'))
};

const noopProcess: ProcessRunner = {
  exec: () => Promise.reject(new Error('No process in unit test'))
};

describe('HubConfigEditorService', () => {
  it('inspects, mutates, and deep-validates hub-config.yml with range-mapped diagnostics and cached catalogs', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/existing-bundle/deployment-manifest.yml', `id: existing-bundle
name: Existing Bundle
version: 1.2.0
description: Existing bundle
author: Test
`);
    fs.seed('/workspace/hub-config.yml', SAMPLE_YAML);

    const service = new HubConfigEditorService();
    const initial = service.inspectDocument(SAMPLE_YAML);
    expect(initial.valid).toBe(true);
    expect(initial.profileCategories).toHaveLength(1);
    expect(initial.profileCategories[0].category).toBe('Roles');

    // Deep validate and verify catalog caching + inline version resolution
    const deepInspection = await service.validateDeep(fs, '/workspace/hub-config.yml', SAMPLE_YAML, {
      sourceAdapterDeps: {
        fs,
        clock,
        httpClient: noopHttp,
        processRunner: noopProcess,
        fallbackTokenProviders: []
      }
    });
    expect(deepInspection.valid).toBe(true);
    expect(deepInspection.catalogsBySourceId['local-source']).toEqual([
      { id: 'existing-bundle', version: '1.2.0', versions: ['1.2.0'] }
    ]);

    // Add a profile referencing a non-existent bundle and verify deep diagnostic range
    const mutated = service.applyMutation(SAMPLE_YAML, {
      kind: 'add-profile-bundle',
      profileIndex: 0,
      bundle: {
        id: 'missing-bundle',
        version: 'latest',
        source: 'local-source',
        required: true
      },
      updatedAt: '2026-10-25T00:00:00.000Z'
    });
    await fs.writeFile('/workspace/hub-config.yml', mutated.updatedContent);

    const failedDeep = await service.validateDeep(fs, '/workspace/hub-config.yml', mutated.updatedContent, {
      sourceAdapterDeps: {
        fs,
        clock,
        httpClient: noopHttp,
        processRunner: noopProcess,
        fallbackTokenProviders: []
      }
    });
    expect(failedDeep.valid).toBe(false);
    const missingDiag = failedDeep.diagnostics.find((d) => d.code === 'HUB_BUNDLE_NOT_FOUND');
    expect(missingDiag).toBeDefined();
    expect(missingDiag?.range?.startLine).toBeGreaterThan(0);
  });

  it('consolidates multi-version GitHub catalog bundles into unique versionless bundle IDs with sorted version lists', () => {
    const githubSource = {
      id: 'task-driven-workflow',
      name: 'Task driven workflow',
      type: 'github' as const,
      url: 'https://github.com/amadeus-airlines-solutions/workflow-instructions',
      enabled: true,
      priority: 10
    };

    const consolidated = consolidateSourceCatalog(githubSource, [
      { id: 'amadeus-airlines-solutions-workflow-instructions-agents-md-creator-1.0.0', version: '1.0.0' },
      { id: 'amadeus-airlines-solutions-workflow-instructions-agents-md-creator-1.0.1', version: '1.0.1' },
      { id: 'amadeus-airlines-solutions-workflow-instructions-foursight-code-assessment-1.0.0', version: '1.0.0' },
      { id: 'amadeus-airlines-solutions-workflow-instructions-foursight-code-assessment-1.0.2', version: '1.0.2' },
      { id: 'amadeus-airlines-solutions-workflow-instructions-foursight-code-assessment-1.0.1', version: '1.0.1' }
    ]);

    expect(consolidated).toEqual([
      {
        id: 'amadeus-airlines-solutions-workflow-instructions-agents-md-creator',
        version: '1.0.1',
        versions: ['1.0.1', '1.0.0']
      },
      {
        id: 'amadeus-airlines-solutions-workflow-instructions-foursight-code-assessment',
        version: '1.0.2',
        versions: ['1.0.2', '1.0.1', '1.0.0']
      }
    ]);

    const skillsSource = {
      id: 'awesome-copilot-skills',
      name: 'Awesome Copilot Skills',
      type: 'skills' as const,
      url: 'https://github.com/github/awesome-copilot/skills',
      enabled: true,
      priority: 10
    };

    const consolidatedSkills = consolidateSourceCatalog(skillsSource, [
      { id: 'skills-github-awesome-copilot-webapp-testing', version: 'hash:abcdef123456' }
    ]);

    expect(consolidatedSkills).toEqual([
      {
        id: 'skills-github-awesome-copilot-webapp-testing',
        version: 'latest',
        versions: []
      }
    ]);
  });
});

describe('HubContributionWorkflowService', () => {
  const sampleConfig: HubConfig = {
    version: '1.0.0',
    metadata: {
      name: 'Community Hub',
      description: 'Community Hub',
      maintainer: 'Team',
      updatedAt: '2026-10-20T00:00:00.000Z'
    },
    sources: [],
    profiles: []
  };

  it('strictly rejects Artifactory hubs as read-only replicas and qualifies GitHub hubs', async () => {
    const fs = new InMemoryFileSystem();
    const githubMock: GitHubCollaborationPort = {
      getAuthenticatedUser: () => Promise.resolve({ login: 'dev-user', htmlUrl: 'https://github.com/dev-user' }),
      getRepository: () => Promise.resolve({
        owner: 'AmadeusITGroup',
        name: 'prompt-registry-config',
        fullName: 'AmadeusITGroup/prompt-registry-config',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/AmadeusITGroup/prompt-registry-config',
        cloneUrl: 'https://github.com/AmadeusITGroup/prompt-registry-config.git',
        sshUrl: 'git@github.com:AmadeusITGroup/prompt-registry-config.git',
        fork: false
      }),
      ensureFork: () => Promise.resolve({
        owner: 'dev-user',
        name: 'prompt-registry-config',
        fullName: 'dev-user/prompt-registry-config',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/dev-user/prompt-registry-config',
        cloneUrl: 'https://github.com/dev-user/prompt-registry-config.git',
        sshUrl: 'git@github.com:dev-user/prompt-registry-config.git',
        upstreamFullName: 'AmadeusITGroup/prompt-registry-config'
      }),
      createPullRequest: () => Promise.resolve({
        number: 7,
        title: 'feat(hub): add source',
        htmlUrl: 'https://github.com/AmadeusITGroup/prompt-registry-config/pull/7',
        state: 'open',
        draft: false,
        headRef: 'feat/contribute',
        baseRef: 'main',
        upstreamFullName: 'AmadeusITGroup/prompt-registry-config',
        updatedAt: '2026-10-25T00:00:00.000Z'
      }),
      findPullRequestsForBranch: () => Promise.resolve([]),
      getPullRequestStatus: () => Promise.resolve({
        number: 7,
        title: 'feat(hub): add source',
        htmlUrl: 'https://github.com/AmadeusITGroup/prompt-registry-config/pull/7',
        state: 'open',
        draft: false,
        headRef: 'feat/contribute',
        baseRef: 'main',
        upstreamFullName: 'AmadeusITGroup/prompt-registry-config',
        updatedAt: '2026-10-25T00:00:00.000Z',
        checks: { state: 'success', totalCount: 1, passingCount: 1, failingCount: 0, pendingCount: 0 }
      })
    };

    const gitMock: GitWorkspacePort = {
      isGitRepository: () => Promise.resolve(false),
      cloneRepository: async (_url, targetDir) => {
        await fs.writeFile(path.join(targetDir, 'hub-config.yml'), SAMPLE_YAML);
      },
      getRemotes: () => Promise.resolve({
        origin: 'https://github.com/dev-user/prompt-registry-config.git',
        upstream: 'https://github.com/AmadeusITGroup/prompt-registry-config.git'
      }),
      ensureRemote: () => Promise.resolve(),
      getCurrentBranch: () => Promise.resolve('feat/contribute'),
      fetchRemote: () => Promise.resolve(),
      checkoutBranch: () => Promise.resolve(),
      getStatus: () => Promise.resolve({
        isGitRepo: true,
        currentBranch: 'feat/contribute',
        remotes: {
          origin: 'https://github.com/dev-user/prompt-registry-config.git',
          upstream: 'https://github.com/AmadeusITGroup/prompt-registry-config.git'
        },
        modifiedFiles: ['hub-config.yml'],
        hasUncommittedChanges: true
      }),
      getFileAtRef: () => Promise.resolve(SAMPLE_YAML),
      commitAndPush: () => Promise.resolve({ commitSha: 'abc1234' })
    };

    const workflow = new HubContributionWorkflowService({
      fs,
      clock,
      github: githubMock,
      git: gitMock,
      sessionStorePath: '/storage/hub-contribution-sessions.json'
    });

    // Artifactory hub MUST be rejected as read-only
    const artifactoryEligibility = await workflow.evaluateHubForContribution({
      id: 'corp-artifactory-hub',
      config: sampleConfig,
      reference: {
        type: 'artifactory',
        location: 'https://artifactory.corp.example/artifactory/ai-hub'
      }
    });
    expect(artifactoryEligibility.contributable).toBe(false);
    expect(artifactoryEligibility.reason).toContain('Artifactory');
    expect(artifactoryEligibility.reason).toContain('read-only');

    await expect(workflow.bootstrapContributionWorkspace({
      hubId: 'corp-artifactory-hub',
      hubName: 'Corp Hub',
      hubReference: {
        type: 'artifactory',
        location: 'https://artifactory.corp.example/artifactory/ai-hub'
      },
      targetDir: '/clones/corp-hub',
      branchName: 'feat/contribute'
    })).rejects.toThrow(/Artifactory.*read-only/i);

    // GitHub hub succeeds through Fork -> Clone -> Branch -> Session persistence -> PR submission
    const session = await workflow.bootstrapContributionWorkspace({
      hubId: 'community-hub',
      hubName: 'Community Hub',
      hubReference: {
        type: 'github',
        location: 'AmadeusITGroup/prompt-registry-config',
        ref: 'main'
      },
      targetDir: '/clones/prompt-registry-config',
      branchName: 'feat/contribute'
    });

    expect(session.upstreamSlug).toBe('AmadeusITGroup/prompt-registry-config');
    expect(session.forkSlug).toBe('dev-user/prompt-registry-config');
    expect(session.hubConfigPath).toBe(path.join('/clones/prompt-registry-config', 'hub-config.yml'));

    const pr = await workflow.submitPullRequest({
      workspaceDir: '/clones/prompt-registry-config',
      commitMessage: 'feat(hub): add source',
      prTitle: 'feat(hub): add source',
      prBody: 'Added source'
    });
    expect(pr.number).toBe(7);

    const refreshed = await workflow.refreshPullRequestStatus('/clones/prompt-registry-config');
    expect(refreshed?.checks?.state).toBe('success');

    // When the tracked PR is subsequently closed on GitHub, refreshPullRequestStatus and
    // getWorkspaceContributionContext clear it so closed PRs are not tracked in the editor
    githubMock.getPullRequestStatus = () => Promise.resolve({
      number: 7,
      title: 'feat(hub): add source',
      htmlUrl: 'https://github.com/AmadeusITGroup/prompt-registry-config/pull/7',
      state: 'closed',
      draft: false,
      headRef: 'feat/contribute',
      baseRef: 'main',
      upstreamFullName: 'AmadeusITGroup/prompt-registry-config',
      updatedAt: '2026-10-26T00:00:00.000Z'
    });

    const closedRefresh = await workflow.refreshPullRequestStatus('/clones/prompt-registry-config');
    expect(closedRefresh).toBeUndefined();

    const afterClosedContext = await workflow.getWorkspaceContributionContext('/clones/prompt-registry-config');
    expect(afterClosedContext.session?.pullRequest).toBeUndefined();
  });
});
