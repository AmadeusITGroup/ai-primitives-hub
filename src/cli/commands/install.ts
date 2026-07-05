import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  ApplicationBundle,
  ApplicationInstallResult,
  ApplicationSource,
  ApplicationUpdateResult,
  ApplicationUseCases,
} from '../../services/application-use-cases';
import type {
  DeploymentManifest,
} from '../../types/registry';
import type {
  ResourceKind,
  Target,
} from '../../types/target';

export interface InstallCommandInput {
  bundleRef: string;
  target: Target;
}

export interface InstallCommandDependencies {
  loadBundle(bundleRef: string): Promise<ApplicationBundle>;
  useCases: Pick<ApplicationUseCases, 'install' | 'update'>;
}

export interface RemoteInstallCommandInput {
  bundleRef: string;
  source: ApplicationSource;
  target: Target;
}

export interface RemoteInstallCommandDependencies {
  loadBundle(bundleRef: string, source: ApplicationSource): Promise<ApplicationBundle>;
  useCases: Pick<ApplicationUseCases, 'install'>;
}

type LocalManifest = DeploymentManifest & {
  id: string;
  version: string;
};

type LocalManifestPrompt = NonNullable<LocalManifest['prompts']>[number];

/**
 * Load a local bundle directory into the shared application bundle shape.
 * @param bundlePath
 */
export async function loadLocalBundle(bundlePath: string): Promise<ApplicationBundle> {
  const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');
  const manifestContent = await fs.readFile(manifestPath, 'utf8');
  const manifest = yaml.load(manifestContent) as LocalManifest;

  const resources = await Promise.all((manifest.prompts ?? []).map(async (resource) => ({
    kind: toResourceKind(resource.type),
    id: resource.id,
    sourcePath: resource.file,
    content: await fs.readFile(path.join(bundlePath, resource.file), 'utf8')
  })));

  return {
    id: manifest.id,
    version: manifest.version,
    resources
  };
}

/**
 * Execute the CLI install command over the shared application use case.
 * @param input
 * @param dependencies
 */
export async function executeInstallCommand(
  input: InstallCommandInput,
  dependencies: InstallCommandDependencies
): Promise<ApplicationInstallResult> {
  const bundle = await dependencies.loadBundle(input.bundleRef);

  return dependencies.useCases.install({
    target: input.target,
    bundle,
    source: createLocalSource(bundle.id, input.bundleRef)
  });
}

/**
 * Execute the CLI remote install command over the shared application use case.
 * @param input
 * @param dependencies
 */
export async function executeRemoteInstallCommand(
  input: RemoteInstallCommandInput,
  dependencies: RemoteInstallCommandDependencies
): Promise<ApplicationInstallResult> {
  const bundle = await dependencies.loadBundle(input.bundleRef, input.source);

  return dependencies.useCases.install({
    target: input.target,
    bundle,
    source: input.source
  });
}

/**
 * Execute the CLI update command over the shared application use case.
 * @param input
 * @param dependencies
 */
export async function executeUpdateCommand(
  input: InstallCommandInput,
  dependencies: InstallCommandDependencies
): Promise<ApplicationUpdateResult> {
  const bundle = await dependencies.loadBundle(input.bundleRef);

  return dependencies.useCases.update({
    target: input.target,
    bundle,
    source: createLocalSource(bundle.id, input.bundleRef)
  });
}

function createLocalSource(bundleId: string, bundleRef: string) {
  return {
    id: bundleId,
    type: 'local',
    url: bundleRef
  };
}

function toResourceKind(kind: LocalManifestPrompt['type']): ResourceKind {
  switch (kind) {
    case 'instructions': {
      return 'instruction';
    }
    case 'agent': {
      return 'agent';
    }
    case 'skill': {
      return 'skill';
    }
    case 'prompt':
    case undefined: {
      return 'prompt';
    }
    default: {
      throw new Error(`Unsupported local bundle resource type: ${kind}`);
    }
  }
}
