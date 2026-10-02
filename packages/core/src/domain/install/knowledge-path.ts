import * as path from 'node:path';

export const getKnowledgeRelativePath = (bundlePath: string): string | null => {
  const normalized = bundlePath.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    return null;
  }

  const scopedPath = /^\.[^/]+\/knowledge\/(.+)$/.exec(normalized)?.[1];
  const relativePath = scopedPath ?? (
    normalized.startsWith('knowledge/') ? normalized.slice('knowledge/'.length) : normalized
  );
  return relativePath.length > 0 ? relativePath : null;
};
