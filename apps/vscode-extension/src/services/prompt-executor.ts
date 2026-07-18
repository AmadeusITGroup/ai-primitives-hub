/**
 * Prompt Executor Service
 * Executes prompts using VSCode Language Model API
 */

import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

export interface PromptExecutionOptions {
  promptContent: string;
  userInput: string;
  context?: {
    selection?: string;
    fileName?: string;
    language?: string;
  };
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
}

/**
 * Service to execute prompts using Language Model API
 */
export class PromptExecutor {
  private readonly logger: Logger;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
  }

  /**
   * Build chat messages for the language model
   * @param promptContent
   * @param userInput
   * @param context
   * @param context.selection
   * @param context.fileName
   * @param context.language
   */
  private buildMessages(
    promptContent: string,
    userInput: string,
    context?: {
      selection?: string;
      fileName?: string;
      language?: string;
    }
  ): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [
      // eslint-disable-next-line new-cap -- VS Code API static factory method
      vscode.LanguageModelChatMessage.User(promptContent)
    ];

    // Add context if available
    if (context) {
      let contextMessage = '';

      if (context.selection) {
        contextMessage += `\n\n## Current Selection\n\`\`\`${context.language || ''}\n${context.selection}\n\`\`\`\n`;
      }

      if (context.fileName) {
        contextMessage += `\n## Current File\n${context.fileName}\n`;
      }

      if (contextMessage) {
        // eslint-disable-next-line new-cap -- VS Code API static factory method
        messages.push(vscode.LanguageModelChatMessage.User(contextMessage));
      }
    }

    // User's input
    if (userInput && userInput.trim()) {
      // eslint-disable-next-line new-cap -- VS Code API static factory method
      messages.push(vscode.LanguageModelChatMessage.User(userInput));
    }

    return messages;
  }

  /**
   * Execute a prompt with the language model
   * @param options
   */
  public async execute(options: PromptExecutionOptions): Promise<void> {
    const { promptContent, userInput, context, stream, token } = options;

    try {
      // Check if Language Model API is available
      if (!vscode.lm) {
        stream.markdown('\n\n❌ **Language Model API not available**\n\n');
        stream.markdown('This feature requires VSCode 1.90+ with a language model provider.\n\n');
        stream.markdown('Install GitHub Copilot or another compatible extension.\n');
        return;
      }

      // Select appropriate language model
      const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4'
      });

      if (models.length === 0) {
        // Fallback to any available model
        const allModels = await vscode.lm.selectChatModels();
        if (allModels.length === 0) {
          stream.markdown('\n\n❌ **No language model available**\n\n');
          stream.markdown('Please sign in to GitHub Copilot or configure a language model provider.\n');
          return;
        }
        models.push(...allModels);
      }

      const model = models[0];
      this.logger.debug(`Using language model: ${model.vendor}/${model.family}`);

      // Build messages
      const messages = this.buildMessages(promptContent, userInput, context);

      // Send request to language model
      this.logger.debug('Sending request to language model');
      const response = await model.sendRequest(messages, {}, token);

      // Stream response back to chat
      let responseText = '';
      for await (const chunk of response.text) {
        responseText += chunk;
        stream.markdown(chunk);

        // Check for cancellation
        if (token.isCancellationRequested) {
          stream.markdown('\n\n_Request cancelled by user._\n');
          break;
        }
      }

      this.logger.debug(`Response completed: ${responseText.length} chars`);
    } catch (error) {
      this.logger.error('Failed to execute prompt', error as Error);
      stream.markdown('\n\n❌ **Error executing prompt**\n\n');
      stream.markdown(`${(error as Error).message}\n`);
    }
  }
}
