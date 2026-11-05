import * as path from 'node:path';
import type {
  SecurityScanResult,
} from '@ai-primitives-hub/app';
import type {
  SecuritySeverity,
} from '@ai-primitives-hub/core';
import {
  SECURITY_SEVERITIES,
  selectSeverities,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  SecurityScanService,
  type SecurityScanServiceOptions,
} from '../services/security-scan-service';
import {
  renderSecurityReportHtml,
} from '../ui/security-report';
import {
  Logger,
} from '../utils/logger';

export interface SecurityScanner {
  scanFile(file: string, options: SecurityScanServiceOptions): Promise<SecurityScanResult>;
  scanWorkspaces(roots: readonly string[], options: SecurityScanServiceOptions): Promise<SecurityScanResult>;
  getLastResult(): SecurityScanResult | undefined;
  cancelAll(): void;
  dispose(): void;
}

const diagnosticSeverity = (severity: SecuritySeverity): vscode.DiagnosticSeverity => {
  if (severity === 'CRITICAL' || severity === 'HIGH') {
    return vscode.DiagnosticSeverity.Error;
  }
  if (severity === 'MEDIUM') {
    return vscode.DiagnosticSeverity.Warning;
  }
  return severity === 'LOW' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint;
};

const withinRoot = (file: string, root: string): boolean => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export class SecurityScanCommands implements vscode.Disposable {
  private readonly logger = Logger.getInstance();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('promptregistry-security');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly versions = new Map<string, number>();
  private readonly findingsByFile = new Map<string, { diagnostic: vscode.Diagnostic; severity: SecuritySeverity }[]>();
  private readonly fileGenerations = new Map<string, number>();
  private readonly workspaceGenerations = new Map<string, number>();
  private generation = 0;
  private lastPresentation?: SecurityScanResult;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly reportPanels = new Set<vscode.WebviewPanel>();
  private epoch = 0;
  private disposed = false;

  public constructor(private readonly scanner: SecurityScanner = new SecurityScanService()) {}

  private options(): SecurityScanServiceOptions {
    const configuration = vscode.workspace.getConfiguration('promptregistry.security');
    const minimum = configuration.get<string>('minimumSeverity', 'INFO').toUpperCase();
    return {
      minimumSeverity: (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(minimum) ? minimum : 'INFO') as SecuritySeverity,
      includeLlmControls: configuration.get<boolean>('includeLlmControls', false),
      showInfoControls: configuration.get<boolean>('showInfoControls', true),
      ignoreTrust: vscode.workspace.isTrusted ? 'repository' : 'none'
    };
  }

  private localDocument(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'file' && !document.isUntitled && !document.isClosed
      && /\.(md|markdown)$/i.test(document.uri.fsPath);
  }

  private supportedDocument(document: vscode.TextDocument): boolean {
    return this.localDocument(document) || (document.uri.scheme === 'file' && !document.isUntitled && !document.isClosed
      && path.basename(path.dirname(document.uri.fsPath)) === '.claude'
      && ['settings.json', 'settings.local.json'].includes(path.basename(document.uri.fsPath)));
  }

  private scanOptions(): SecurityScanServiceOptions {
    return { ...this.options(), minimumSeverity: 'INFO' };
  }

  private selectedSeverities(): readonly SecuritySeverity[] {
    return SECURITY_SEVERITIES.slice(0, SECURITY_SEVERITIES.indexOf(this.options().minimumSeverity ?? 'INFO') + 1);
  }

  private filteredResult(result: SecurityScanResult): SecurityScanResult {
    const findings = selectSeverities(result.findings, this.selectedSeverities());
    return {
      ...result, findings,
      summary: {
        ...result.summary,
        active: {
          total: findings.length,
          bySeverity: Object.fromEntries(SECURITY_SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]))
        }
      }
    };
  }

  private automaticAllowed(document: vscode.TextDocument, setting: string): boolean {
    return !this.disposed && vscode.workspace.isTrusted && this.localDocument(document) && !document.isDirty
      && !(vscode.workspace.workspaceFolders ?? []).some((folder) => folder.uri.scheme !== 'file')
      && vscode.workspace.getConfiguration('promptregistry.security').get<boolean>(setting, true);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private schedule(document: vscode.TextDocument, setting: string): void {
    const key = document.uri.toString();
    this.clearTimer(key);
    if (!this.automaticAllowed(document, setting)) {
      return;
    }
    const configuredDelay = vscode.workspace.getConfiguration('promptregistry.security').get<number>('debounceMs', 300);
    const delay = Number.isFinite(configuredDelay) ? Math.max(100, Math.min(5000, configuredDelay)) : 300;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.automaticAllowed(document, setting)) {
        void this.run(key, () => this.scanner.scanFile(document.uri.fsPath, this.scanOptions()), false, undefined, document.uri.fsPath);
      }
    }, delay));
  }

  private async scanCurrentFile(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined) {
      void vscode.window.showWarningMessage('AI Primitives Hub: No active file to scan.');
      return;
    }
    if (!this.supportedDocument(document) || document.isDirty) {
      void vscode.window.showWarningMessage('AI Primitives Hub: Save a local Markdown or supported .claude/settings JSON file before scanning. Virtual and untitled documents cannot be scanned.');
      return;
    }
    this.clearTimer(document.uri.toString());
    await this.run(document.uri.toString(), () => this.scanner.scanFile(document.uri.fsPath, this.scanOptions()), true, undefined, document.uri.fsPath);
  }

  private async scanWorkspace(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
      void vscode.window.showWarningMessage('AI Primitives Hub: No workspace folder to scan.');
      return;
    }
    if (folders.some((folder) => folder.uri.scheme !== 'file')) {
      void vscode.window.showWarningMessage('AI Primitives Hub: Workspace security scans require local folders; virtual workspaces cannot be scanned.');
      return;
    }
    const roots = folders.map((folder) => folder.uri.fsPath);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'AI Primitives Hub Security Scan',
      cancellable: false
    }, async () => this.run('workspace', () => this.scanner.scanWorkspaces(roots, this.scanOptions()), true, roots));
  }

  private async run(key: string, scan: () => Promise<SecurityScanResult>, manual: boolean, roots?: readonly string[], file?: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const epoch = this.epoch;
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    const generation = ++this.generation;
    if (roots === undefined) {
      if (file !== undefined) {
        this.fileGenerations.set(path.resolve(file), generation);
      }
    } else {
      for (const root of roots) {
        this.workspaceGenerations.set(root, generation);
      }
    }
    const current = (): boolean => !this.disposed && epoch === this.epoch && this.versions.get(key) === version
      && (file === undefined || ![...this.workspaceGenerations].some(([root, started]) => started > generation && withinRoot(file, root)))
      && (roots === undefined || ![...this.fileGenerations].some(([scannedFile, started]) =>
        started > generation && roots.some((root) => withinRoot(scannedFile, root))));
    try {
      const rawResult = await scan();
      if (!current()) {
        return;
      }
      const result = this.filteredResult(rawResult);
      this.present(rawResult, roots);
      if (!result.complete) {
        const errors = result.errors.map((error) => `${error.code}: ${error.message}`).join('; ');
        const message = `AI Primitives Hub: Security scan incomplete. ${errors || 'Review scan coverage in the security report.'}`;
        this.logger.warn(message);
        if (manual) {
          void vscode.window.showErrorMessage(message);
        }
      } else if (manual) {
        if (result.coverage.scanned.length === 0) {
          void vscode.window.showWarningMessage('AI Primitives Hub: No files were scanned. Review ignored and skipped files in the security report.');
        } else if (result.summary.active.total > 0) {
          void vscode.window.showWarningMessage(`AI Primitives Hub: ${String(result.summary.active.total)} security finding(s). Show Last Security Report for details.`);
        } else {
          void vscode.window.showInformationMessage('AI Primitives Hub: Security scan complete; no security findings in scanned files.');
        }
      }
    } catch (error) {
      if (!current()) {
        return;
      }
      const message = `AI Primitives Hub: Security scan failed. ${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn(message, error);
      this.status.text = '$(warning) Security scan: failed';
      this.status.tooltip = message;
      if (manual) {
        void vscode.window.showErrorMessage(message);
      }
    }
  }

  private present(result: SecurityScanResult, roots?: readonly string[]): void {
    if (result.complete && roots !== undefined) {
      for (const file of this.findingsByFile.keys()) {
        if (roots.some((root) => withinRoot(file, root))) {
          this.diagnostics.delete(vscode.Uri.file(file));
          this.findingsByFile.delete(file);
        }
      }
    }
    const grouped = new Map<string, { diagnostic: vscode.Diagnostic; severity: SecuritySeverity }[]>(
      result.coverage.scanned.map((file) => [path.join(file.rootId, file.path), []])
    );
    for (const finding of result.findings) {
      const root = finding.rootId ?? result.coverage.scanned.find((scanned) => scanned.path === finding.file)?.rootId;
      if (root === undefined) {
        continue;
      }
      const file = path.join(root, finding.file);
      const line = Math.max(0, (finding.line ?? 1) - 1);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        `[${finding.ruleId}] ${finding.title} — Fix: ${finding.recommendedFix}`,
        diagnosticSeverity(finding.severity)
      );
      diagnostic.source = 'AI Primitives Hub Security Scanner';
      diagnostic.code = finding.ruleId;
      grouped.set(file, [...(grouped.get(file) ?? []), { diagnostic, severity: finding.severity }]);
    }
    for (const [file, findings] of grouped) {
      this.findingsByFile.set(file, findings);
    }
    this.lastPresentation = result;
    this.refreshDiagnostics(result);
  }

  private refreshDiagnostics(result: SecurityScanResult): void {
    let total = 0;
    for (const [file, findings] of this.findingsByFile) {
      const visible = selectSeverities(findings, this.selectedSeverities()).map((finding) => finding.diagnostic);
      total += visible.length;
      this.diagnostics.set(vscode.Uri.file(file), visible);
    }
    if (!result.complete) {
      this.status.text = '$(warning) Security scan: incomplete';
    } else if (result.coverage.scanned.length === 0) {
      this.status.text = '$(shield) Security scan: no files scanned';
    } else {
      this.status.text = total === 0 ? '$(shield) Security scan: clear' : `$(shield) Security scan: ${String(total)}`;
    }
    this.status.tooltip = `${String(total)} active diagnostic(s). ${result.complete ? 'Show the latest security report.' : 'Incomplete coverage; show the latest security report for errors.'}`;
  }

  private showReport(): void {
    const result = this.lastPresentation ?? this.scanner.getLastResult();
    if (result === undefined) {
      void vscode.window.showInformationMessage('AI Primitives Hub: No security report is available.');
      return;
    }
    const panel = vscode.window.createWebviewPanel('promptregistrySecurityReport', 'Security scan report', vscode.ViewColumn.Beside, { enableScripts: false });
    panel.webview.html = renderSecurityReportHtml(this.filteredResult(result));
    this.reportPanels.add(panel);
    panel.onDidDispose(() => this.reportPanels.delete(panel));
  }

  private clear(): void {
    this.epoch++;
    for (const key of this.timers.keys()) {
      this.clearTimer(key);
    }
    this.scanner.cancelAll();
    this.diagnostics.clear();
    this.findingsByFile.clear();
    this.fileGenerations.clear();
    this.workspaceGenerations.clear();
    this.lastPresentation = undefined;
    this.status.text = '$(shield) Security scan: diagnostics cleared';
    this.status.tooltip = 'Diagnostics cleared; this does not establish that files are safe. Show the latest security report.';
  }

  public register(): vscode.Disposable {
    this.status.command = 'promptregistry.securityShowLastReport';
    this.status.text = '$(shield) Security scan';
    this.status.tooltip = 'Show the latest security scan report';
    this.status.show();
    this.subscriptions.push(
      vscode.commands.registerCommand('promptregistry.securityScanFile', () => this.scanCurrentFile()),
      vscode.commands.registerCommand('promptregistry.securityScanWorkspace', () => this.scanWorkspace()),
      vscode.commands.registerCommand('promptregistry.securityClearDiagnostics', () => this.clear()),
      vscode.commands.registerCommand('promptregistry.securityShowLastReport', () => this.showReport()),
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document, 'scanOnOpen')),
      vscode.workspace.onDidSaveTextDocument((document) => this.schedule(document, 'scanOnSave')),
      vscode.workspace.onDidCloseTextDocument((document) => this.clearTimer(document.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('promptregistry.security.minimumSeverity') && this.lastPresentation !== undefined) {
          this.refreshDiagnostics(this.lastPresentation);
          const result = this.lastPresentation ?? this.scanner.getLastResult();
          if (result !== undefined) {
            for (const panel of this.reportPanels) {
              panel.webview.html = renderSecurityReportHtml(this.filteredResult(result));
            }
          }
        }
      })
    );
    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document, 'scanOnOpen');
    }
    return this;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear();
    this.scanner.dispose();
    for (const panel of this.reportPanels) {
      panel.dispose();
    }
    this.reportPanels.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.diagnostics.dispose();
    this.status.dispose();
  }
}
