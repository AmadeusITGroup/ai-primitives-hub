import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  Logger,
} from '../utils/logger';

/**
 * Result of schema validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Options for validation
 */
export interface ValidationOptions {
  checkFileReferences?: boolean;
  workspaceRoot?: string;
}

/**
 * Service for validating JSON data against JSON schemas
 * Uses AJV (Another JSON Validator) for schema validation
 */
export class SchemaValidator {
  private readonly ajv: Ajv;
  private readonly schemaCache: Map<string, ReturnType<Ajv['compile']>>;
  private readonly logger: Logger;
  private readonly extensionPath: string;

  constructor(extensionPath?: string) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false
    });

    addFormats(this.ajv);
    this.ajv.addFormat('semver', /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/);

    this.schemaCache = new Map();
    this.logger = Logger.getInstance();
    this.extensionPath = extensionPath || process.cwd();
  }

  /**
   * Load and compile a JSON schema
   * @param schemaPath Path to the JSON schema file
   * @returns Compiled validation function
   */
  private async loadSchema(schemaPath: string): Promise<ReturnType<Ajv['compile']>> {
    if (this.schemaCache.has(schemaPath)) {
      return this.schemaCache.get(schemaPath)!;
    }

    try {
      const schemaContent = fs.readFileSync(schemaPath, 'utf8');
      const schema = JSON.parse(schemaContent);

      const validate = this.ajv.compile(schema);
      this.schemaCache.set(schemaPath, validate);

      this.logger.info(`Loaded schema: ${schemaPath}`);
      return validate;
    } catch (error) {
      this.logger.error(`Failed to load schema ${schemaPath}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Format AJV errors into user-friendly messages
   * @param errors AJV error objects
   * @returns Formatted error messages
   */
  private formatErrors(errors: NonNullable<ReturnType<Ajv['compile']>['errors']>): string[] {
    return errors.map((error) => {
      const dataPath = error.instancePath || '';
      const message = error.message || 'validation failed';
      const params: any = error.params;

      switch (error.keyword) {
        case 'required': {
          return `Missing required field: ${params.missingProperty}`;
        }
        case 'pattern': {
          return `${dataPath}: ${message} (expected pattern: ${params.pattern})`;
        }
        case 'enum': {
          return `${dataPath}: ${message} (allowed values: ${params.allowedValues?.join(', ') || 'unknown'})`;
        }
        case 'minLength': {
          return `${dataPath}: ${message} (minimum ${params.limit} characters)`;
        }
        case 'maxLength': {
          return `${dataPath}: ${message} (maximum ${params.limit} characters)`;
        }
        case 'minItems': {
          return `${dataPath}: ${message} (minimum ${params.limit} items)`;
        }
        case 'maxItems': {
          return `${dataPath}: ${message} (maximum ${params.limit} items)`;
        }
        case 'type': {
          return `${dataPath}: must be ${params.type}`;
        }
        case 'additionalProperties': {
          return `${dataPath}: has unexpected property '${params.additionalProperty}'`;
        }
        default: {
          return `${dataPath}: ${message}`;
        }
      }
    });
  }

  /**
   * Validate that file references exist
   * @param data Collection data
   * @param workspaceRoot Root directory for resolving paths
   * @returns Errors and warnings for missing files
   */
  private validateFileReferences(data: any, workspaceRoot: string): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (data.items && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (item.path) {
          const fullPath = path.join(workspaceRoot, item.path);
          if (!fs.existsSync(fullPath)) {
            errors.push(`Referenced file not found: ${item.path}`);
          }
        }
      }
    }

    return { errors, warnings };
  }

  /**
   * Generate warnings for best practices
   * @param data Collection data
   * @returns Warning messages
   */
  private generateWarnings(data: any): string[] {
    const warnings: string[] = [];

    // Warn about long descriptions
    if (data.description && data.description.length > 300) {
      warnings.push('Description is quite long (>300 characters). Consider keeping it concise.');
    }

    // Warn about empty collections
    if (data.items && Array.isArray(data.items) && data.items.length === 0) {
      warnings.push('Collection has no items.');
    }

    // Warn about too many items
    if (data.items && Array.isArray(data.items) && data.items.length > 30) {
      warnings.push('Collection has many items (>30). Consider splitting into multiple collections.');
    }

    // Warn about missing version
    if (!data.version) {
      warnings.push('No version specified. Consider adding a version for better tracking.');
    }

    // Warn about missing author
    if (!data.author) {
      warnings.push('No author specified. Consider adding author information.');
    }

    return warnings;
  }

  /**
   * Validate data against a JSON schema
   * @param data Data to validate
   * @param schemaPath Path to the JSON schema file
   * @param options Validation options
   * @returns Validation result with errors and warnings
   */
  public async validate(
    data: any,
    schemaPath: string,
    options: ValidationOptions = {}
  ): Promise<ValidationResult> {
    try {
      const validate = await this.loadSchema(schemaPath);
      const valid = validate(data);

      const result: ValidationResult = {
        valid: valid === true,
        errors: [],
        warnings: []
      };

      // Format validation errors
      if (!valid && validate.errors) {
        result.errors = this.formatErrors(validate.errors);
      }

      // Check file references if requested
      if (options.checkFileReferences && options.workspaceRoot) {
        const fileResult = this.validateFileReferences(data, options.workspaceRoot);
        result.errors.push(...fileResult.errors);
        result.warnings.push(...fileResult.warnings);
      }

      // Generate warnings for best practices
      result.warnings.push(...this.generateWarnings(data));

      return result;
    } catch (error) {
      this.logger.error('Validation failed:', error instanceof Error ? error : undefined);
      return {
        valid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
        warnings: []
      };
    }
  }

  /**
   * Validate a collection against the collection schema
   * @param data Collection data to validate
   * @param options Validation options
   * @returns Validation result
   */
  public async validateCollection(
    data: any,
    options: ValidationOptions = {}
  ): Promise<ValidationResult> {
    const schemaPath = path.join(this.extensionPath, 'schemas', 'collection.schema.json');
    return this.validate(data, schemaPath, options);
  }

  /**
   * Validate an APM manifest against the schema
   * @param data APM manifest data
   * @param options Validation options
   * @returns Validation result
   */
  public async validateApm(
    data: any,
    options: ValidationOptions = {}
  ): Promise<ValidationResult> {
    const schemaPath = path.join(this.extensionPath, 'schemas', 'apm.schema.json');
    return this.validate(data, schemaPath, options);
  }
}
