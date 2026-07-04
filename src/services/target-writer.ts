import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TargetWriteFile {
  relativePath: string;
  content: string;
}

export interface TargetWriteResult {
  writtenFiles: string[];
}

export interface TargetRemoveResult {
  removedFiles: string[];
}

export class FileSystemTargetWriter {
  public constructor(private readonly root: string) {}

  public async writeFiles(files: TargetWriteFile[]): Promise<TargetWriteResult> {
    const writtenFiles: string[] = [];

    for (const file of files) {
      const absolutePath = path.join(this.root, file.relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, file.content);
      writtenFiles.push(toPosixPath(file.relativePath));
    }

    return { writtenFiles };
  }

  public async removeFiles(relativePaths: string[]): Promise<TargetRemoveResult> {
    const removedFiles: string[] = [];

    for (const relativePath of relativePaths) {
      await fs.rm(path.join(this.root, relativePath), { force: true, recursive: true });
      removedFiles.push(toPosixPath(relativePath));
    }

    return { removedFiles };
  }
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
