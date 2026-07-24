/**
 * Host editor detection (delivery adapter).
 *
 * Thin delivery-layer adapter that reads the host's runtime identity from
 * the VS Code API (`vscode.env.appName` / `vscode.env.uriScheme`) and
 * delegates the actual signal → `TargetType` policy to `infra`'s pure
 * `resolveHostTargetType`. This is the ONLY place `vscode.env` is read for
 * host detection: keeping the `vscode` touch-point here (and the pure mapping
 * in `infra`) preserves Clean Architecture — no `vscode` dependency leaks into
 * `infra`/`app`/`core`, the mapping stays reusable by other delivery layers
 * (e.g. the CLI), and both are unit-testable without a VS Code mock.
 *
 * This is the single host-detection entry point for the extension, shared by
 * both the repository-scope and user-scope install paths.
 * @module utils/host-editor
 */
import type {
  TargetType,
} from '@ai-primitives-hub/core';
import {
  resolveHostTargetType,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';

/**
 * Detect the host editor's target type from the running VS Code environment.
 *
 * Reads `vscode.env.appName` and `vscode.env.uriScheme` and delegates to
 * `infra`'s `resolveHostTargetType`. Both signals are injectable (defaulting
 * to the corresponding `vscode.env` values) so callers/tests can exercise
 * detection without a live editor.
 * @param appName - Host application name; defaults to `vscode.env.appName`.
 * @param uriScheme - Host uri scheme; defaults to `vscode.env.uriScheme`.
 * @returns The resolved `TargetType`.
 */
export function detectHostTargetType(
  appName: string = vscode.env.appName,
  uriScheme: string = vscode.env.uriScheme
): TargetType {
  return resolveHostTargetType(appName, uriScheme);
}
