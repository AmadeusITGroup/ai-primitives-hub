/**
 * Collection use-cases: reading/writing/validating collection YAML files,
 * generating/validating skill folders, and scaffolding Agent Plugins.
 * @module app/collection
 */
export {
  createPlugin,
  type CreatePluginErrorCode,
  type CreatePluginOptions,
  type CreatePluginResult,
} from './create-plugin';

export {
  type AffectedCollection,
  affectedCollections,
} from './affected-collections';
export {
  createSkill,
  generateSkillContent,
  validateAllSkills,
  validateSkillFolder,
} from './generate-skill';
export {
  generateMarkdown,
  listCollectionFiles,
  loadItemKindsFromSchema,
  readCollection,
  resolveCollectionItemPaths,
  resolveCollectionReadmePath,
  validateAllCollections,
  validateCollectionFile,
  writeCollection,
} from './read-collection';
