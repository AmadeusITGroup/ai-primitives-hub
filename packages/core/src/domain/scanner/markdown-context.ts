/**
 * Markdown parsing context: per line, fenced code-block membership, example-section membership and the
 * current heading; also the frontmatter and the artifact class of the document.
 * @module domain/scanner/markdown-context
 */

import type {
  ArtifactClass,
} from './types';

export interface ParsedLine {
  text: string;
  section: string;
  inExample: boolean;
  inCodeBlock: boolean;
}

export interface ParsedDocument {
  content: string;
  frontmatter: string;
  bodyStart: number;
  lines: ParsedLine[];
  artifactClass: ArtifactClass;
}

const EXAMPLE_SECTION = /example|attack|demo|test|vulnerable|bad[ -]?practice|do[ -]?not[ -]?use|❌/i;

export const parseSecurityDocument = (content: string): ParsedDocument => {
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
  const lines: ParsedLine[] = rawLines.map((text) => {
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

export const classifySecurityArtifact = (content: string, frontmatter: string): ArtifactClass => {
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
