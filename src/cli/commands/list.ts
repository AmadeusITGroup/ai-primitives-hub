import type {
  ApplicationListResult,
  ApplicationUseCases,
} from '../../services/application-use-cases';
import type {
  Target,
} from '../../types/target';

export interface ListCommandInput {
  target?: Target;
}

export interface ListCommandDependencies {
  useCases: Pick<ApplicationUseCases, 'list'>;
}

/**
 * Execute the CLI list command over the shared application use case.
 * @param input
 * @param dependencies
 */
export async function executeListCommand(
  input: ListCommandInput,
  dependencies: ListCommandDependencies
): Promise<ApplicationListResult> {
  return dependencies.useCases.list({
    target: input.target
  });
}
