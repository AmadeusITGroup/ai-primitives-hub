import * as path from 'node:path';
import type {
  BundleInstallPlan,
  PrimitiveKind,
  Target,
  TargetLayout,
  TargetWriteOperation,
  TargetWritePlan,
} from '@ai-primitives-hub/core';
import {
  expandPath,
  normalizePrimitiveKind,
  normalizePromptId,
} from '@ai-primitives-hub/core';

export class TargetPlanningError extends Error {
  public constructor(
    message: string,
    public readonly code: 'BUNDLE.UNSUPPORTED_CONTENT' | 'BUNDLE.DESTINATION_COLLISION' | 'BUNDLE.INVALID_TARGET_PATH'
  ) {
    super(message);
    this.name = 'TargetPlanningError';
  }
}

/**
 * Resolve semantic bundle items into exact destination write operations.
 * This function is pure with respect to the target filesystem.
 * @param bundlePlan
 * @param target
 * @param layout
 * @param env
 */
export function createTargetWritePlan(
  bundlePlan: BundleInstallPlan,
  target: Target,
  layout: TargetLayout,
  env: Record<string, string | undefined> = process.env
): TargetWritePlan {
  const baseDir = resolveBaseDir(layout.baseDir, env);
  const destinationRoot = target.scope === 'repository'
    ? path.resolve(target.rootPath ?? target.path ?? '.')
    : baseDir;
  const allowedKinds = target.allowedKinds === undefined
    ? null
    : new Set(target.allowedKinds.map((kind) => normalizePrimitiveKind(kind) ?? kind));
  const operations: TargetWriteOperation[] = [];

  for (const item of bundlePlan.items) {
    const route = layout.routes[item.kind];
    if (route === undefined || (allowedKinds !== null && !allowedKinds.has(item.kind))) {
      throw new TargetPlanningError(
        `target "${target.name}" cannot install item "${item.id}" of kind "${item.kind}" from "${item.entryPath}"`,
        'BUNDLE.UNSUPPORTED_CONTENT'
      );
    }

    for (const file of item.files) {
      if (item.kind === 'skill') {
        assertSafeRelativePath(file.relativePath, target.name, item.id, file.sourcePath);
      }
      const destinationRelativePath = item.kind === 'skill'
        ? path.join(route, normalizePromptId(item.id), file.relativePath)
        : path.join(route, singleFileName(item.id, item.kind, file.sourcePath));
      const destinationPath = path.resolve(baseDir, destinationRelativePath);
      assertWithinBase(baseDir, destinationPath, target.name, item.id, file.sourcePath);
      operations.push({
        itemId: item.id,
        kind: item.kind,
        sourcePath: file.sourcePath,
        destinationPath,
        destinationRelativePath: path.relative(destinationRoot, destinationPath).replaceAll(path.sep, '/'),
        bytes: file.bytes,
        sourceChecksum: file.sourceChecksum
      });
    }
  }

  const destinations = new Set<string>();
  for (const operation of operations) {
    if (destinations.has(operation.destinationPath)) {
      throw new TargetPlanningError(
        `target "${target.name}" has multiple items writing "${operation.destinationPath}"`,
        'BUNDLE.DESTINATION_COLLISION'
      );
    }
    destinations.add(operation.destinationPath);
  }

  return {
    target,
    operations: operations.toSorted((left, right) =>
      left.destinationRelativePath.localeCompare(right.destinationRelativePath))
  };
}

function resolveBaseDir(template: string, env: Record<string, string | undefined>): string {
  if (template.length === 0) {
    throw new TargetPlanningError(
      `target base path "${template}" is not fully resolved`,
      'BUNDLE.INVALID_TARGET_PATH'
    );
  }
  const expanded = expandPath(template, env);
  if (expanded.length === 0 || expanded.includes('${')) {
    throw new TargetPlanningError(
      `target base path "${template}" is invalid`,
      'BUNDLE.INVALID_TARGET_PATH'
    );
  }
  return path.resolve(expanded);
}

function assertWithinBase(
  baseDir: string,
  destinationPath: string,
  targetName: string,
  itemId: string,
  sourcePath: string
): void {
  const relative = path.relative(baseDir, destinationPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TargetPlanningError(
      `target "${targetName}" cannot place item "${itemId}" from "${sourcePath}" outside "${baseDir}"`,
      'BUNDLE.INVALID_TARGET_PATH'
    );
  }
}

function assertSafeRelativePath(
  relativePath: string,
  targetName: string,
  itemId: string,
  sourcePath: string
): void {
  if (relativePath.length === 0 || relativePath.startsWith('/') || relativePath.includes('\\')
    || relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TargetPlanningError(
      `target "${targetName}" cannot place item "${itemId}" from "${sourcePath}" with unsafe relative path "${relativePath}"`,
      'BUNDLE.INVALID_TARGET_PATH'
    );
  }
}

function singleFileName(id: string, kind: PrimitiveKind, sourcePath: string): string {
  const safeId = normalizePromptId(id);
  const extensions: Partial<Record<PrimitiveKind, string>> = {
    prompt: '.prompt.md',
    instruction: '.instructions.md',
    'chat-mode': '.chatmode.md',
    agent: '.agent.md'
  };
  const extension = extensions[kind];
  if (extension !== undefined) {
    return `${safeId}${extension}`;
  }
  return `${safeId}${path.extname(sourcePath)}`;
}
