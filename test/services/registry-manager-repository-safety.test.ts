import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import * as yaml from 'js-yaml';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RepositoryAdapterFactory,
} from '../../src/adapters/repository-adapter';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  Bundle,
  RegistrySource,
} from '../../src/types/registry';
import type {
  Resource,
} from '../../src/types/target';

suite('RegistryManager - Repository Safety Diagnostics', () => {
  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let workspaceRoot: string;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  const source: RegistrySource = {
    id: 'safety-source',
    name: 'Safety Source',
    type: 'local',
    url: 'file:///safety-source',
    enabled: true,
    priority: 0
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-safety-'));
    workspaceRoot = path.join(tempRoot, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance({
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: tempRoot,
      extensionUri: vscode.Uri.file(tempRoot),
      storageUri: vscode.Uri.file(path.join(tempRoot, 'storage')),
      globalStorageUri: vscode.Uri.file(path.join(tempRoot, 'global')),
      asAbsolutePath: (relativePath: string) => path.join(tempRoot, relativePath)
    } as any);

    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([source]);
    mockStorage.getInstalledBundle.resolves(undefined);
    mockStorage.getInstalledBundles.resolves([]);
    (manager as any).storage = mockStorage;

    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(workspaceRoot), name: 'workspace', index: 0 }
    ]);
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    (RegistryManager as any).instance = undefined;
  });

  test('rejects committed repository installs with secret-like prompts, instructions, agents, and skills', async () => {
    const resources: Resource[] = [
      createResource('prompt', 'token-review', 'API_TOKEN=super-secret-value'),
      createResource('instruction', 'password-rules', 'password = "abc123"'),
      createResource('agent', 'planner', 'client_secret: abc123'),
      createResource('skill', 'key-auditor', '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----')
    ];
    const bundle = createBundle('unsafe-repository-bundle');

    sandbox.stub(RepositoryAdapterFactory, 'create').returns({
      downloadBundle: sandbox.stub().resolves(createBundleZip(bundle, resources))
    } as any);
    mockStorage.getCachedBundleMetadata.withArgs(bundle.id).resolves(bundle);

    await assert.rejects(
      manager.installBundle(bundle.id, { scope: 'repository', commitMode: 'commit' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('secret-like-content'));
        assert.ok(error.message.includes('token-review'));
        assert.ok(error.message.includes('password-rules'));
        assert.ok(error.message.includes('planner'));
        assert.ok(error.message.includes('key-auditor'));
        assert.ok(error.message.includes('[REDACTED]'));
        assert.ok(!error.message.includes('super-secret-value'));
        assert.ok(!error.message.includes('abc123'));
        return true;
      }
    );

    assert.strictEqual(mockStorage.recordInstallation.called, false, 'Rejected repository install should not be recorded');
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.github')), false, 'Rejected repository install should not write repository files');
  });

  test('allows the same secret-like resources in local-only repository mode', async () => {
    const resources: Resource[] = [
      createResource('prompt', 'token-review', 'API_TOKEN=super-secret-value')
    ];
    const bundle = createBundle('local-only-repository-bundle');

    sandbox.stub(RepositoryAdapterFactory, 'create').returns({
      downloadBundle: sandbox.stub().resolves(createBundleZip(bundle, resources))
    } as any);
    mockStorage.getCachedBundleMetadata.withArgs(bundle.id).resolves(bundle);

    const installed = await manager.installBundle(bundle.id, { scope: 'repository', commitMode: 'local-only' });

    assert.strictEqual(installed.bundleId, bundle.id);
    assert.strictEqual(installed.scope, 'repository');
    assert.strictEqual(mockStorage.recordInstallation.called, false, 'Repository installs should remain lockfile-backed');
  });
});

function createBundle(id: string): Bundle {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'Repository safety test bundle',
    author: 'Test',
    sourceId: 'safety-source',
    environments: ['vscode'],
    tags: ['test'],
    lastUpdated: '2026-07-04T00:00:00.000Z',
    size: '1KB',
    dependencies: [],
    license: 'MIT',
    downloadUrl: `file:///${id}.zip`,
    manifestUrl: `file:///${id}/deployment-manifest.yml`
  };
}

function createResource(kind: Resource['kind'], id: string, content: string): Resource {
  const folder = kind === 'instruction' ? 'instructions' : `${kind}s`;
  const extension = resourceFileExtension(kind);
  const sourcePath = kind === 'skill'
    ? `skills/${id}/SKILL.md`
    : `${folder}/${id}.${extension}`;

  return {
    kind,
    id,
    sourcePath,
    content
  };
}

function resourceFileExtension(kind: Resource['kind']): string {
  switch (kind) {
    case 'prompt': {
      return 'prompt.md';
    }
    case 'agent': {
      return 'agent.md';
    }
    case 'instruction': {
      return 'instructions.md';
    }
    case 'skill': {
      return 'md';
    }
    case 'plugin': {
      return 'plugin.json';
    }
    case 'hook': {
      return 'hook.json';
    }
  }
}

function createBundleZip(bundle: Bundle, resources: Resource[]): Buffer {
  const zip = new AdmZip();
  const promptEntries = resources.map((resource) => ({
    id: resource.id,
    name: resource.id,
    description: resource.id,
    file: resource.sourcePath,
    type: resource.kind === 'instruction' ? 'instructions' : resource.kind
  }));

  const manifest = {
    id: bundle.id,
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
    author: bundle.author,
    tags: bundle.tags,
    environments: bundle.environments,
    dependencies: bundle.dependencies,
    license: bundle.license,
    prompts: promptEntries
  };

  zip.addFile('deployment-manifest.yml', Buffer.from(yaml.dump(manifest)));
  for (const resource of resources) {
    zip.addFile(resource.sourcePath, Buffer.from(resource.content ?? ''));
  }

  return zip.toBuffer();
}
