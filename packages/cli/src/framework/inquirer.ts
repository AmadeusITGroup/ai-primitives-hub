/**
 * Lazy loader for `inquirer` (ESM-only) when the CLI is compiled as CommonJS.
 *
 * Keeps the dynamic import in one place so command code can stay agnostic of
 * the module system.
 * @module framework/inquirer
 */

export type PromptModule = <T = Record<string, unknown>>(
  questions: unknown,
  initialAnswers?: Partial<T>
) => Promise<T>;

export type InquirerShape = { prompt: PromptModule };

let inquirer: InquirerShape | undefined;

/**
 * Load the inquirer prompt module once and cache it.
 * @returns An object exposing the inquirer `prompt` function.
 */
export async function loadInquirer(): Promise<InquirerShape> {
  if (inquirer === undefined) {
    inquirer = (await import('inquirer')).default as InquirerShape;
  }
  return inquirer;
}
