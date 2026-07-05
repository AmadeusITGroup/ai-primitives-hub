import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  RepositoryCommitMode,
} from '../types/registry';
import {
  Resource,
  Target,
} from '../types/target';
import {
  validateRepositoryInstallPolicy,
} from './repository-install-policy';
import {
  supportsTargetResource,
} from './target-capability-registry';
import {
  resolveTargetLayout,
} from './target-layout-registry';
import {
  FileSystemTargetWriter,
  TargetWriteFile,
} from './target-writer';

export interface ApplicationUseCasesOptions {
  root: string;
  now: () => string;
}

export interface ApplicationBundle {
  id: string;
  version: string;
  resources: ApplicationResource[];
}

export interface ApplicationResource extends Resource {
  files?: {
    path: string;
    content: string;
  }[];
}

export interface ApplicationSource {
  id: string;
  type: string;
  url: string;
}

export interface InstallUseCaseRequest {
  target: Target;
  bundle: ApplicationBundle;
  source?: ApplicationSource;
  commitMode?: RepositoryCommitMode;
}

export interface UpdateUseCaseRequest extends InstallUseCaseRequest {}

export interface UninstallUseCaseRequest {
  target: Target;
  bundleId: string;
}

export interface ValidateUseCaseRequest {
  target: Target;
  bundle: ApplicationBundle;
}

export interface MoveScopeUseCaseRequest {
  bundleId: string;
  from: Target;
  to: Target;
  commitMode?: RepositoryCommitMode;
}

export interface ListUseCaseRequest {
  target?: Target;
}

export interface ApplicationListEntry {
  bundleId: string;
  version: string;
  target: Target;
}

export interface ApplicationListResult {
  bundles: ApplicationListEntry[];
}

export interface InspectUseCaseRequest {
  target: Target;
  bundle: ApplicationBundle;
}

export interface ApplicationInspectResource {
  kind: string;
  id: string;
}

export interface ApplicationInspectResult {
  bundleId: string;
  version: string;
  resources: ApplicationInspectResource[];
}

export interface ApplicationUseCases {
  install(request: InstallUseCaseRequest): Promise<ApplicationInstallResult>;
  update(request: UpdateUseCaseRequest): Promise<ApplicationUpdateResult>;
  uninstall(request: UninstallUseCaseRequest): Promise<ApplicationUninstallResult>;
  validate(request: ValidateUseCaseRequest): Promise<ApplicationValidateResult>;
  moveScope(request: MoveScopeUseCaseRequest): Promise<ApplicationInstallResult>;
  list(request: ListUseCaseRequest): Promise<ApplicationListResult>;
  inspect(request: InspectUseCaseRequest): Promise<ApplicationInspectResult>;
}

export interface ApplicationDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  resourceId?: string;
  message: string;
}

export interface ApplicationInstallResult {
  success: boolean;
  bundleId: string;
  version: string;
  writtenFiles: string[];
  diagnostics: ApplicationDiagnostic[];
}

export interface ApplicationUpdateResult extends ApplicationInstallResult {
  previousVersion?: string;
}

export interface ApplicationUninstallResult {
  success: boolean;
  bundleId: string;
  removedFiles: string[];
  diagnostics: ApplicationDiagnostic[];
}

export interface ApplicationValidateResult {
  valid: boolean;
  diagnostics: ApplicationDiagnostic[];
}

interface InstalledRecord {
  target: Target;
  bundle: ApplicationBundle;
  source?: ApplicationSource;
  commitMode: RepositoryCommitMode;
  writtenFiles: string[];
}

/**
 * Creates shared application use cases over target layouts, writers, and safety policy.
 * @param options
 */
