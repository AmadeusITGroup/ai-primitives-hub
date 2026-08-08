/**
 * Extension Context Test Helpers
 *
 * Shared mock `vscode.ExtensionContext` factory. Services that follow the
 * singleton pattern (`RegistryManager`, `HubManager`, ...) require a context
 * on their first `getInstance()` call, so nearly every service test needs
 * one; this is the single place that shape is defined.
 *
 * Usage:
 * ```typescript
 * import { createMockExtensionContext } from '../helpers/extension-context-helpers';
 *
 * const manager = RegistryManager.getInstance(createMockExtensionContext(sandbox));
 * ```
 */

import * as sinon from 'sinon';
import * as vscode from 'vscode';

/**
 * Create a mock VS Code ExtensionContext backed by sinon stubs.
 *
 * Stubs come from the caller's sandbox so `sandbox.restore()` cleans them up.
 * @param sandbox - Sinon sandbox owning the stubs.
 * @returns A mock ExtensionContext.
 */
export function createMockExtensionContext(sandbox: sinon.SinonSandbox): vscode.ExtensionContext {
  return {
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
    extensionPath: '/mock/path',
    extensionUri: vscode.Uri.file('/mock/path'),
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global'),
    asAbsolutePath: (p: string) => `/mock/path/${p}`
  } as any;
}
