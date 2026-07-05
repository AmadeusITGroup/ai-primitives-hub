import type {
  ApplicationUninstallResult,
  ApplicationUseCases,
} from '../../services/application-use-cases';
import type {
  Target,
} from '../../types/target';

export interface UninstallCommandInput {
  bundleId: string;
  target: Target;
}

export interface UninstallCommandDependencies {
  useCases: Pick<ApplicationUseCases, 'uninstall'>;
}

/**
 * Execute the CLI uninstall command over the shared application use case.
 * @param input
 * @param dependencies
 */
export async function executeUninstallCommand(
  input: UninstallCommandInput,
  dependencies: UninstallCommandDependencies
): Promise<ApplicationUninstallResult> {
  return dependencies.useCases.uninstall({
    target: input.target,
    bundleId: input.bundleId
  });
}