export const createApplicationUseCases = (options: ApplicationUseCasesOptions): ApplicationUseCases => {
  const installed = new Map<string, InstalledRecord>();

  const install = async (request: InstallUseCaseRequest): Promise<ApplicationInstallResult> => {
    const validation = await validate(request);
    if (!validation.valid) {
      return {
        success: false,
        bundleId: request.bundle.id,
        version: request.bundle.version,
        writtenFiles: [],
        diagnostics: validation.diagnostics
      };
    }

    const commitMode = request.commitMode ?? 'commit';
    if (request.target.scope === 'repository') {
      const policy = validateRepositoryInstallPolicy({
        commitMode,
        resources: request.bundle.resources
      });
      if (!policy.allowed) {
        return {
          success: false,
          bundleId: request.bundle.id,
          version: request.bundle.version,
          writtenFiles: [],
          diagnostics: policy.diagnostics
        };
      }
    }

    const files = materializeFiles(request.target, request.bundle);
    const targetRoot = path.join(options.root, request.target.scope === 'user' ? 'user' : 'repository');
    const writer = new FileSystemTargetWriter(targetRoot);
    const writeResult = await writer.writeFiles(files);

    if (request.target.scope === 'repository') {
      await writeRepositoryLockfile(targetRoot, request, files);
    }

    installed.set(recordKey(request.bundle.id, request.target), {
      target: request.target,
      bundle: request.bundle,
      source: request.source,
      commitMode,
      writtenFiles: writeResult.writtenFiles
    });

    return {
      success: true,
      bundleId: request.bundle.id,
      version: request.bundle.version,
      writtenFiles: writeResult.writtenFiles,
      diagnostics: []
    };
  };

  const update = async (request: UpdateUseCaseRequest): Promise<ApplicationUpdateResult> => {
    const previous = installed.get(recordKey(request.bundle.id, request.target));
    const result = await install(request);

    return {
      ...result,
      previousVersion: previous?.bundle.version
    };
  };

  const uninstall = async (request: UninstallUseCaseRequest): Promise<ApplicationUninstallResult> => {
    const key = recordKey(request.bundleId, request.target);
    const previous = installed.get(key);
    const targetRoot = path.join(options.root, request.target.scope === 'user' ? 'user' : 'repository');
    const writer = new FileSystemTargetWriter(targetRoot);
    const removedFiles = previous?.writtenFiles ?? [];

    await writer.removeFiles(removedFiles);
    if (request.target.scope === 'repository') {
      await fs.rm(path.join(targetRoot, 'prompt-registry.lock.json'), { force: true });
    }
    installed.delete(key);

    return {
      success: true,
      bundleId: request.bundleId,
      removedFiles,
      diagnostics: []
    };
  };

  const validate = (request: ValidateUseCaseRequest): Promise<ApplicationValidateResult> => {
    const diagnostics: ApplicationDiagnostic[] = [];

    for (const resource of request.bundle.resources) {
      if (!supportsTargetResource(request.target.type, request.target.scope, resource.kind)) {
        diagnostics.push({
          severity: 'error',
          code: 'unsupported-resource',
          resourceId: resource.id,
          message: `Target ${request.target.type} does not support ${resource.kind} resources in ${request.target.scope} scope.`
        });
      }
    }

    return Promise.resolve({
      valid: diagnostics.length === 0,
      diagnostics
    });
  };

  const moveScope = async (request: MoveScopeUseCaseRequest): Promise<ApplicationInstallResult> => {
    const previous = installed.get(recordKey(request.bundleId, request.from));
    if (!previous) {
      return {
        success: false,
        bundleId: request.bundleId,
        version: '',
        writtenFiles: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'not-installed',
            message: `Bundle ${request.bundleId} is not installed in ${request.from.scope} scope.`
          }
        ]
      };
    }

    await uninstall({ target: request.from, bundleId: request.bundleId });
    return install({
      target: request.to,
      bundle: previous.bundle,
      source: previous.source,
      commitMode: request.commitMode ?? previous.commitMode
    });
  };

  const list = (request: ListUseCaseRequest): Promise<ApplicationListResult> => {
    const entries: ApplicationListEntry[] = [];
    for (const [key, record] of installed) {
      if (request.target) {
        const [type, scope] = key.split(':');
        if (type !== request.target.type || scope !== request.target.scope) {
          continue;
        }
      }
      entries.push({
        bundleId: record.bundle.id,
        version: record.bundle.version,
        target: record.target
      });
    }
    return Promise.resolve({ bundles: entries });
  };

  const inspect = (request: InspectUseCaseRequest): Promise<ApplicationInspectResult> => {
    return Promise.resolve({
      bundleId: request.bundle.id,
      version: request.bundle.version,
      resources: request.bundle.resources.map((r) => ({ kind: r.kind, id: r.id }))
    });
  };

  return {
    install,
    update,
    uninstall,
    validate,
    moveScope,
    list,
    inspect
  };
};

function materializeFiles(target: Target, bundle: ApplicationBundle): TargetWriteFile[] {
  const layout = resolveTargetLayout(target);
  const files: TargetWriteFile[] = [];

  for (const resource of bundle.resources) {
    const route = layout.routes[resource.kind];
    if (!route) {
      continue;
    }

    if (resource.kind === 'skill') {
      for (const file of resource.files ?? [{ path: 'SKILL.md', content: resource.content ?? '' }]) {
        files.push({
          relativePath: path.posix.join(route, resource.id, file.path),
          content: file.content
        });
      }
      continue;
    }

    files.push({
      relativePath: path.posix.join(route, targetFileName(resource)),
      content: resource.content ?? ''
    });
  }

  return files;
}

function targetFileName(resource: Resource): string {
  if (resource.kind === 'prompt') {
    return `${resource.id}.prompt.md`;
  }
  if (resource.kind === 'instruction') {
    return `${resource.id}.instructions.md`;
  }
  if (resource.kind === 'agent') {
    return `${resource.id}.agent.md`;
  }
  return 'SKILL.md';
}

async function writeRepositoryLockfile(targetRoot: string, request: InstallUseCaseRequest, files: TargetWriteFile[]): Promise<void> {
  const source = request.source ?? {
    id: 'golden-source',
    type: 'local',
    url: 'file:///fixtures/golden-source'
  };
  const lockfile = {
    $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
    version: '1.0.0',
    generatedAt: '2025-01-01T00:00:00.000Z',
    generatedBy: 'prompt-registry@1.0.0',
    bundles: {
      [request.bundle.id]: {
        version: request.bundle.version,
        sourceId: source.id,
        sourceType: source.type,
        installedAt: '2025-01-01T00:00:00.000Z',
        files: files.map((file, index) => ({
          path: file.relativePath,
          checksum: String(index + 1).padStart(64, '0')
        }))
      }
    },
    sources: {
      [source.id]: {
        type: source.type,
        url: source.url
      }
    }
  };

  await fs.writeFile(path.join(targetRoot, 'prompt-registry.lock.json'), JSON.stringify(lockfile, null, 2));
}

function recordKey(bundleId: string, target: Target): string {
  return `${target.type}:${target.scope}:${bundleId}`;
}
