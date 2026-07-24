/**
 * Host → target-type resolution (pure, environment-signal helper).
 *
 * Maps a host editor's runtime identity signals (application name and uri
 * scheme) to a `TargetType`. Pure and framework-free — no dependency on
 * `vscode` or any delivery framework — so it lives in `infra` alongside the
 * other pure environment-derived helpers (e.g. `storage/xdg-base-dirs`, which
 * resolves directories from `XDG_*` signals). It depends only on `core`.
 *
 * The delivery layer READS the signals (e.g. the extension reads
 * `vscode.env.appName` / `vscode.env.uriScheme`) and passes them here; no
 * `vscode` dependency leaks into `infra`/`app`/`core`, and both the extension
 * and the CLI can reuse this resolution.
 * @module host/host-target
 */
import type {
  TargetType,
} from '@ai-primitives-hub/core';

/**
 * Resolve the host editor's target type from its reported identity signals.
 *
 * Matching is case-insensitive and ordered over the combined `appName` and
 * `uriScheme` strings: the first pattern that appears as a substring in
 * either wins. Detection covers only editors that are VS Code forks (and
 * therefore actually run the extension): Kiro, Windsurf, and VS Code
 * stable/Insiders. `devin` maps to `windsurf` (Devin is a Windsurf rebrand
 * sharing its on-disk paths). Claude Code is a standalone CLI, not a VS Code
 * fork, so it is never a detected host (though `claude-code` remains a valid
 * explicit CLI layout target). Any unrecognized host falls back to `'vscode'`,
 * preserving the default `.github/` behavior (no regression).
 * @param appName - Host application name (e.g. `vscode.env.appName`).
 * @param uriScheme - Host uri scheme (e.g. `vscode.env.uriScheme`).
 * @returns The resolved `TargetType`.
 */
export function resolveHostTargetType(appName?: string, uriScheme?: string): TargetType {
  const signal = `${appName ?? ''} ${uriScheme ?? ''}`.toLowerCase();

  if (signal.includes('kiro')) {
    return 'kiro';
  }
  // Devin is a Windsurf rebrand; both resolve to the windsurf layout.
  if (signal.includes('windsurf') || signal.includes('devin')) {
    return 'windsurf';
  }
  if (signal.includes('insiders')) {
    return 'vscode-insiders';
  }
  return 'vscode';
}
