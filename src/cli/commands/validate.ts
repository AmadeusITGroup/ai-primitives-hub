import type {
  ApplicationBundle,
  ApplicationUseCases,
  ApplicationValidateResult,
} from '../../services/application-use-cases';
import type {
  Target,
} from '../../types/target';

export interface ValidateCommandInput {
  bundleRef: string;
  target: Target;
}

export interface ValidateCommandDependencies {
  loadBundle(bundleRef: string): Promise<ApplicationBundle>;
  useCases: Pick<ApplicationUseCases, 'validate'>;
}

/**
 * Execute the CLI validate command over the shared application use case.
 * @param input
 * @param dependencies
 */
export async function executeValidateCommand(
  input: ValidateCommandInput,
  dependencies: ValidateCommandDependencies
): Promise<ApplicationValidateResult> {
  const bundle = await dependencies.loadBundle(input.bundleRef);

  return dependencies.useCases.validate({
    target: input.target,
    bundle
  });
}
