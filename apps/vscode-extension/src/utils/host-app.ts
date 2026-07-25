/**
 * Host application detection (delivery adapter).
 *
 * Thin delivery-layer adapter that reads the host application's runtime
 * identity from the VS Code API (`vscode.env.appName` / `vscode.env.uriScheme`)
 * and delegates the actual signal → `TargetType` policy to `infra`'s pure
 * `resolveHostApp`. This is the ONLY place `vscode.env` is read for host-app
 * detection: keeping the `vscode` touch-point here (and the pure mapping in
 * `infra`) preserves Clean Architecture — no `vscode` dependency leaks into
 * `infra`/`app`/`core`, the mapping stays reusable by other delivery layers
 * (e.g. the CLI), and both are unit-testable without a VS Code mock.
 *
 * "Host app" (the editor/tool running the extension: Kiro, VS Code, Windsurf)
 * is deliberately distinct from the OS/machine the app runs on.
 *
 * This is the single host-app detection entry point for the extension, shared
 * by both the repository-scope and user-scope install paths.
 * @module utils/host-app
 */
import type {
  TargetType,
} from '@ai-primitives-hub/core';
import {
  resolveHostApp,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';

/**
 * Detect the host application's target type from the running VS Code
 * environment.
 *
 * Reads `vscode.env.appName` and `vscode.env.uriScheme` and delegates to
 * `infra`'s `resolveHostApp`. Both signals are injectable (defaulting to the
 * corresponding `vscode.env` values) so callers/tests can exercise detection
 * without a live editor.
 * @param appName - Host application name; defaults to `vscode.env.appName`.
 * @param uriScheme - Host application uri scheme; defaults to `vscode.env.uriScheme`.
 * @returns The resolved `TargetType`.
 */
export function detectHostApp(
  appName: string = vscode.env.appName,
  uriScheme: string = vscode.env.uriScheme
): TargetType {
  return resolveHostApp(appName, uriScheme);
}
