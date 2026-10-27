import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HubConfigEditorService,
} from '@ai-primitives-hub/app';
import {
  JSDOM,
} from 'jsdom';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubEditorCommands,
} from '../../src/commands/hub-editor-commands';
import {
  HubYamlIntelligence,
} from '../../src/services/hub-yaml-intelligence';
import {
  HubConfigCustomEditorProvider,
} from '../../src/ui/hub-config-custom-editor';
import {
  HubConfigTreeItemType,
  HubConfigTreeProvider,
} from '../../src/ui/hub-config-tree-provider';

const SAMPLE_HUB_YAML = `# yaml-language-server: $schema=https://raw.githubusercontent.com/AmadeusITGroup/prompt-registry/refs/heads/main/schemas/hub-config.schema.json
version: 1.0.0
metadata:
  name: Awesome Copilot Hub
  description: Curated primitives
  maintainer: Hub Team
  updatedAt: "2026-10-21T00:00:00.000Z"
sources:
  - id: community-collections
    name: Community Collections
    type: github
    url: https://github.com/AmadeusITGroup/community-collections
    enabled: true
    priority: 10
profiles:
  # Roles
  - id: opensource-contributor
    name: OpenSource Contributor
    description: Primitives for open source
    icon: "🌍"
    path: ["Roles"]
    bundles:
      - id: unprefixed-bundle
        version: latest
        source: community-collections
        required: true
`;

function createMockDocument(content: string, fsPath = '/workspace/prompt-registry-config/hub-config.yml'): vscode.TextDocument {
  const lines = content.split('\n');
  return {
    uri: vscode.Uri.file(fsPath),
    fileName: fsPath,
    languageId: 'yaml',
    version: 1,
    isDirty: false,
    isClosed: false,
    isUntitled: false,
    eol: 1,
    encoding: 'utf8',
    lineCount: lines.length,
    getText: () => content,
    lineAt: (lineOrPos: number | vscode.Position) => {
      const idx = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
      const text = lines[idx] ?? '';
      return {
        lineNumber: idx,
        text,
        range: new vscode.Range(idx, 0, idx, text.length),
        rangeIncludingLineBreak: new vscode.Range(idx, 0, idx, text.length),
        firstNonWhitespaceCharacterIndex: 0,
        isEmptyOrWhitespace: text.trim().length === 0
      };
    },
    offsetAt: () => 0,
    positionAt: () => new vscode.Position(0, 0),
    getWordRangeAtPosition: () => undefined,
    validateRange: (r: vscode.Range) => r,
    validatePosition: (p: vscode.Position) => p,
    save: () => Promise.resolve(true)
  };
}

