/**
 * Copilot File Type Utilities
 *
 * Thin re-export shim over `@ai-primitives-hub/core`'s
 * `domain/install/copilot-file-type` module.
 * The pure classification/naming logic now lives in `core` so the CLI can
 * depend on it directly; this module exists only so the extension's
 * existing import path (`../utils/copilot-file-type-utils`) keeps working
 * unchanged for `UserScopeService`, `RepositoryScopeService`, and their
 * tests.
 *
 * Do not add logic here — extend the `core` module instead.
 * @module utils/copilot-file-type-utils
 */
export {
  CopilotFileType,
  determineFileType,
  getFileExtension,
  getRepositoryTargetDirectory,
  getSkillName,
  getTargetFileName,
  isSkillDirectory,
  normalizePromptId,
  toCopilotFileType,
} from '@ai-primitives-hub/core';
