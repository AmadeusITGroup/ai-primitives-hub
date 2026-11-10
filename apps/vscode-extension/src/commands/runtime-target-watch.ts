/**
 * External-change watching for target management: the user lockfile, the
 * workspace lockfiles and the selection file are shared with the CLI, so a
 * change made there refreshes the extension's views without a reload.
 * Polling `fs.watchFile` is used because it also covers files that do not
 * exist yet.
 * @module commands/runtime-target-watch
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';

const POLL_MS = 250;
const DEBOUNCE_MS = 150;

/**
 * Files whose change affects installations or the selected harness.
 * @param env
 */
export function watchedTargetFiles(env: Readonly<Record<string, string | undefined>>): string[] {
  const paths = new XdgAppStorage(env).getPaths();
  const files = [
    path.join(paths.root, 'ai-primitives-hub.lock.json'),
    path.join(paths.root, 'imports.json'),
    ...(paths.state === undefined ? [] : [path.join(paths.state, 'target-selection.json')])
  ];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    files.push(path.join(folder.uri.fsPath, 'prompt-registry.lock.json'), path.join(folder.uri.fsPath, 'prompt-registry.local.lock.json'));
  }
  return files;
}

/**
 * Watch the target-management files; `onChange` is debounced.
 * @param env
 * @param onChange
 */
export function watchTargetFiles(env: Readonly<Record<string, string | undefined>>, onChange: () => void): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let files: string[] = [];
  const listener = (curr: fs.Stats, prev: fs.Stats): void => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };
  const attach = (): void => {
    for (const file of files) {
      fs.unwatchFile(file, listener);
    }
    files = watchedTargetFiles(env);
    for (const file of files) {
      fs.watchFile(file, { interval: POLL_MS, persistent: false }, listener);
    }
  };
  attach();
  const folders = vscode.workspace.onDidChangeWorkspaceFolders?.(() => {
    attach();
    onChange();
  });
  return {
    dispose: () => {
      clearTimeout(timer);
      for (const file of files) {
        fs.unwatchFile(file, listener);
      }
      folders?.dispose();
    }
  };
}
