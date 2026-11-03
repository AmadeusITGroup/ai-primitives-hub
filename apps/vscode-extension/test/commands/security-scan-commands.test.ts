import * as assert from 'node:assert';
import type {
  SecurityScanResult,
} from '@ai-primitives-hub/app';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  SecurityScanCommands,
} from '../../src/commands/security-scan-commands';

const resultFor = (file: string, findings = true, complete = true, rootId = '/repo'): SecurityScanResult => ({
  complete,
  coverage: {
    scanned: [{ rootId, path: file, bytes: 10 }],
    ignored: [], skipped: [], errors: []
  },
  findings: findings
    ? [{
      rootId, file, ruleId: 'SEC-001', line: 1, severity: 'HIGH',
      title: 'Credential', recommendedFix: 'Remove credential',
      confidence: 'HIGH', category: 'secrets', vulnerableContent: '[REDACTED]',
      risk: 'Credential exposure', fingerprint: 'a'.repeat(32), canonicalFingerprint: 'b'.repeat(32)
    }]
    : [],
  summary: { active: { total: findings ? 1 : 0 }, suppressed: { total: 0 } },
  errors: complete ? [] : [{ code: 'SECURITY.INPUT_UNREADABLE', message: 'Unreadable' }],
  warnings: []
} as unknown as SecurityScanResult);

