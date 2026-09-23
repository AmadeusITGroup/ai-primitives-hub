/**
 * Host application → target-type resolution (pure, environment-signal helper).
 *
 * Maps the identity signals of the *application hosting the extension* (its
 * application name and uri scheme) to a `TargetType`. "Host app" — not "host"
 * — is deliberate: this is the editor/tool running the extension (Kiro,
 * VS Code, Windsurf), distinct from the OS or machine the app runs on.
 *
 * Pure and framework-free — no dependency on `vscode` or any delivery
 * framework — so it lives in `infra` alongside the other pure
 * environment-derived helpers (e.g. `storage/xdg-base-dirs`, which resolves
 * directories from `XDG_*` signals). It depends only on `core`.
 *
 * The delivery layer READS the signals (e.g. the extension reads
 * `vscode.env.appName` / `vscode.env.uriScheme`) and passes them here; no
 * `vscode` dependency leaks into `infra`/`app`/`core`, and both the extension
 * and the CLI can reuse this resolution.
 * @module host-app/host-app-target
 */
import type {
  TargetType,
} from '@ai-primitives-hub/core';

/** Fallback target when no host app is recognized (the default VS Code layout). */
const DEFAULT_HOST_APP_TARGET: TargetType = 'vscode';

/**
 * Ordered detection rules: the first rule whose any-of `patterns` appears as a
 * substring of the combined (lowercased) host-app signal wins. Order matters —
 * more specific host apps come first (e.g. `kiro` before the generic fallback).
 * `devin` maps to `windsurf` (Devin is a Windsurf rebrand sharing its paths).
 * Claude Code is intentionally absent — it is a CLI, not a VS Code fork, so it
 * never runs this extension as a host app (though `claude-code` remains a valid
 * explicit CLI layout target).
 */
const HOST_APP_DETECTION_RULES: readonly { patterns: readonly string[]; target: TargetType }[] = [
  { patterns: ['kiro'], target: 'kiro' },
  { patterns: ['windsurf', 'devin'], target: 'windsurf' },
  { patterns: ['insiders'], target: 'vscode-insiders' }
];

/**
 * Resolve the host application's target type from its reported identity signals.
 *
 * Matching is case-insensitive over the combined `appName` and `uriScheme`
 * strings, applying {@link HOST_APP_DETECTION_RULES} in order. Detection covers
 * only VS Code forks that actually run the extension (Kiro, Windsurf, VS Code
 * stable/Insiders). Any unrecognized host app falls back to `'vscode'`,
 * preserving the default `.github/` behavior (no regression).
 * @param appName - Host application name (e.g. `vscode.env.appName`).
 * @param uriScheme - Host application uri scheme (e.g. `vscode.env.uriScheme`).
 * @returns The resolved `TargetType`.
 */
export function resolveHostApp(appName?: string, uriScheme?: string): TargetType {
  const signal = `${appName ?? ''} ${uriScheme ?? ''}`.toLowerCase();
  const match = HOST_APP_DETECTION_RULES.find(
    (rule) => rule.patterns.some((pattern) => signal.includes(pattern))
  );
  return match?.target ?? DEFAULT_HOST_APP_TARGET;
}
