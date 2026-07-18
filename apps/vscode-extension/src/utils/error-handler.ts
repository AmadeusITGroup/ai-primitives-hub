/**
 * Standardized error handling utilities
 * Provides consistent error handling patterns across all services
 */

import * as vscode from 'vscode';
import {
  WARNING_RESULTS,
} from './constants';
import {
  Logger,
} from './logger';
import {
  toError,
} from './type-guards';

/**
 * Error categories for consistent error handling
 */
export type ErrorCategory = 'network' | 'notfound' | 'validation' | 'authentication' | 'unexpected';

/**
 * Error handling options
 */
export interface ErrorHandlingOptions {
  operation: string;
  context?: Record<string, any>;
  showUserMessage?: boolean;
  userMessagePrefix?: string;
  logLevel?: 'error' | 'warn' | 'info';
  rethrow?: boolean;
}

/**
 * Extended error handling options with fallback value support
 */
export interface ErrorHandlingOptionsWithFallback<T> extends ErrorHandlingOptions {
  /** Value to return when an error occurs (instead of undefined) */
  fallbackValue?: T;
}

/**
 * Standardized error handler
 * Provides consistent logging and user notification patterns with error categorization
 */
export class ErrorHandler {
  private static readonly logger = Logger.getInstance();

  /**
   * Categorize an error based on its message and type
   * @param error
   */
  public static categorize(error: Error): ErrorCategory {
    const msg = error.message.toLowerCase();

    if (this.isNetworkError(msg)) {
      return 'network';
    }

    if (this.isNotFoundError(msg)) {
      return 'notfound';
    }

    if (this.isValidationError(msg)) {
      return 'validation';
    }

    if (this.isAuthenticationError(msg)) {
      return 'authentication';
    }

    return 'unexpected';
  }

  /**
   * Get user-friendly error message based on category
   * @param error
   * @param category
   */
  public static getUserMessage(error: Error, category: ErrorCategory): string {
    switch (category) {
      case 'network': {
        return 'Network connection issue. Please check your internet connection and try again.';
      }
      case 'notfound': {
        return 'The requested resource was not found. It may have been moved or deleted.';
      }
      case 'validation': {
        return 'Invalid data format. Please check the input and try again.';
      }
      case 'authentication': {
        return 'Authentication failed. Please check your credentials and try again.';
      }
      default: {
        return `An unexpected error occurred: ${error.message}`;
      }
    }
  }

  /**
   * Handle an error with categorization and standardized logging
   * @param error
   * @param options
   */
  public static async handle(error: unknown, options: ErrorHandlingOptions): Promise<void> {
    const errorObj = toError(error);
    const { operation, context, showUserMessage = false, userMessagePrefix, logLevel = 'error', rethrow = false } = options;

    // Categorize the error
    const category = this.categorize(errorObj);

    // Log the error with context and category
    const logMessage = `Failed to ${operation}`;
    const logContext = { ...context, errorCategory: category };

    switch (logLevel) {
      case 'error': {
        this.logger.error(logMessage, errorObj, logContext);
        break;
      }
      case 'warn': {
        this.logger.warn(logMessage, errorObj, logContext);
        break;
      }
      case 'info': {
        this.logger.info(logMessage, errorObj, logContext);
        break;
      }
    }

    // Show user message if requested
    if (showUserMessage) {
      const baseMessage = this.getUserMessage(errorObj, category);
      const prefix = userMessagePrefix || `${operation.charAt(0).toUpperCase() + operation.slice(1)} failed`;

      // Default behavior (no custom prefix): use categorized, user-friendly message
      const userMessage = `${prefix}: ${baseMessage}`;

      await vscode.window.showErrorMessage(userMessage);
    }

    // Rethrow if requested
    if (rethrow) {
      throw errorObj;
    }
  }

  /**
   * Check if error is network-related
   * @param message
   */
  private static isNetworkError(message: string): boolean {
    const networkKeywords = [
      'network',
      'timeout',
      'econnrefused',
      'enotfound',
      'econnreset',
      'etimedout',
      'connection',
      'dns',
      'socket'
    ];

    return networkKeywords.some((keyword) => message.includes(keyword));
  }

  /**
   * Check if error indicates resource not found
   * @param message
   */
  private static isNotFoundError(message: string): boolean {
    const notFoundKeywords = [
      'not found',
      '404',
      'does not exist',
      'missing',
      'unavailable'
    ];

    return notFoundKeywords.some((keyword) => message.includes(keyword));
  }

  /**
   * Check if error is validation-related
   * @param message
   */
  private static isValidationError(message: string): boolean {
    const validationKeywords = [
      'invalid',
      'validation',
      'schema',
      'format',
      'required',
      'malformed'
    ];

    return validationKeywords.some((keyword) => message.includes(keyword));
  }

  /**
   * Check if error is authentication-related
   * @param message
   */
  private static isAuthenticationError(message: string): boolean {
    const authKeywords = [
      'unauthorized',
      'forbidden',
      'authentication',
      'token',
      'credentials',
      '401',
      '403'
    ];

    return authKeywords.some((keyword) => message.includes(keyword));
  }

  /**
   * Wrap an async operation with standardized error handling
   * @param operation - The async operation to execute
   * @param options - Error handling options, including optional fallbackValue
   * @returns The operation result, or fallbackValue/undefined on error
   */
  public static async withErrorHandling<T>(
    operation: () => Promise<T>,
    options: ErrorHandlingOptionsWithFallback<T>
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      await this.handle(error, options);
      return options.fallbackValue;
    }
  }
}

/**
 * Common error types for better error categorization
 */
export class RegistryError extends Error {
  constructor(message: string, public readonly code: string, public readonly context?: Record<string, any>) {
    super(message);
    this.name = 'RegistryError';
  }
}

export class NetworkError extends RegistryError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'NETWORK_ERROR', context);
    this.name = 'NetworkError';
  }
}

export class ValidationError extends RegistryError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends RegistryError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'NOT_FOUND', context);
    this.name = 'NotFoundError';
  }
}

export class ConfigurationError extends RegistryError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONFIGURATION_ERROR', context);
    this.name = 'ConfigurationError';
  }
}

/**
 * Error thrown when a bundle update is cancelled by the user
 * Used for local modification warnings where user chooses to contribute or cancel
 */
export class UpdateCancelledError extends RegistryError {
  constructor(
    public readonly bundleId: string,
    public readonly reason: typeof WARNING_RESULTS.CONTRIBUTE | typeof WARNING_RESULTS.CANCEL
  ) {
    const message = reason === 'contribute'
      ? `Update cancelled: Please contribute your local changes before updating bundle '${bundleId}'`
      : `Update cancelled for bundle '${bundleId}'`;
    super(message, 'UPDATE_CANCELLED', { bundleId, reason });
    this.name = 'UpdateCancelledError';
  }
}
