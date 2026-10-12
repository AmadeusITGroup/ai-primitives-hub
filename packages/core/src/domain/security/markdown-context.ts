/**
 * Markdown parsing context shared by security rules.
 * @module domain/security/markdown-context
 */
import type {
  ParsedSecurityDocument,
  SecurityArtifactClass,
} from './types';

const EXAMPLE_SECTION = /example|attack|demo|test|vulnerable|bad[ -]?practice|do[ -]?not[ -]?use|❌/i;

/**
 * Parse frontmatter, code-block, section, and artifact classification context.
 * @param content
 */
export const parseSecurityDocument = (content: string): ParsedSecurityDocument => {
  const rawLines = content.split(/\r\n|\n|\r/);
  let frontmatter = '';
  let bodyStart = 0;

  if (rawLines[0]?.trim() === '---') {
    const end = rawLines.slice(1).findIndex((line) => ['---', '...'].includes(line.trim()));
    if (end !== -1) {
      const endIndex = end + 1;
      frontmatter = rawLines.slice(1, endIndex).join('\n');
      bodyStart = endIndex + 1;
    }
  }

  let inCodeBlock = false;
  let section = '';
  let inExample = false;
  const lines = rawLines.map((text) => {
    if (text.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
    if (text.trimStart().startsWith('#')) {
      section = text.trimStart().replace(/^#+/, '').trim();
      inExample = EXAMPLE_SECTION.test(section);
    }
    return { text, section, inExample, inCodeBlock };
  });

  return {
    content,
    frontmatter,
    bodyStart,
    lines,
    artifactClass: classifySecurityArtifact(content, frontmatter)
  };
};

/**
 * Classify an artifact using the reference scanner's precedence rules.
 * @param content
 * @param frontmatter
 */
export const classifySecurityArtifact = (content: string, frontmatter: string): SecurityArtifactClass => {
  if (/^name:\s*\S+/m.test(frontmatter) && frontmatter.includes('description:')) {
    return 'skill';
  }
  if (/\{\{[^}]+\}\}|<user_input>|\[PLACEHOLDER\]/.test(content)) {
    return 'prompt_template';
  }
  if (/tools?\s*[=:]\s*\[|capabilities?\s*[=:]\s*\[|permissions?\s*[=:]\s*\[|actions?\s*[=:]\s*\[|memory\s*:|max_steps?\s*:/i.test(content)) {
    return 'agent_config';
  }
  return 'general_md';
};