suite('Hub Editor, Tree View, YAML Intelligence & Artifactory Guard', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('HubYamlIntelligence produces diagnostics, CodeLenses, and QuickFix CodeActions for hub-config.yml', () => {
    const editorService = new HubConfigEditorService();
    const intelligence = new HubYamlIntelligence(editorService);
    const doc = createMockDocument(SAMPLE_HUB_YAML);

    const inspection = intelligence.validateDocument(doc);
    assert.strictEqual(inspection.valid, false);

    const diagnostics = intelligence.getDiagnostics(doc.uri);
    assert.ok(diagnostics && diagnostics.length > 0, 'Expected diagnostics for unprefixed github bundle');
    assert.ok(diagnostics.some((d) => d.message.includes('AmadeusITGroup-community-collections-')));

    const lenses = intelligence.provideCodeLenses(doc);
    assert.ok(lenses.some((l) => l.command?.command === 'promptregistry.openHubVisualEditor'));
    assert.ok(lenses.some((l) => l.command?.command === 'promptregistry.addHubSource'));
    assert.ok(lenses.some((l) => l.command?.command === 'promptregistry.addHubProfile'));

    const bundleLineRange = new vscode.Range(22, 0, 22, 30);
    const actions = intelligence.provideCodeActions(doc, bundleLineRange);
    assert.ok(actions.length > 0, 'Expected quick fix action for invalid bundle prefix');
    assert.ok(actions[0].title.includes('AmadeusITGroup-community-collections-unprefixed-bundle'));

    intelligence.dispose();
  });

  test('HubConfigTreeProvider renders Metadata, Sources, and categorized Profiles with Bundles', async () => {
    const editorService = new HubConfigEditorService();
    const treeProvider = new HubConfigTreeProvider(editorService);
    treeProvider.updateFromContent('/workspace/prompt-registry-config/hub-config.yml', SAMPLE_HUB_YAML);

    const roots = await treeProvider.getChildren();
    const types = roots.map((r) => r.itemType);
    assert.ok(types.includes(HubConfigTreeItemType.STATUS_ROOT));
    assert.ok(types.includes(HubConfigTreeItemType.METADATA_ROOT));
    assert.ok(types.includes(HubConfigTreeItemType.SOURCES_ROOT));
    assert.ok(types.includes(HubConfigTreeItemType.PROFILES_ROOT));

    const sourcesRoot = roots.find((r) => r.itemType === HubConfigTreeItemType.SOURCES_ROOT);
    const sourceChildren = await treeProvider.getChildren(sourcesRoot);
    assert.ok(sourceChildren.some((s) => s.label.includes('Community Collections')));

    const profilesRoot = roots.find((r) => r.itemType === HubConfigTreeItemType.PROFILES_ROOT);
    const categoryChildren = await treeProvider.getChildren(profilesRoot);
    const rolesCategory = categoryChildren.find((c) => c.label === 'Roles');
    assert.ok(rolesCategory, 'Expected Roles category folder');

    const roleProfiles = await treeProvider.getChildren(rolesCategory);
    assert.ok(roleProfiles.some((p) => p.label.includes('OpenSource Contributor')));
  });

  test('HubEditorCommands blocks Artifactory hubs as read-only and sets activeHubContributable=false', async () => {
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
    const showWarningStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves();

    const fakeHubManager = {
      getActiveHub: sandbox.stub().resolves({
        id: 'artifactory-replica',
        config: {
          version: '1.0.0',
          metadata: {
            name: 'Enterprise Artifactory Hub',
            description: 'Replica hub',
            maintainer: 'Ops',
            updatedAt: '2026-10-25T00:00:00.000Z'
          },
          sources: [],
          profiles: []
        },
        reference: {
          type: 'artifactory',
          location: 'https://artifactory.corp.example/artifactory/ai-hub'
        }
      }),
      getHubInfo: sandbox.stub(),
      listHubs: sandbox.stub().resolves([]),
      onActiveHubChanged: () => ({ dispose: () => undefined }),
      onHubImported: () => ({ dispose: () => undefined }),
      onHubDeleted: () => ({ dispose: () => undefined })
    };

    const editorService = new HubConfigEditorService();
    const treeProvider = new HubConfigTreeProvider(editorService);
    const intelligence = new HubYamlIntelligence(editorService);

    const mockContext = {
      subscriptions: [],
      globalStorageUri: vscode.Uri.file('/tmp/pr-test-storage'),
      extensionPath: '/tmp/ext',
      extensionUri: vscode.Uri.file('/tmp/ext'),
      secrets: (vscode as any).secrets
    } as unknown as vscode.ExtensionContext;

    const commands = new HubEditorCommands(
      mockContext,
      fakeHubManager as any,
      editorService,
      treeProvider,
      intelligence
    );

    await commands.refreshContributableContext();
    assert.ok(
      executeCommandStub.calledWith('setContext', 'promptRegistry.activeHubContributable', false),
      'Expected promptRegistry.activeHubContributable to be false for Artifactory hub'
    );

    await commands.contributeToHub();
    assert.ok(showWarningStub.calledOnce, 'Expected warning message when attempting to contribute to Artifactory hub');
    const warningMsg = String(showWarningStub.firstCall.args[0]);
    assert.ok(warningMsg.includes('Artifactory'));
    assert.ok(warningMsg.includes('read-only'));

    intelligence.dispose();
  });

  test('HubEditorCommands enables activeHubContributable=true for GitHub hubs and HubConfigCustomEditorProvider applies webview mutations', async () => {
    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
    const applyEditStub = sandbox.stub(vscode.workspace, 'applyEdit').resolves(true);

    const fakeHubManager = {
      getActiveHub: sandbox.stub().resolves({
        id: 'github-hub',
        config: {
          version: '1.0.0',
          metadata: {
            name: 'Awesome Copilot Hub',
            description: 'Community hub',
            maintainer: 'Community',
            updatedAt: '2026-10-25T00:00:00.000Z'
          },
          sources: [],
          profiles: []
        },
        reference: {
          type: 'github',
          location: 'AmadeusITGroup/prompt-registry-config',
          ref: 'main'
        }
      }),
      getHubInfo: sandbox.stub(),
      listHubs: sandbox.stub().resolves([]),
      onActiveHubChanged: () => ({ dispose: () => undefined }),
      onHubImported: () => ({ dispose: () => undefined }),
      onHubDeleted: () => ({ dispose: () => undefined })
    };

    const editorService = new HubConfigEditorService();
    const treeProvider = new HubConfigTreeProvider(editorService);
    const intelligence = new HubYamlIntelligence(editorService);
    const mockContext = {
      subscriptions: [],
      globalStorageUri: vscode.Uri.file('/tmp/pr-test-storage'),
      extensionPath: '/tmp/ext',
      extensionUri: vscode.Uri.file('/tmp/ext'),
      secrets: (vscode as any).secrets
    } as unknown as vscode.ExtensionContext;

    const customEditor = new HubConfigCustomEditorProvider(
      mockContext,
      editorService,
      intelligence,
      treeProvider
    );
    const commands = new HubEditorCommands(
      mockContext,
      fakeHubManager as any,
      editorService,
      treeProvider,
      intelligence,
      customEditor
    );

    const isContributable = await commands.refreshContributableContext();
    assert.strictEqual(isContributable, true);
    assert.ok(
      executeCommandStub.calledWith('setContext', 'promptRegistry.activeHubContributable', true),
      'Expected promptRegistry.activeHubContributable to be true for GitHub hub'
    );

    let messageListener: ((msg: Record<string, unknown>) => Promise<void>) | undefined;
    const postedMessages: Record<string, unknown>[] = [];
    const mockPanel = {
      webview: {
        options: {},
        html: '',
        postMessage: (msg: Record<string, unknown>) => {
          postedMessages.push(msg);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => Promise<void>) => {
          messageListener = cb;
          return { dispose: () => undefined };
        }
      },
      onDidDispose: () => ({ dispose: () => undefined })
    } as unknown as vscode.WebviewPanel;

    const doc = createMockDocument(SAMPLE_HUB_YAML);
    customEditor.resolveCustomTextEditor(doc, mockPanel);
    assert.ok(mockPanel.webview.html.includes('Visual Configuration Editor'));

    await messageListener?.({ type: 'ready' });
    assert.ok(postedMessages.some((m) => m.type === 'documentState'));

    await messageListener?.({
      type: 'applyMutation',
      mutation: {
        kind: 'touch-updated-at',
        updatedAt: '2026-10-25T15:00:00.000Z'
      }
    });
    assert.ok(applyEditStub.calledOnce);

    // Verify on-demand source discovery by ID from webview
    await messageListener?.({
      type: 'discoverSourceById',
      sourceId: 'community-collections',
      silent: true
    });
    assert.ok(
      executeCommandStub.calledWith(
        'promptregistry.discoverHubSourceBundles',
        doc.uri,
        'community-collections',
        true
      ),
      'Expected discoverSourceById message to trigger discoverHubSourceBundles command'
    );

    // Verify clickable PR / external URL opening from both webview and tree view
    const openExternalStub = sandbox.stub(vscode.env, 'openExternal').resolves(true);
    await messageListener?.({
      type: 'openExternalUrl',
      url: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config/pull/148'
    });
    assert.strictEqual(openExternalStub.callCount, 1, 'Expected openExternalUrl webview message to open PR link in browser');

    treeProvider.setContributionContext({
      isHubWorkspace: true,
      workspaceDir: '/workspace/prompt-registry-config',
      hubConfigPath: '/workspace/prompt-registry-config/hub-config.yml',
      upstreamSlug: 'Amadeus-xDLC/genai.prompt-registry-config',
      forkSlug: 'pwherka1_amadeus/genai.prompt-registry-config',
      currentBranch: 'feat/add-hub-source-or-profile',
      defaultBranch: 'main',
      hasUncommittedChanges: false,
      session: {
        hubId: 'amadeus-hub',
        hubName: 'Amadeus Hub',
        hubReference: {
          type: 'github',
          location: 'Amadeus-xDLC/genai.prompt-registry-config',
          ref: 'main'
        },
        upstreamSlug: 'Amadeus-xDLC/genai.prompt-registry-config',
        forkSlug: 'pwherka1_amadeus/genai.prompt-registry-config',
        defaultBranch: 'main',
        branchName: 'feat/add-hub-source-or-profile',
        workspaceDir: '/workspace/prompt-registry-config',
        hubConfigPath: '/workspace/prompt-registry-config/hub-config.yml',
        updatedAt: '2026-10-25T16:41:04.557Z',
        pullRequest: {
          number: 148,
          title: 'feat(hub): update hub sources and profiles',
          htmlUrl: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config/pull/148',
          state: 'open',
          draft: true,
          headRef: 'feat/add-hub-source-or-profile',
          baseRef: 'main',
          upstreamFullName: 'Amadeus-xDLC/genai.prompt-registry-config',
          updatedAt: '2026-10-25T16:41:04.557Z',
          checks: {
            state: 'success',
            totalCount: 2,
            passingCount: 2,
            failingCount: 0,
            pendingCount: 0
          }
        }
      }
    });

    const roots = await treeProvider.getChildren();
    const statusRoot = roots.find((r) => r.itemType === HubConfigTreeItemType.STATUS_ROOT);
    const statusChildren = await treeProvider.getChildren(statusRoot);
    const prItem = statusChildren.find((item) => item.label.startsWith('PR #148:'));
    assert.ok(prItem, 'Expected PR #148 tree item');
    assert.strictEqual(prItem.command?.command, 'promptregistry.openHubPullRequest');
    assert.deepStrictEqual(prItem.command?.arguments, [
      'https://github.com/Amadeus-xDLC/genai.prompt-registry-config/pull/148'
    ]);

    const upstreamItem = statusChildren.find((item) => item.label.startsWith('Upstream:'));
    assert.ok(upstreamItem, 'Expected Upstream repository tree item');
    assert.strictEqual(upstreamItem.command?.command, 'promptregistry.openHubPullRequest');
    assert.deepStrictEqual(upstreamItem.command?.arguments, [
      'https://github.com/Amadeus-xDLC/genai.prompt-registry-config'
    ]);

    await commands.openHubPullRequest(prItem);
    assert.strictEqual(openExternalStub.callCount, 2);

    intelligence.dispose();
  });

  test('External hub-config-editor webview (HTML/CSS/JS) renders detail views, auto-discovers source catalogs, and opens PR links in JSDOM', () => {
    const webviewDir = path.join(process.cwd(), 'src', 'ui', 'webview', 'hub-config-editor');
    const html = fs.readFileSync(path.join(webviewDir, 'hub-config-editor.html'), 'utf8');
    const script = fs.readFileSync(path.join(webviewDir, 'hub-config-editor.js'), 'utf8');
    assert.ok(fs.existsSync(path.join(webviewDir, 'hub-config-editor.css')));

    const messages: Record<string, unknown>[] = [];
    const documentHtml = html.replace(
      /<script[^>]*src="\{\{scriptUri\}\}"[^>]*><\/script>/,
      `<script>${script}</script>`
    );

    const dom = new JSDOM(documentHtml, {
      runScripts: 'dangerously',
      beforeParse: (window) => {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: (msg: Record<string, unknown>) => {
            messages.push(msg);
          }
        });
      }
    });

    assert.ok(messages.some((m) => m.type === 'ready'));

    const editorService = new HubConfigEditorService();
    const inspection = editorService.inspectDocument(SAMPLE_HUB_YAML);

    // 1. Dispatch documentState focused on metadata with an active PR
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'documentState',
        inspection: {
          ...inspection,
          expectedPrefixBySourceId: {
            'community-collections': 'AmadeusITGroup-community-collections-'
          },
          catalogsBySourceId: {}
        },
        contributionContext: {
          upstreamSlug: 'Amadeus-xDLC/genai.prompt-registry-config',
          forkSlug: 'pwherka1_amadeus/genai.prompt-registry-config',
          currentBranch: 'feat/add-hub-source-or-profile',
          session: {
            pullRequest: {
              number: 148,
              title: 'feat(hub): update hub sources and profiles',
              htmlUrl: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config/pull/148',
              state: 'open',
              checks: {
                state: 'success',
                passingCount: 2,
                totalCount: 2
              }
            }
          }
        },
        focusTarget: { section: 'metadata' }
      }
    }));

    const prPill = dom.window.document.querySelector('#prPill') as unknown as {
      textContent: string | null;
      click: () => void;
    };
    assert.ok(prPill.textContent?.includes('PR #148'));
    prPill.click();
    assert.ok(
      messages.some((m) => m.type === 'openExternalUrl' && m.url === 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config/pull/148'),
      'Expected clicking header PR pill to post openExternalUrl message'
    );

    // 2. Navigate to profile 0; since catalog is not cached yet, it should auto-request discoverSourceById
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'documentState',
        inspection: {
          ...inspection,
          expectedPrefixBySourceId: {
            'community-collections': 'AmadeusITGroup-community-collections-'
          },
          catalogsBySourceId: {}
        },
        focusTarget: { section: 'profile', index: 0 }
      }
    }));

    assert.ok(
      messages.some((m) => m.type === 'discoverSourceById' && m.sourceId === 'community-collections' && m.silent === true),
      'Expected opening a profile to auto-trigger silent source catalog discovery'
    );

    // 3. Deliver discovered catalog and verify unique bundle options + version dropdown population
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'documentState',
        inspection: {
          ...inspection,
          expectedPrefixBySourceId: {
            'community-collections': 'AmadeusITGroup-community-collections-'
          },
          catalogsBySourceId: {
            'community-collections': [
              {
                id: 'AmadeusITGroup-community-collections-agents-md-creator',
                version: '1.0.1',
                versions: ['1.0.1', '1.0.0']
              }
            ]
          }
        }
      }
    }));

    const catalogSelect = dom.window.document.querySelector('#newBundleCatalogSelect') as unknown as {
      value: string;
      options: ArrayLike<{ value: string }>;
      dispatchEvent: (event: unknown) => boolean;
    };
    assert.strictEqual(catalogSelect.options.length, 2);
    assert.strictEqual(catalogSelect.options[1].value, 'AmadeusITGroup-community-collections-agents-md-creator');

    catalogSelect.value = 'AmadeusITGroup-community-collections-agents-md-creator';
    catalogSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    const versionSelect = dom.window.document.querySelector('#newBundleVersion') as unknown as {
      options: ArrayLike<{ value: string }>;
    };
    const versionValues = Array.from(versionSelect.options, (opt) => opt.value);
    assert.deepStrictEqual(versionValues, ['latest', '1.0.1', '1.0.0']);

    // 4. Verify closed PRs are NOT displayed in the header pill or Metadata card
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'documentState',
        inspection: {
          ...inspection,
          expectedPrefixBySourceId: {
            'community-collections': 'AmadeusITGroup-community-collections-'
          },
          catalogsBySourceId: {}
        },
        contributionContext: {
          upstreamSlug: 'Amadeus-xDLC/genai.prompt-registry-config',
          forkSlug: 'pwherka1_amadeus/genai.prompt-registry-config',
          currentBranch: 'feat/add-hub-source-or-profile',
          session: {
            pullRequest: {
              number: 148,
              title: 'feat(hub): update hub sources and profiles',
              htmlUrl: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config/pull/148',
              state: 'closed',
              checks: {
                state: 'success',
                passingCount: 2,
                totalCount: 2
              }
            }
          }
        },
        focusTarget: { section: 'metadata' }
      }
    }));

    assert.ok(
      !prPill.textContent?.includes('PR #148'),
      'Expected closed PR not to be displayed in the header pill'
    );
    assert.ok(
      prPill.textContent?.includes('Amadeus-xDLC/genai.prompt-registry-config'),
      'Expected header pill to fall back to upstream repository link when PR is closed'
    );

    // 5. Verify clicking a profile or source in the Visual Editor tree posts revealSelectionInYaml
    // and clicking Split YAML View posts openYamlSplit with the current selection
    const profileTreeItem = dom.window.document.querySelector('[data-nav="profile"][data-idx="0"]') as unknown as {
      click: () => void;
    };
    profileTreeItem.click();
    assert.ok(
      messages.some((m) => m.type === 'revealSelectionInYaml' && (m.selection as any)?.section === 'profile' && (m.selection as any)?.index === 0),
      'Expected selecting a profile in the visual tree to post revealSelectionInYaml'
    );

    const splitBtn = dom.window.document.querySelector('#btnSplitYaml') as unknown as {
      click: () => void;
    };
    splitBtn.click();
    assert.ok(
      messages.some((m) => m.type === 'openYamlSplit' && (m.selection as any)?.section === 'profile' && (m.selection as any)?.index === 0),
      'Expected clicking Split YAML View to post openYamlSplit with active selection'
    );
  });

  test('HubConfigCustomEditorProvider synchronizes selection to visible split YAML editors and hides closed PRs in TreeProvider', async () => {
    const editorService = new HubConfigEditorService();
    const treeProvider = new HubConfigTreeProvider(editorService);
    const intelligence = new HubYamlIntelligence(editorService);
    const mockContext = {
      subscriptions: [],
      globalStorageUri: vscode.Uri.file('/tmp/pr-test-storage'),
      extensionPath: process.cwd(),
      extensionUri: vscode.Uri.file(process.cwd()),
      secrets: (vscode as any).secrets
    } as unknown as vscode.ExtensionContext;

    const customEditor = new HubConfigCustomEditorProvider(
      mockContext,
      editorService,
      intelligence,
      treeProvider
    );

    const doc = createMockDocument(SAMPLE_HUB_YAML);
    intelligence.validateDocument(doc);

    const revealedRanges: vscode.Range[] = [];
    const fakeVisibleEditor = {
      document: doc,
      selection: new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      revealRange: (range: vscode.Range) => {
        revealedRanges.push(range);
      },
      setDecorations: () => undefined
    } as unknown as vscode.TextEditor;

    sandbox.stub(vscode.window, 'visibleTextEditors').value([fakeVisibleEditor]);

    await customEditor.revealSelectionInYamlEditor(doc, { section: 'profile', index: 0 }, { openBeside: false });
    assert.strictEqual(revealedRanges.length, 1, 'Expected visible split YAML editor to reveal the selected profile range');
    assert.strictEqual(fakeVisibleEditor.selection.start.line, 16, 'Expected cursor selection to move to profiles.0.id line');

    // Verify closed PR is hidden in HubConfigTreeProvider and Commit & Create PR is shown instead
    treeProvider.updateFromContent(doc.uri.fsPath, SAMPLE_HUB_YAML);
    treeProvider.setContributionContext({
      isHubWorkspace: true,
      workspaceDir: '/workspace/prompt-registry-config',
      hubConfigPath: doc.uri.fsPath,
      upstreamSlug: 'Amadeus-xDLC/genai.prompt-registry-config',
      forkSlug: 'pwherka1_amadeus/genai.prompt-registry-config',
      currentBranch: 'feat/add-hub-source-or-profile',
      defaultBranch: 'main',
      hasUncommittedChanges: true,
      session: {
        hubId: 'amadeus-hub',
        hubName: 'Amadeus Hub',
        hubReference: {
          type: 'github',
          location: 'Amadeus-xDLC/genai.prompt-registry-config',
          ref: 'main'
        },
        upstreamSlug: 'Amadeus-xDLC/genai.prompt-registry-config',
        forkSlug: 'pwherka1_amadeus/genai.prompt-registry-config',
        defaultBranch: 'main',
        branchName: 'feat/add-hub-source-or-profile',
        workspaceDir: '/workspace/prompt-registry-config',
        hubConfigPath: doc.uri.fsPath,
        updatedAt: '2026-10-25T16:41:04.557Z',
        pullRequest: {
          number: 148,
          title: 'feat(hub): update hub sources and profiles',
          htmlUrl: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config/pull/148',
          state: 'closed',
          draft: false,
          headRef: 'feat/add-hub-source-or-profile',
          baseRef: 'main',
          upstreamFullName: 'Amadeus-xDLC/genai.prompt-registry-config',
          updatedAt: '2026-10-25T16:41:04.557Z'
        }
      }
    });

    const roots = await treeProvider.getChildren();
    const statusRoot = roots.find((r) => r.itemType === HubConfigTreeItemType.STATUS_ROOT);
    const statusChildren = await treeProvider.getChildren(statusRoot);
    assert.ok(
      !statusChildren.some((item) => item.label.startsWith('PR #148:')),
      'Expected closed PR #148 not to be shown in the tree view'
    );
    assert.ok(
      statusChildren.some((item) => item.label.includes('Commit & Create Pull Request')),
      'Expected Commit & Create Pull Request action when no open PR exists'
    );

    intelligence.dispose();
  });
});
