import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';

interface CollectionTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  items: {
    path: string;
    kind: string;
  }[];
  display: {
    ordering: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
    show_badge: boolean;
  };
}

/**
 * Command to create new collection files interactively
 *
 * Attribution: Inspired by github/awesome-copilot collection creation workflow
 * https://github.com/github/awesome-copilot/blob/main/collections/TEMPLATE.md#creating-a-new-collection
 */
export class CreateCollectionCommand {
  private readonly outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Collection Creator');
  }

  private generateDefaultName(id: string): string {
    return id.split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ') + ' Collection';
  }

  private generateTemplate(
    id: string,
    name: string,
    description: string,
    tags: string[]
  ): CollectionTemplate {
    return {
      id,
      name,
      description,
      tags,
      items: [
        {
          path: `prompts/${id}-example.prompt.md`,
          kind: 'prompt'
        }
      ],
      display: {
        ordering: 'manual',
        show_badge: true
      }
    };
  }

  private log(message: string): void {
    this.outputChannel.appendLine(message);
  }

  public async execute(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const collectionsDir = path.join(workspaceRoot, 'collections');

    // Ensure collections directory exists
    if (!fs.existsSync(collectionsDir)) {
      fs.mkdirSync(collectionsDir, { recursive: true });
    }

    try {
      // Step 1: Get collection ID
      const collectionId = await vscode.window.showInputBox({
        prompt: 'Collection ID (lowercase-with-hyphens)',
        placeHolder: 'my-collection',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'ID is required';
          }
          if (!/^[a-z0-9-]+$/.test(value)) {
            return 'ID must contain only lowercase letters, numbers, and hyphens';
          }
          return undefined;
        }
      });

      if (!collectionId) {
        return; // User cancelled
      }

      // Check if collection already exists
      const collectionFile = path.join(collectionsDir, `${collectionId}.collection.yml`);
      if (fs.existsSync(collectionFile)) {
        const overwrite = await vscode.window.showWarningMessage(
          `Collection '${collectionId}' already exists. Overwrite?`,
          { modal: true },
          'Yes', 'No'
        );

        if (overwrite !== 'Yes') {
          vscode.window.showInformationMessage('Collection creation cancelled');
          return;
        }
      }

      // Step 2: Get collection name
      const defaultName = this.generateDefaultName(collectionId);
      const collectionName = await vscode.window.showInputBox({
        prompt: 'Collection name',
        placeHolder: defaultName,
        value: defaultName,
        ignoreFocusOut: true
      });

      if (collectionName === undefined) {
        return; // User cancelled
      }

      // Step 3: Get description
      const description = await vscode.window.showInputBox({
        prompt: 'Collection description',
        placeHolder: 'A collection of prompts, instructions, and chat modes',
        value: 'A collection of prompts, instructions, and chat modes.',
        ignoreFocusOut: true
      });

      if (description === undefined) {
        return; // User cancelled
      }

      // Step 4: Get tags
      const tagsInput = await vscode.window.showInputBox({
        prompt: 'Tags (comma-separated)',
        placeHolder: 'example',
        value: 'example',
        ignoreFocusOut: true
      });

      if (tagsInput === undefined) {
        return; // User cancelled
      }

      const tags = tagsInput
        ? tagsInput.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
        : ['example'];

      // Generate template
      const template = this.generateTemplate(
        collectionId,
        collectionName || defaultName,
        description || 'A collection of prompts, instructions, and chat modes.',
        tags
      );

      // Write collection file
      const yamlContent = yaml.dump(template, {
        indent: 2,
        lineWidth: 120,
        noRefs: true
      });

      fs.writeFileSync(collectionFile, yamlContent, 'utf8');

      // Show success message with output
      this.outputChannel.clear();
      this.outputChannel.show();
      this.log('✅ Collection Created Successfully!\n');
      this.log(`File location: ${collectionFile}\n`);
      this.log('Next steps:');
      this.log('  1. Edit the collection file to add your items');
      this.log('  2. Create referenced files (prompts, instructions, chatmodes)');
      this.log('  3. Run "Validate Collections" to check the collection');
      this.log('  4. Run "List All Collections" to see your new collection\n');
      this.log('Generated template:\n');
      this.log(yamlContent);

      // Show success notification with actions
      const action = await vscode.window.showInformationMessage(
        `✅ Created collection: ${collectionId}`,
        'Open File',
        'Validate'
      );

      if (action === 'Open File') {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(collectionFile));
        await vscode.window.showTextDocument(doc);
      } else if (action === 'Validate') {
        await vscode.commands.executeCommand('promptRegistry.validateCollections');
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create collection: ${(error as Error).message}`);
    }
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }
}
