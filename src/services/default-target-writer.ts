import * as path from 'node:path';
import type {
  Resource,
  Target,
} from '../types/target';
import {
  resolveTargetLayout,
} from './target-layout-registry';
import {
  FileSystemTargetWriter,
} from './target-writer';

export interface DefaultTargetWriterOptions {
  root: string;
}

export class DefaultTargetWriter {
  private readonly writer: FileSystemTargetWriter;

  public constructor(options: DefaultTargetWriterOptions) {
    this.writer = new FileSystemTargetWriter(options.root);
  }

  public async writeResources(target: Target, resources: Resource[]): Promise<{ writtenFiles: string[] }> {
    const layout = resolveTargetLayout(target);
    const files = resources.map((resource) => {
      const route = layout.routes[resource.kind];
      if (!route) {
        throw new Error(`Target ${target.type} does not define a ${target.scope}-scope route for ${resource.kind}`);
      }
      return {
        relativePath: path.join(route, resource.sourcePath.split('/').pop() ?? resource.sourcePath),
        content: resource.content ?? ''
      };
    });

    return this.writer.writeFiles(files);
  }

  public async removeResources(target: Target, resources: Resource[]): Promise<{ removedFiles: string[] }> {
    const layout = resolveTargetLayout(target);
    const relativePaths = resources.map((resource) => {
      const route = layout.routes[resource.kind];
      if (!route) {
        throw new Error(`Target ${target.type} does not define a ${target.scope}-scope route for ${resource.kind}`);
      }
      return path.join(route, resource.sourcePath.split('/').pop() ?? resource.sourcePath);
    });

    return this.writer.removeFiles(relativePaths);
  }
}
