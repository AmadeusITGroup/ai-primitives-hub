/**
 * Run `ValidateCollectionsCommand` against a directory and capture what the
 * user sees: the "Collection Validator" output channel and the notifications.
 *
 * Only VS Code APIs are stubbed (workspace folders, output channel,
 * notifications); the command and the validation it delegates to are real.
 */
import type * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  ValidateCollectionsCommand,
} from '../../src/commands/validate-collections-command';

/** Output channel name used by the command. */
const VALIDATOR_CHANNEL = 'Collection Validator';
const ERROR_MARKER = '❌ Error: ';
const WARNING_MARKER = 'Warning: ';

/** What one `execute()` run showed to the user. */
export interface ValidateCollectionsRun {
  /** Every `appendLine` call on the validator output channel, in order. */
  lines: string[];
  /** Messages of the `❌ Error:` lines, in order. */
  errors: string[];
  /** Messages of the `Warning:` lines, in order. */
  warnings: string[];
  /** First argument of each `showErrorMessage` call. */
  errorNotifications: string[];
  /** First argument of each `showWarningMessage` call. */
  warningNotifications: string[];
  /** First argument of each `showInformationMessage` call. */
  infoNotifications: string[];
}

/**
 * Extract the message following a marker in an output line.
 * @param line - Output channel line
 * @param marker - Marker preceding the message
 * @returns The message, or undefined when the line has no marker
 */
function messageAfter(line: string, marker: string): string | undefined {
  const index = line.indexOf(marker);
  return index === -1 ? undefined : line.slice(index + marker.length);
}

/**
 * Run the validate-collections command with `workspaceDir` as the only
 * workspace folder.
 * @param sandbox - Sinon sandbox restored by the caller
 * @param workspaceDir - Directory containing `collections/`
 * @param options - Options passed to `execute()`
 * @param options.listOnly - List collections instead of validating them
 * @returns Captured output lines, parsed findings and notifications
 */
export async function runValidateCollections(
  sandbox: sinon.SinonSandbox,
  workspaceDir: string,
  options?: { listOnly?: boolean }
): Promise<ValidateCollectionsRun> {
  const lines: string[] = [];
  const originalCreateOutputChannel = vscode.window.createOutputChannel.bind(vscode.window);
  sandbox.stub(vscode.workspace, 'workspaceFolders').value([
    { uri: vscode.Uri.file(workspaceDir), name: 'workspace', index: 0 }
  ]);
  sandbox.stub(vscode.window, 'createOutputChannel').callsFake(((name: string) => {
    if (name !== VALIDATOR_CHANNEL) {
      return originalCreateOutputChannel(name);
    }
    return {
      appendLine: (line: string) => {
        lines.push(line);
      },
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined
    };
  }) as unknown as typeof vscode.window.createOutputChannel);
  const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
  const showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  const showInformation = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

  const context = { extensionPath: process.cwd() } as unknown as vscode.ExtensionContext;
  const command = new ValidateCollectionsCommand(context);
  try {
    await command.execute(options);
  } finally {
    command.dispose();
  }

  const firstArgs = (stub: sinon.SinonStub): string[] => stub.getCalls().map((call) => String(call.args[0]));
  return {
    lines,
    errors: lines.map((line) => messageAfter(line, ERROR_MARKER)).filter((m): m is string => m !== undefined),
    warnings: lines.map((line) => messageAfter(line, WARNING_MARKER)).filter((m): m is string => m !== undefined),
    errorNotifications: firstArgs(showError),
    warningNotifications: firstArgs(showWarning),
    infoNotifications: firstArgs(showInformation)
  };
}
