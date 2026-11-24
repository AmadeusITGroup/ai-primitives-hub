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
 * @param isMarkdown When false, skip the Markdown heading/fence heuristics (for non-Markdown files).
 */
export const parseSecurityDocument = (content: string, isMarkdown = true): ParsedSecurityDocument => {
  const rawLines = content.split(/\r\n|\n|\r/);
  let frontmatter = '';
  let bodyStart = 0;

  if (isMarkdown && rawLines[0]?.trim() === '---') {
    const end = rawLines.slice(1).findIndex((line) => ['---', '...'].includes(line.trim()));
    if (end !== -1) {
      const endIndex = end + 1;
      frontmatter = rawLines.slice(1, endIndex).join('\n');
      bodyStart = endIndex + 1;
    }
  }

  let inCodeBlock = false;
  let fenceCharacter = '';
  let fenceLength = 0;
  let section = '';
  let inExample = false;
  const lines = rawLines.map((text) => {
    // Non-Markdown files (install.sh, *.mcp.json, *.py ...) have no Markdown structure:
    // `#` is a shell comment, not a heading, and ``` is not a fence. Applying the heading
    // heuristic there would mark a `# Example` comment as an example section and wrongly
    // suppress skipExample findings in the rest of the file, so skip it entirely.
    if (isMarkdown) {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      if (!inCodeBlock && fence !== null && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        inCodeBlock = true;
        fenceCharacter = fence[1][0];
        fenceLength = fence[1].length;
      } else if (inCodeBlock) {
        const closingFence = new RegExp(`^ {0,3}\\${fenceCharacter}{${fenceLength},}[ \\t]*$`);
        if (closingFence.test(text)) {
          inCodeBlock = false;
          fenceCharacter = '';
          fenceLength = 0;
        }
      }
      if (!inCodeBlock && text.trimStart().startsWith('#')) {
        section = text.trimStart().replace(/^#+/, '').trim();
        inExample = EXAMPLE_SECTION.test(section);
      }
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
  if (/^name:\s*\S+/m.test(frontmatter) && /^description\s*:/m.test(frontmatter)) {
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
