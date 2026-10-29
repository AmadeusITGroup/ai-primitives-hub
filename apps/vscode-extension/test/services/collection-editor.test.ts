import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CollectionEditorService,
} from '@ai-primitives-hub/app';
import {
  JSDOM,
} from 'jsdom';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  CollectionEditorCommands,
} from '../../src/commands/collection-editor-commands';
import {
  CollectionYamlIntelligence,
} from '../../src/services/collection-yaml-intelligence';
import {
  CollectionCustomEditorProvider,
} from '../../src/ui/collection-custom-editor';
import {
  CollectionTreeItemType,
  CollectionTreeProvider,
} from '../../src/ui/collection-tree-provider';

const SAMPLE_COLLECTION_YAML = `# yaml-language-server: $schema=../schemas/collection.schema.json
id: python-development
name: Python Development Suite
description: Prompts and skills for Python development
version: 1.2.0
author: Python Team
tags:
  - python
  - testing
# Core items
items:
  - path: prompts/write-tests.prompt.md
    kind: chatmode
    title: Test Writer
  - path: instructions/standards.instructions.md
    kind: instruction
mcp:
  inputs:
    - id: apiToken
      type: promptString
      description: API token
      password: true
  items:
    python-analyzer:
      type: stdio
      command: python
`;

function createMockDocument(
  content: string,
  fsPath = '/workspace/repo/collections/python-development.collection.yml'
): vscode.TextDocument {
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

suite('Collection Visual Editor, Tree View, YAML Intelligence & Artifactory Guard', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-vscode-col-test-'));
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('CollectionYamlIntelligence produces diagnostics, CodeLenses, and QuickFix CodeActions for *.collection.yml', () => {
    const editorService = new CollectionEditorService();
    const intelligence = new CollectionYamlIntelligence(editorService);
    const colPath = path.join(tmpDir, 'collections', 'python-development.collection.yml');
    fs.mkdirSync(path.dirname(colPath), { recursive: true });
    fs.writeFileSync(colPath, SAMPLE_COLLECTION_YAML, 'utf8');

    const doc = createMockDocument(SAMPLE_COLLECTION_YAML, colPath);
    const inspection = intelligence.validateDocument(doc);
    assert.strictEqual(inspection.valid, false);

    const diagnostics = intelligence.getDiagnostics(doc.uri);
    assert.ok(diagnostics && diagnostics.length > 0, 'Expected diagnostics for deprecated chatmode kind');
    assert.ok(diagnostics.some((d) => d.message.includes('deprecated')));

    const lenses = intelligence.provideCodeLenses(doc);
    assert.ok(lenses.some((l) => l.command?.command === 'promptregistry.openCollectionVisualEditor'));
    assert.ok(lenses.some((l) => l.command?.command === 'promptregistry.addCollectionItemVisual'));
    assert.ok(lenses.some((l) => l.command?.command === 'promptregistry.submitCollectionPullRequest'));

    // Deprecated kind is on line 12 (`kind: chatmode`)
    const itemKindRange = new vscode.Range(12, 0, 12, 20);
    const actions = intelligence.provideCodeActions(doc, itemKindRange);
    assert.ok(actions.length > 0, 'Expected quick fix action for deprecated kind');
    assert.ok(actions.some((a) => a.title.includes('agent')));

    intelligence.dispose();
  });

  test('CollectionTreeProvider detects workspace collections and renders Status, Collections, Metadata, Items, and MCP nodes', async () => {
    const editorService = new CollectionEditorService();
    const treeProvider = new CollectionTreeProvider(editorService);

    editorService.createCollectionFile(tmpDir, {
      id: 'python-development',
      name: 'Python Development Suite',
      description: 'Python tools',
      createReadme: true
    });

    treeProvider.refreshWorkspace(tmpDir);
    treeProvider.setContributionContext({
      isCollectionWorkspace: true,
      workspaceDir: tmpDir,
      collectionsPath: 'collections',
      collectionFiles: ['collections/python-development.collection.yml'],
      upstreamSlug: 'AmadeusITGroup/prompt-collections',
      forkSlug: 'contributor/prompt-collections',
      currentBranch: 'feat/collection-python-development',
      defaultBranch: 'main',
      modifiedFiles: [],
      hasUncommittedChanges: false,
      session: {
        sourceId: 'gh-col',
        sourceName: 'Prompt Collections',
        sourceType: 'github',
        collectionId: 'python-development',
        collectionsPath: 'collections',
        upstreamSlug: 'AmadeusITGroup/prompt-collections',
        forkSlug: 'contributor/prompt-collections',
        defaultBranch: 'main',
        branchName: 'feat/collection-python-development',
        workspaceDir: tmpDir,
        pullRequest: {
          number: 55,
          title: 'feat(collection): add python-development',
          htmlUrl: 'https://github.com/AmadeusITGroup/prompt-collections/pull/55',
          state: 'open',
          draft: false,
          headRef: 'feat/collection-python-development',
          baseRef: 'main',
          upstreamFullName: 'AmadeusITGroup/prompt-collections',
          updatedAt: '2026-10-28T00:00:00.000Z'
        },
        updatedAt: '2026-10-28T00:00:00.000Z'
      }
    });

    const roots = await treeProvider.getChildren();
    const types = roots.map((r) => r.itemType);
    assert.ok(types.includes(CollectionTreeItemType.STATUS_ROOT));
    assert.ok(types.includes(CollectionTreeItemType.COLLECTIONS_ROOT));

    const statusRoot = roots.find((r) => r.itemType === CollectionTreeItemType.STATUS_ROOT);
    const statusChildren = await treeProvider.getChildren(statusRoot);
    assert.ok(statusChildren.some((s) => s.label.includes('Upstream: AmadeusITGroup/prompt-collections')));
    assert.ok(statusChildren.some((s) => s.label.includes('PR #55')));

    const collectionsRoot = roots.find((r) => r.itemType === CollectionTreeItemType.COLLECTIONS_ROOT);
    const colNodes = await treeProvider.getChildren(collectionsRoot);
    assert.strictEqual(colNodes.length, 1);
    assert.ok(colNodes[0].label.includes('Python Development Suite'));

    const sectionNodes = await treeProvider.getChildren(colNodes[0]);
    const sectionTypes = sectionNodes.map((n) => n.itemType);
    assert.ok(sectionTypes.includes(CollectionTreeItemType.METADATA_GROUP));
    assert.ok(sectionTypes.includes(CollectionTreeItemType.ITEMS_GROUP));
    assert.ok(sectionTypes.includes(CollectionTreeItemType.MCP_GROUP));

    treeProvider.dispose();
  });

  test('CollectionEditorCommands blocks Artifactory sources as read-only when contributing', async () => {
    const showWarningStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves();
    const editorService = new CollectionEditorService();
    const intelligence = new CollectionYamlIntelligence(editorService);
    const treeProvider = new CollectionTreeProvider(editorService);

    const fakeRegistryManager = {
      listSources: sandbox.stub().resolves([
        {
          id: 'artifactory-source',
          name: 'Enterprise Artifactory Bundles',
          type: 'artifactory',
          url: 'https://artifactory.example.com/artifactory/ai-bundles',
          enabled: true,
          priority: 1
        }
      ]),
      searchBundles: sandbox.stub().resolves([
        {
          id: 'python-development',
          name: 'Python Development Suite',
          version: '1.0.0',
          sourceId: 'artifactory-source'
        }
      ])
    } as any;

    const fakeContext = {
      globalStorageUri: vscode.Uri.file(tmpDir),
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')),
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    const commands = new CollectionEditorCommands(
      fakeContext,
      fakeRegistryManager,
      editorService,
      treeProvider,
      intelligence
    );

    await commands.contributeToCollection({
      bundleId: 'python-development',
      sourceId: 'artifactory-source'
    });

    assert.ok(showWarningStub.calledOnce, 'Expected read-only warning for Artifactory collection source');
    assert.ok(String(showWarningStub.firstCall.args[0]).includes('read-only'));

    intelligence.dispose();
    treeProvider.dispose();
  });

  test('CollectionCustomEditorProvider synchronizes split YAML selection and external webview JS handles CRUD and primitive content editing', async () => {
    const editorService = new CollectionEditorService();
    const intelligence = new CollectionYamlIntelligence(editorService);
    const treeProvider = new CollectionTreeProvider(editorService);

    const fakeContext = {
      globalStorageUri: vscode.Uri.file(tmpDir),
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')),
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    const customEditor = new CollectionCustomEditorProvider(
      fakeContext,
      editorService,
      intelligence,
      treeProvider
    );

    const colFilePath = path.join(tmpDir, 'collections', 'python-development.collection.yml');
    fs.mkdirSync(path.dirname(colFilePath), { recursive: true });
    fs.writeFileSync(colFilePath, SAMPLE_COLLECTION_YAML, 'utf8');
    const doc = createMockDocument(SAMPLE_COLLECTION_YAML, colFilePath);

    let revealedRange: vscode.Range | undefined;
    const mockEditor = {
      document: doc,
      selection: new vscode.Selection(0, 0, 0, 0),
      revealRange: (r: vscode.Range) => {
        revealedRange = r;
      }
    } as unknown as vscode.TextEditor;
    sandbox.stub(vscode.window, 'visibleTextEditors').value([mockEditor]);

    await customEditor.revealSelectionInYamlEditor(doc, { section: 'item', index: 1 }, { openBeside: false });
    assert.ok(revealedRange, 'Expected split YAML editor to scroll to selected item');
    assert.strictEqual(mockEditor.selection.start.line, 14);

    // Load the external HTML and JS in JSDOM to verify webview behavior
    const htmlPath = path.resolve(
      __dirname,
      '../../../src/ui/webview/collection-editor/collection-editor.html'
    );
    const jsPath = path.resolve(
      __dirname,
      '../../../src/ui/webview/collection-editor/collection-editor.js'
    );
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const jsContent = fs.readFileSync(jsPath, 'utf8');

    const postedMessages: Record<string, unknown>[] = [];
    const dom = new JSDOM(htmlContent, {
      runScripts: 'outside-only',
      url: 'https://example.com/'
    });
    (dom.window as any).acquireVsCodeApi = () => ({
      postMessage: (msg: Record<string, unknown>) => postedMessages.push(msg),
      getState: () => ({}),
      setState: () => undefined
    });
    dom.window.eval(jsContent);

    assert.ok(postedMessages.some((m) => m.type === 'ready'));

    const inspection = editorService.inspectDocument(SAMPLE_COLLECTION_YAML, {
      filePath: colFilePath,
      workspaceRoot: tmpDir
    });
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: {
          type: 'documentState',
          filePath: colFilePath,
          workspaceRoot: tmpDir,
          inspection: {
            valid: inspection.valid,
            manifest: inspection.manifest,
            errors: inspection.errors,
            warnings: inspection.warnings,
            diagnostics: inspection.diagnostics,
            inlineDecorations: inspection.inlineDecorations,
            itemStatuses: inspection.itemStatuses,
            readmeExists: inspection.readmeExists,
            unassignedPrimitives: [
              {
                path: 'prompts/extra.prompt.md',
                kind: 'prompt',
                title: 'Extra Prompt'
              }
            ]
          },
          siblingCollections: [
            {
              filePath: colFilePath,
              relPath: 'collections/python-development.collection.yml',
              id: 'python-development',
              name: 'Python Development Suite',
              version: '1.2.0',
              valid: false
            }
          ],
          contributionContext: {
            upstreamSlug: 'AmadeusITGroup/prompt-collections',
            currentBranch: 'feat/collection-python-development',
            session: {
              pullRequest: {
                number: 77,
                state: 'open',
                htmlUrl: 'https://github.com/AmadeusITGroup/prompt-collections/pull/77'
              }
            }
          }
        }
      })
    );

    const titleText = dom.window.document.querySelector('#collectionTitle')?.textContent;
    assert.strictEqual(titleText, 'Python Development Suite');

    // Click +Patch version bump button
    const patchBtn = dom.window.document.querySelector('[data-bump-version="patch"]') as { click: () => void } | null;
    assert.ok(patchBtn, 'Expected +Patch version bump button');
    patchBtn.click();
    assert.ok(
      postedMessages.some(
        (m) => m.type === 'applyMutation' && (m.mutation as { kind?: string })?.kind === 'bump-version'
      )
    );

    // Click Split YAML View button
    const splitBtn = dom.window.document.querySelector('#btnSplitYaml') as { click: () => void } | null;
    assert.ok(splitBtn, 'Expected Split YAML View button');
    splitBtn.click();
    assert.ok(postedMessages.some((m) => m.type === 'openYamlBeside'));

    intelligence.dispose();
    treeProvider.dispose();
  });

  test('CollectionCustomEditorProvider.resolveCustomTextEditor posts documentState immediately without recursive onDidInspectDocument loops or blocking on slow git status', async () => {
    const editorService = new CollectionEditorService();
    const intelligence = new CollectionYamlIntelligence(editorService);
    const treeProvider = new CollectionTreeProvider(editorService);

    const fakeContext = {
      globalStorageUri: vscode.Uri.file(tmpDir),
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')),
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    const customEditor = new CollectionCustomEditorProvider(
      fakeContext,
      editorService,
      intelligence,
      treeProvider
    );

    let resolveContributionContext!: (ctx: any) => void;
    const slowContributionContextPromise = new Promise<any>((resolve) => {
      resolveContributionContext = resolve;
    });
    const contribProviderSpy = sandbox.stub().returns(slowContributionContextPromise);
    customEditor.setContributionContextProvider(contribProviderSpy);

    const colFilePath = path.join(tmpDir, 'collections', 'python-development.collection.yml');
    fs.mkdirSync(path.dirname(colFilePath), { recursive: true });
    fs.writeFileSync(colFilePath, SAMPLE_COLLECTION_YAML, 'utf8');
    const doc = createMockDocument(SAMPLE_COLLECTION_YAML, colFilePath);

    const webviewMessages: Record<string, unknown>[] = [];
    let receiveMessageHandler: ((msg: Record<string, unknown>) => Promise<void>) | undefined;
    const mockPanel = {
      webview: {
        options: {},
        html: '',
        cspSource: "'self'",
        asWebviewUri: (u: vscode.Uri) => u,
        postMessage: (msg: Record<string, unknown>) => {
          webviewMessages.push(msg);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => Promise<void>) => {
          receiveMessageHandler = cb;
          return { dispose: () => undefined };
        }
      },
      onDidDispose: () => ({ dispose: () => undefined })
    } as unknown as vscode.WebviewPanel;

    const publishSpy = sandbox.spy(intelligence, 'publishInspection');
    customEditor.resolveCustomTextEditor(doc, mockPanel);
    assert.ok(receiveMessageHandler, 'Expected onDidReceiveMessage handler to be registered');

    // Simulate webview posting 'ready' while git contributionContext is still pending
    await receiveMessageHandler({ type: 'ready' });

    const docStateMessages = webviewMessages.filter((m) => m.type === 'documentState');
    assert.strictEqual(
      docStateMessages.length,
      1,
      'Expected exactly one immediate documentState message without recursive onDidInspectDocument loop'
    );
    assert.strictEqual(
      publishSpy.callCount,
      1,
      'Expected validateDocument to publish inspection at most once on cold cache'
    );
    assert.strictEqual(
      contribProviderSpy.callCount,
      1,
      'Expected contributionContextProvider to be invoked once in background'
    );

    // Resolve the background contribution context and verify contributionContextUpdated is posted
    resolveContributionContext({
      isCollectionWorkspace: true,
      workspaceDir: tmpDir,
      collectionsPath: 'collections',
      collectionFiles: ['collections/python-development.collection.yml'],
      upstreamSlug: 'Amadeus-xDLC/utopy.migration-skills',
      currentBranch: 'feat/collection-utopy-migration',
      defaultBranch: 'main',
      modifiedFiles: [],
      hasUncommittedChanges: false
    });
    await slowContributionContextPromise;
    await new Promise((r) => setTimeout(r, 10));

    const contribUpdatedMessages = webviewMessages.filter((m) => m.type === 'contributionContextUpdated');
    assert.strictEqual(contribUpdatedMessages.length, 1, 'Expected contributionContextUpdated message once git status resolves');

    intelligence.dispose();
    treeProvider.dispose();
  });
});