suite('SecurityScanCommands', () => {
  let sandbox: sinon.SinonSandbox;
  let commands: Map<string, (...args: any[]) => any>;
  let onOpen: (document: vscode.TextDocument) => void;
  let onSave: (document: vscode.TextDocument) => void;
  let onClose: (document: vscode.TextDocument) => void;
  let onConfiguration: (event: vscode.ConfigurationChangeEvent) => void;
  let diagnostics: vscode.DiagnosticCollection;
  let status: vscode.StatusBarItem;
  let scanner: {
    scanFile: sinon.SinonStub;
    scanWorkspaces: sinon.SinonStub;
    cancelAll: sinon.SinonStub;
    dispose: sinon.SinonStub;
    getLastResult: sinon.SinonStub;
  };
  let controller: SecurityScanCommands;

  const document = (file = '/repo/first.md', scheme = 'file'): vscode.TextDocument => ({
    uri: { ...vscode.Uri.file(file), scheme },
    isUntitled: false, isClosed: false
  } as vscode.TextDocument);
  const runFile = async (result: SecurityScanResult, doc = document()): Promise<void> => {
    scanner.scanFile.resolves(result);
    sandbox.stub(vscode.window, 'activeTextEditor').value({ document: doc });
    await commands.get('promptregistry.securityScanFile')!();
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
    sandbox.stub(vscode.workspace, 'textDocuments').value([]);
    sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake((handler) => {
      onConfiguration = handler;
      return { dispose: () => undefined };
    });
    commands = new Map();
    sandbox.stub(vscode.commands, 'registerCommand').callsFake((id, handler) => {
      commands.set(id, handler);
      return { dispose: () => commands.delete(id) };
    });
    sandbox.stub(vscode.workspace, 'onDidOpenTextDocument').callsFake((handler) => {
      onOpen = handler;
      return { dispose: () => undefined };
    });
    sandbox.stub(vscode.workspace, 'onDidSaveTextDocument').callsFake((handler) => {
      onSave = handler;
      return { dispose: () => undefined };
    });
    sandbox.stub(vscode.workspace, 'onDidCloseTextDocument').callsFake((handler) => {
      onClose = handler;
      return { dispose: () => undefined };
    });
    diagnostics = vscode.languages.createDiagnosticCollection('test-security');
    sandbox.stub(vscode.languages, 'createDiagnosticCollection').returns(diagnostics);
    status = vscode.window.createStatusBarItem();
    sandbox.stub(vscode.window, 'createStatusBarItem').returns(status);
    scanner = {
      scanFile: sandbox.stub().resolves(resultFor('first.md')),
      scanWorkspaces: sandbox.stub().resolves(resultFor('first.md')),
      cancelAll: sandbox.stub(), dispose: sandbox.stub(), getLastResult: sandbox.stub()
    };
    controller = new SecurityScanCommands(scanner);
    controller.register();
  });

  teardown(() => {
    controller?.dispose();
    sandbox.restore();
  });

  test('single-file scans retain unrelated diagnostics and clear a newly clean file', async () => {
    await runFile(resultFor('first.md'));
    await runFile(resultFor('second.md'), document('/repo/second.md'));
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length, 1);
    await runFile(resultFor('second.md', false), document('/repo/second.md'));
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length, 1);
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/second.md'))?.length ?? 0, 0);
    assert.ok(status.text.includes('1'));
  });

  test('minimum severity changes re-filter cached diagnostics in both directions without rescanning', async () => {
    await runFile(resultFor('first.md'));
    const panel = vscode.window.createWebviewPanel('test', 'test', vscode.ViewColumn.Beside, {});
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    commands.get('promptregistry.securityShowLastReport')!();
    assert.ok(panel.webview.html.includes('SEC-001'));
    let minimum = 'CRITICAL';
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, fallback: unknown) => key === 'minimumSeverity' ? minimum : fallback
    } as vscode.WorkspaceConfiguration);
    onConfiguration({ affectsConfiguration: (key: string) => key === 'promptregistry.security.minimumSeverity' });
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length ?? 0, 0);
    assert.ok(!panel.webview.html.includes('SEC-001'));
    minimum = 'HIGH';
    onConfiguration({ affectsConfiguration: (key: string) => key === 'promptregistry.security.minimumSeverity' });
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length, 1);
    assert.ok(panel.webview.html.includes('SEC-001'));
    assert.strictEqual(scanner.scanFile.callCount, 1);
  });

  test('registration schedules already-open trusted local Markdown documents', async () => {
    const clock = sandbox.useFakeTimers();
    controller.dispose();
    sandbox.stub(vscode.workspace, 'textDocuments').value([document(), document('/repo/virtual.md', 'vscode-vfs')]);
    controller = new SecurityScanCommands(scanner);
    controller.register();
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.callCount, 1);
    assert.strictEqual(scanner.scanFile.firstCall.args[0], '/repo/first.md');
  });

  test('manual current-file scans accept supported Claude settings', async () => {
    await runFile(resultFor('settings.json'), document('/repo/.claude/settings.json'));
    assert.strictEqual(scanner.scanFile.callCount, 1);
    await runFile(resultFor('settings.json'), document('/repo/settings.json'));
    assert.strictEqual(scanner.scanFile.callCount, 1);
  });

  test('closed report panels are released before controller disposal', () => {
    let close!: () => void;
    const panel = vscode.window.createWebviewPanel('test', 'test', vscode.ViewColumn.Beside, {});
    const dispose = sandbox.stub(panel, 'dispose').callsFake(() => close());
    sandbox.stub(panel, 'onDidDispose').callsFake((listener) => {
      close = listener;
      return { dispose: () => undefined };
    });
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    scanner.getLastResult.returns(resultFor('first.md', false));
    commands.get('promptregistry.securityShowLastReport')!();
    dispose();
    dispose.resetHistory();
    controller.dispose();
    assert.strictEqual(dispose.called, false);
  });

  test('older workspace results cannot replace newer file diagnostics or resurrect cleared findings', async () => {
    const information = sandbox.stub(vscode.window, 'showInformationMessage');
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ name: 'repo', uri: vscode.Uri.file('/repo') }]);
    let finish!: (result: SecurityScanResult) => void;
    scanner.scanWorkspaces.callsFake(() => new Promise<SecurityScanResult>((resolve) => {
      finish = resolve;
    }));
    const pending = commands.get('promptregistry.securityScanWorkspace')!();
    await runFile(resultFor('first.md'));
    finish(resultFor('first.md', false));
    await pending;
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length, 1);
    assert.strictEqual(information.called, false);
    const panel = vscode.window.createWebviewPanel('test', 'test', vscode.ViewColumn.Beside, {});
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    scanner.getLastResult.returns(resultFor('first.md', false));
    commands.get('promptregistry.securityShowLastReport')!();
    assert.ok(panel.webview.html.includes('SEC-001'));

    const older = commands.get('promptregistry.securityScanWorkspace')!();
    await runFile(resultFor('first.md', false));
    finish(resultFor('first.md'));
    await older;
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length ?? 0, 0);
  });

  test('older file results cannot replace a newer workspace scan', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ name: 'repo', uri: vscode.Uri.file('/repo') }]);
    let finish!: (result: SecurityScanResult) => void;
    scanner.scanFile.returns(new Promise<SecurityScanResult>((resolve) => {
      finish = resolve;
    }));
    sandbox.stub(vscode.window, 'activeTextEditor').value({ document: document() });
    const pending = commands.get('promptregistry.securityScanFile')!();
    scanner.scanWorkspaces.resolves(resultFor('first.md', false));
    await commands.get('promptregistry.securityScanWorkspace')!();
    finish(resultFor('first.md'));
    await pending;
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length ?? 0, 0);
  });

  test('incomplete manual scans show errors, not a clear status or completion', async () => {
    const error = sandbox.stub(vscode.window, 'showErrorMessage');
    const info = sandbox.stub(vscode.window, 'showInformationMessage');
    await runFile(resultFor('first.md', false, false));
    assert.ok(status.text.includes('incomplete'));
    assert.ok(error.firstCall.args[0].includes('SECURITY.INPUT_UNREADABLE'));
    assert.strictEqual(info.called, false);
  });

  test('scans with no evaluated files do not claim to be clear', async () => {
    const warning = sandbox.stub(vscode.window, 'showWarningMessage');
    const result = resultFor('first.md', false);
    result.coverage.scanned = [];
    await runFile(result);

    assert.ok(status.text.includes('no files scanned'));
    assert.ok(warning.firstCall.args[0].includes('No files were scanned'));
  });

  test('manual scans reject virtual documents but allow local files in untrusted workspaces without trusting ignores', async () => {
    sandbox.stub(vscode.workspace, 'isTrusted').value(false);
    await runFile(resultFor('first.md'), document('/repo/first.md', 'vscode-vfs'));
    assert.strictEqual(scanner.scanFile.called, false);
    await runFile(resultFor('first.md'));
    assert.strictEqual(scanner.scanFile.lastCall.args[1].ignoreTrust, 'none');
  });

  test('automatic scans are debounced and gated for trusted local nonvirtual workspaces', async () => {
    const clock = sandbox.useFakeTimers();
    onOpen(document());
    onSave(document());
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.callCount, 1);
    scanner.scanFile.resetHistory();
    sandbox.stub(vscode.workspace, 'isTrusted').value(false);
    onSave(document());
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.called, false);
    sandbox.stub(vscode.workspace, 'isTrusted').value(true);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { scheme: 'vscode-vfs' } }]);
    onOpen(document());
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.called, false);
  });

  test('automatic scans reject virtual, dirty, untitled, closed, and non-Markdown documents', async () => {
    const clock = sandbox.useFakeTimers();
    onOpen(document('/repo/first.md', 'vscode-vfs'));
    onOpen({ ...document(), isDirty: true });
    onOpen({ ...document(), isUntitled: true });
    onOpen({ ...document(), isClosed: true });
    onOpen(document('/repo/file.txt'));
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.called, false);
  });

  test('pending automatic scans recheck the enabled setting before starting', async () => {
    const clock = sandbox.useFakeTimers();
    onSave(document());
    const configuration = {
      get: (key: string, defaultValue: unknown) => key === 'scanOnSave' ? false : defaultValue
    } as vscode.WorkspaceConfiguration;
    sandbox.stub(vscode.workspace, 'getConfiguration').returns(configuration);
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.called, false);
  });

  test('pending timers recheck configuration and trust, and are removed on close and disposal', async () => {
    const clock = sandbox.useFakeTimers();
    onSave(document());
    sandbox.stub(vscode.workspace, 'isTrusted').value(false);
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.called, false);
    sandbox.stub(vscode.workspace, 'isTrusted').value(true);
    onSave(document());
    onClose(document());
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.called, false);
    onSave(document());
    controller.dispose();
    await clock.tickAsync(300);
    assert.strictEqual(scanner.scanFile.called, false);
    assert.ok(scanner.dispose.called);
  });

  test('workspace scans combine local roots into one report and reject virtual roots', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { name: 'first', uri: vscode.Uri.file('/repo') },
      { name: 'second', uri: vscode.Uri.file('/other') }
    ]);
    await commands.get('promptregistry.securityScanWorkspace')!();
    assert.deepStrictEqual(scanner.scanWorkspaces.firstCall.args[0], ['/repo', '/other']);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ name: 'virtual', uri: { scheme: 'vscode-vfs' } }]);
    scanner.scanWorkspaces.resetHistory();
    await commands.get('promptregistry.securityScanWorkspace')!();
    assert.strictEqual(scanner.scanWorkspaces.called, false);
  });

  test('complete workspace scans remove stale findings only inside scanned roots; incomplete scans retain them', async () => {
    await runFile(resultFor('first.md'));
    await runFile(resultFor('outside.md', true, true, '/other'), document('/other/outside.md'));
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ name: 'repo', uri: vscode.Uri.file('/repo') }]);
    scanner.scanWorkspaces.resolves(resultFor('clean.md', false, false));
    await commands.get('promptregistry.securityScanWorkspace')!();
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md'))?.length, 1);
    scanner.scanWorkspaces.resolves(resultFor('clean.md', false));
    await commands.get('promptregistry.securityScanWorkspace')!();
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md')), undefined);
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/other/outside.md'))?.length, 1);
  });

  test('reports rejected manual scans explicitly and ignores late results after clearing', async () => {
    const error = sandbox.stub(vscode.window, 'showErrorMessage');
    scanner.scanFile.rejects(new Error('Security scan worker is not packaged'));
    sandbox.stub(vscode.window, 'activeTextEditor').value({ document: document() });
    await commands.get('promptregistry.securityScanFile')!();
    assert.ok(error.firstCall.args[0].includes('worker is not packaged'));
    let finish!: (result: SecurityScanResult) => void;
    scanner.scanFile.returns(new Promise<SecurityScanResult>((resolve) => {
      finish = resolve;
    }));
    const pending = commands.get('promptregistry.securityScanFile')!();
    commands.get('promptregistry.securityClearDiagnostics')!();
    finish(resultFor('first.md'));
    await pending;
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md')), undefined);
    assert.ok(scanner.cancelAll.called);
  });

  test('disposal suppresses late scan results and notifications', async () => {
    const info = sandbox.stub(vscode.window, 'showInformationMessage');
    let finish!: (result: SecurityScanResult) => void;
    scanner.scanFile.returns(new Promise<SecurityScanResult>((resolve) => {
      finish = resolve;
    }));
    sandbox.stub(vscode.window, 'activeTextEditor').value({ document: document() });
    const pending = commands.get('promptregistry.securityScanFile')!();
    controller.dispose();
    finish(resultFor('first.md', false));
    await pending;
    assert.strictEqual(diagnostics.get(vscode.Uri.file('/repo/first.md')), undefined);
    assert.strictEqual(info.called, false);
  });
});
