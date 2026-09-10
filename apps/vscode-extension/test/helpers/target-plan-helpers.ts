/**
 * Shared test helpers for building a `TargetWritePlan` from a bundle directory.
 *
 * Scope services no longer parse manifests: `syncBundle` requires the shared
 * plan produced by the install pipeline (`BundleInstaller` builds it via
 * `InstallPipeline`). These helpers reproduce exactly that construction —
 * `validateManifest` → `createBundleInstallPlan` → `createTargetWritePlan` over
 * the same `resolveLayout`/`resolveTarget` inputs — so tests exercise the
 * production path instead of a service-local fallback.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createTargetWritePlan,
  resolveLayout,
} from '@ai-primitives-hub/app';
import {
  createBundleInstallPlan,
  type Target,
  type TargetType,
  type TargetWritePlan,
  validateManifest,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  detectHostApp,
} from '../../src/utils/host-app';

/** Minimal shape of a scope service needed to resolve its install target. */
export interface TargetResolvingScopeService {
  resolveTarget?(target: Target): Target;
}

/**
 * Read a bundle directory into the `ExtractedFiles` map the pipeline works with.
 *
 * `deployment-manifest.yml` without a `name` is completed with the bundle id,
 * mirroring `BundleInstaller`'s manifest synthesis for sources that omit it.
 * @param bundleId - Bundle identifier, used as the fallback manifest name.
 * @param bundlePath - Absolute path to the extracted bundle directory.
 * @returns Bundle-relative path to bytes, manifest included.
 */
export function readBundleDirectory(bundleId: string, bundlePath: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      const key = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(entryPath, key);
      } else if (entry.isFile()) {
        files.set(key, fs.readFileSync(entryPath));
      }
    }
  };
  walk(bundlePath, '');

  const manifestBytes = files.get('deployment-manifest.yml');
  if (manifestBytes !== undefined) {
    const parsed = yaml.load(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
      parsed.name = bundleId;
      files.set('deployment-manifest.yml', new TextEncoder().encode(yaml.dump(parsed)));
    }
  }
  return files;
}

/**
 * Build the user-scope target plan `UserScopeService.syncBundle` expects.
 * @param service - Scope service whose `resolveTarget` supplies the resolved base dir.
 * @param bundleId - Bundle identifier.
 * @param bundlePath - Absolute path to the extracted bundle directory.
 * @param targetType - Host target type; defaults to the shared host detector so
 *   it follows the same `vscode.env` stubs the service does.
 * @returns The shared write plan.
 */
export function buildUserScopeTargetPlan(
  service: TargetResolvingScopeService,
  bundleId: string,
  bundlePath: string,
  targetType?: TargetType
): TargetWritePlan {
  const type = targetType ?? detectHostApp();
  const baseTarget: Target = { name: type, type, scope: 'user' };
  const target = service.resolveTarget?.(baseTarget) ?? baseTarget;
  return planFor(bundleId, bundlePath, target);
}

/**
 * Build the repository-scope target plan `RepositoryScopeService.syncBundle` expects.
 * @param bundleId - Bundle identifier.
 * @param bundlePath - Absolute path to the extracted bundle directory.
 * @param workspaceRoot - Repository root the destinations are relative to.
 * @param targetType - Host target type; defaults to the shared host detector.
 * @returns The shared write plan.
 */
export function buildRepositoryScopeTargetPlan(
  bundleId: string,
  bundlePath: string,
  workspaceRoot: string,
  targetType?: TargetType
): TargetWritePlan {
  const type = targetType ?? detectHostApp();
  const target: Target = { name: type, type, scope: 'repository', rootPath: workspaceRoot };
  return planFor(bundleId, bundlePath, target);
}

function planFor(bundleId: string, bundlePath: string, target: Target): TargetWritePlan {
  const files = readBundleDirectory(bundleId, bundlePath);
  const manifest = validateManifest(files, {});
  return createTargetWritePlan(createBundleInstallPlan(files, manifest), target, resolveLayout(target));
}
