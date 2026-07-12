/**
 * Scaffold command for creating collections and primitives.
 *
 * Author: Waldek Herka
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  generateSanitizedId,
  type ScaffoldOptions,
  type ScaffoldResult,
  type TemplateContext,
} from '../../types/scaffold';

/**
 * Execute a scaffold command to create a collection or primitive.
 * @param options Scaffold options including name, description, output path.
 * @returns Result with created files or error.
 */
export async function executeScaffoldCommand(options: ScaffoldOptions): Promise<ScaffoldResult> {
  if (!options.name) {
    return { success: false, createdFiles: [], error: 'Name is required.' };
  }

  const id = generateSanitizedId(options.name);
  const outputDir = options.path ?? process.cwd();

  const context: TemplateContext = {
    projectName: options.name,
    collectionId: id,
    name: options.name,
    description: options.description ?? '',
    author: options.author ?? '',
    tags: options.tags ?? [],
    version: options.version ?? '1.0.0'
  };

  try {
    const createdFiles = await scaffoldCollection(outputDir, id, context);
    return { success: true, createdFiles };
  } catch (error) {
    return {
      success: false,
      createdFiles: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function scaffoldCollection(outputDir: string, id: string, context: TemplateContext): Promise<string[]> {
  const collectionsDir = path.join(outputDir, 'collections');
  const filePath = path.join(collectionsDir, `${id}.collection.yml`);
  const createdFiles: string[] = [];

  await fs.mkdir(collectionsDir, { recursive: true });

  const tagsSection = context.tags && context.tags.length > 0
    ? `\ntags:\n${context.tags.map((t) => `  - ${t}`).join('\n')}\n`
    : '\n';

  const content = `# Collection: ${context.name ?? id}
id: ${id}
name: ${context.name ?? id}
description: ${context.description ?? ''}${tagsSection}
`;

  await fs.writeFile(filePath, content, 'utf8');
  createdFiles.push(filePath);

  return createdFiles;
}
