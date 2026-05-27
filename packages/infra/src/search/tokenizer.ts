/**
 * Deterministic tokenizer for the primitive index.
 *
 * - Lowercases (Unicode-aware).
 * - Splits on non-alphanumeric; also splits camelCase and snake_case / kebab-case.
 * - Drops common English stopwords and very short tokens (<2).
 * - Applies a minimal, predictable suffix stripper (not full Porter) to
 *   keep stemming inspectable and avoid surprises in search results.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'with', 'as', 'is', 'it', 'this', 'that', 'these', 'those',
  'be', 'are', 'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did',
  'not', 'no', 'so', 'than', 'then', 'into', 'from', 'via', 'you', 'your',
  'we', 'our', 'they', 'their', 'he', 'she', 'i', 'me', 'my'
]);

/**
 * Split camelCase/PascalCase into separate words.
 * @param word
 */
function splitCamel(word: string): string[] {
  return word.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/);
}

/**
 * Very conservative stemmer: strips a single common English suffix.
 * @param token
 */
export function stem(token: string): string {
  if (token.length <= 3) {
    return token;
  }
  // Order matters: longer suffixes first.
  const suffixes = ['ingly', 'edly', 'ing', 'ers', 'ier', 'ied', 'ies', 'ed', 'er', 'es', 'ly', 's'];
  for (const suf of suffixes) {
    if (token.length > suf.length + 2 && token.endsWith(suf)) {
      return token.slice(0, -suf.length);
    }
  }
  return token;
}

export interface TokenizeOptions {
  stem?: boolean;
  keepStopwords?: boolean;
}

function processToken(token: string, opts: TokenizeOptions): string | null {
  if (token.length < 2) {
    return null;
  }
  if (!opts.keepStopwords && STOPWORDS.has(token)) {
    return null;
  }
  return opts.stem === false ? token : stem(token);
}

/**
 * Tokenise a string into a deterministic list of searchable terms.
 * @param input - Text to tokenise (may be null/undefined).
 * @param opts - Tokeniser options (stemming, stopword handling).
 */
export function tokenize(input: string | undefined | null, opts: TokenizeOptions = {}): string[] {
  if (!input) {
    return [];
  }
  const normalised = input.normalize('NFKC');
  const rawParts = normalised.split(/[^\p{L}\p{N}]+/u);
  return processRawParts(rawParts, opts);
}

function processRawParts(rawParts: string[], opts: TokenizeOptions): string[] {
  const out: string[] = [];
  for (const rawPart of rawParts) {
    if (!rawPart) {
      continue;
    }
    const tokens = extractTokensFromPart(rawPart, opts);
    out.push(...tokens);
  }
  return out;
}

function extractTokensFromPart(rawPart: string, opts: TokenizeOptions): string[] {
  const subParts = splitCamel(rawPart).map((p) => p.toLowerCase());
  const tokens: string[] = [];
  for (const token of subParts) {
    const processed = processToken(token, opts);
    if (processed) {
      tokens.push(processed);
    }
  }
  return tokens;
}
