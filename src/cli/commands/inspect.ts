import type {
  ApplicationBundle,
  ApplicationInspectResult,
  ApplicationUseCases,
} from '../../services/application-use-cases';
import type {
  Target,
} from '../../types/target';

export interface InspectCommandInput {
  bundleRef: string;
  target: Target;
}

export interface InspectCommandDependencies {
  loadBundle(bundleRef: string): Promise<ApplicationBundle>;
  useCases: Pick<ApplicationUseCases, 'inspect'>;
}

/**
 * Execute the CLI inspect command over the shared application use case.
 * @param input
 * @param dependencies
 */
export async function executeInspectCommand(
  input: InspectCommandInput,
  dependencies: InspectCommandDependencies
): Promise<ApplicationInspectResult> {
  const bundle = await dependencies.loadBundle(input.bundleRef);

  return dependencies.useCases.inspect({
    target: input.target,
    bundle
  });
}
