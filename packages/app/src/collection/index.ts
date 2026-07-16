/**
 * Collection use-cases: reading/writing/validating collection YAML files
 * and generating/validating skill folders.
 * @module app/collection
 */

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
  validateAllCollections,
  validateCollectionFile,
  writeCollection,
} from './read-collection';
