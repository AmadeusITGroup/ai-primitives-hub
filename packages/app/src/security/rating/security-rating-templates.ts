/**
 * Layout of the security rating Markdown report as templates with `{{slot}}` placeholders.
 *
 * `fillTemplate` escapes every value for the place it lands: `{{name}}` escapes it as a table
 * cell (pipes and line breaks), `{{name|html}}` as HTML text, and `{{name|raw}}` inserts it as is
 * for pieces this module already built. A slot without a value is an error, so a typo cannot
 * silently drop part of the report. Values are inserted in a single pass and are not expanded
 * again, so text from a finding cannot add slots of its own.
 * @module app/security/rating/security-rating-templates
 */

const SLOT = /\{\{\s*([A-Za-z][A-Za-z0-9]*)(?:\|(raw|cell|html))?\s*\}\}/g;

const FILTERS: Readonly<Record<'raw' | 'cell' | 'html', (value: string) => string>> = {
  raw: (value) => value,
  cell: (value) => value.replaceAll('|', String.raw`\|`).replaceAll(/\r?\n/g, ' ').trim(),
  html: (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
};

/**
 * Fill the slots of a template.
 * @param template - Text with `{{name}}`, `{{name|html}}` or `{{name|raw}}` slots
 * @param values - Value of every slot used
 */
export const fillTemplate = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replaceAll(SLOT, (_match, name: string, filter: 'raw' | 'cell' | 'html' | undefined) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`Template slot "${name}" has no value`);
    }
    return FILTERS[filter ?? 'cell'](values[name]);
  });

export const TEMPLATES = {
  title: '## {{icon|raw}} Security scan: {{verdict|raw}}',

  // The report when the source has bundles, and when it is rated as one repository.
  bundlesReport: [
    '{{title|raw}}',
    '',
    '**Source score {{score|raw}}/100 · {{risk|raw}}** (average of {{count|raw}} bundle{{plural|raw}}) &nbsp; {{scoreCell|raw}}',
    '',
    '{{riskCounts|raw}}',
    '',
    '> {{gate|raw}}',
    '',
    '{{sections|raw}}',
    '{{scoring|raw}}',
    ''
  ].join('\n'),
  repositoryReport: [
    '{{title|raw}}',
    '',
    '**Whole repository {{score|raw}}/100 · {{risk|raw}}** &nbsp; {{scoreCell|raw}}',
    '',
    '> {{warn|raw}} No collections or skills were found, so the whole repository was scanned as one unit. Vendored code and changelogs can lower this score.',
    '',
    '> {{gate|raw}}',
    '',
    '{{findings|raw}}{{scoring|raw}}',
    ''
  ].join('\n'),

  // Gate sentences.
  gateOff: 'Gate: off (report only).',
  gate: 'Gate `{{failOn|raw}}`: a bundle fails below a score of {{limit|raw}}. {{verdict|raw}}',
  gateFailing: '**{{failing|raw}} of {{total|raw}} bundle(s) are below the limit.**',
  gatePassing: 'All {{total|raw}} bundle(s) pass.',

  // Findings and bundle tables.
  findingsHeader: '| Cost | Rule | Where | How to fix |\n|---:|---|---|---|',
  findingRow: '| -{{points|raw}} | `{{ruleId}}` {{title}} | `{{where}}` | {{fix}} |',
  findingsMore: '| | _{{count|raw}} more in the JSON report_ | | |',
  bundlesHeader: '| | Bundle | Score | Risk | Findings | Costliest finding |\n|:-:|---|---|---|---|---|',
  bundleRow: '| {{status|raw}} | `{{id}}` {{version}} | {{score|raw}} | {{risk|raw}} | {{counts|raw}} | {{top}} |',

  // Collapsible blocks.
  details: '<details><summary>{{summary|raw}}</summary>\n\n{{body|raw}}\n\n</details>\n',
  bundleSummary: '<b><code>{{id|html}}</code></b> &nbsp; {{score|raw}}/100 &nbsp; {{risk|raw}}',
  attentionHeading: '#### Needs attention ({{failing|raw}} below the gate limit)',
  lowestHeading: '#### Lowest scoring bundles',
  moreBelowLimit: '_{{count|raw}} more below the limit are in the full table._',
  allBundles: 'All {{count|raw}} bundles',
  costliestFindings: 'Costliest findings',

  scoreCell: '`{{bar|raw}}` **{{score|raw}}**',
  scoring: '<sub>Score = 100 × exp(−penalty / {{scale|raw}}); each finding costs points by severity, confidence, location and repetition. '
    + 'Risk: 🟢 low ≥ {{low|raw}}, 🟡 medium ≥ {{medium|raw}}, 🟠 high ≥ {{high|raw}}, 🔴 critical below. Scores are advisory.</sub>'
} as const;
