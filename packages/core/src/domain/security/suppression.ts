/**
 * Finding suppression semantics shared by CLI and VS Code.
 * @module domain/security/suppression
 */
import type {
  SecurityFinding,
  SuppressedFinding,
  SuppressionDeclaration,
  SuppressionParseResult,
  SuppressionResult,
} from './types';

const TOKEN = /^[a-f0-9]{32}$/i;

/**
 * Parse one `.markdown.ignore` file without performing filesystem I/O.
 * @param contents
 * @param sourcePath
 */
export const parseSuppressionFile = (contents: string, sourcePath: string): SuppressionParseResult => {
  const declarations: SuppressionDeclaration[] = [];
  const warnings: SuppressionParseResult['warnings'] = [];

  for (const [index, rawLine] of contents.split(/\r\n|\n|\r/).entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const commentIndex = trimmed.indexOf('#');
    const tokenPart = (commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex)).trim();
    const comment = commentIndex === -1 ? undefined : trimmed.slice(commentIndex + 1).trim();
    if (/\s/.test(tokenPart) || !TOKEN.test(tokenPart)) {
      warnings.push({
        code: 'SECURITY.INVALID_SUPPRESSION',
        sourcePath,
        line,
        message: 'Invalid suppression token'
      });
      continue;
    }
    declarations.push({ token: tokenPart.toLowerCase(), sourcePath, line, comment });
  }
  return { declarations, warnings };
};

const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/$/, '') || '/';

const findingPath = (root: string, file: string): string => {
  const normalizedFile = normalize(file);
  if (normalizedFile.startsWith('/')) {
    return normalizedFile;
  }
  const normalizedRoot = normalize(root);
  return `${normalizedRoot === '/' ? '' : normalizedRoot}/${normalizedFile}`;
};

const isWithin = (file: string, root: string): boolean => {
  const normalizedFile = normalize(file);
  const normalizedRoot = normalize(root);
  return normalizedRoot === '/' || normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
};

/**
 * Apply exact/canonical suppression declarations to findings.
 * @param findings
 * @param declarations
 * @param scanRoot
 */
export const applySuppressions = (
  findings: readonly SecurityFinding[],
  declarations: readonly SuppressionDeclaration[],
  scanRoot: string
): SuppressionResult => {
  const active: SecurityFinding[] = [];
  const suppressed: SuppressedFinding[] = [];

  for (const finding of findings) {
    const path = findingPath(scanRoot, finding.file);
    const applicable = declarations
      .filter((declaration) => isWithin(path, declaration.scopeRoot === undefined ? scanRoot : declaration.scopeRoot))
      .toSorted((a, b) => (b.scopeRoot ?? scanRoot).length - (a.scopeRoot ?? scanRoot).length || a.line - b.line || a.sourcePath.localeCompare(b.sourcePath));
    const match = applicable.find((declaration) => declaration.token === finding.fingerprint || declaration.token === finding.canonicalFingerprint);
    if (match === undefined) {
      active.push(finding);
      continue;
    }
    suppressed.push({
      finding,
      declaration: match,
      kind: match.token === finding.fingerprint ? 'instance' : 'canonical'
    });
  }
  return { active, suppressed };
};
