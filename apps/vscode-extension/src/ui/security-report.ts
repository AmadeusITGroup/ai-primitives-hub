import type {
  SecurityScanResult,
} from '@ai-primitives-hub/app';

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export const renderSecurityReportHtml = (result: SecurityScanResult): string => {
  const findingCount = result.summary.active.total;
  const findingLabel = `${String(findingCount)} active finding${findingCount === 1 ? '' : 's'}`;
  const fileCount = result.coverage.scanned.length;
  const summary = `${findingLabel} · ${String(fileCount)} file${fileCount === 1 ? '' : 's'} scanned · ${String(result.summary.suppressed.total)} suppressed`;
  const findings = result.findings.map((finding) => {
    const location = `${finding.file}${finding.line === undefined ? '' : `:${String(finding.line)}`}`;
    return `<article>
      <h2><span class="severity ${finding.severity.toLowerCase()}">${finding.severity}</span> ${escapeHtml(finding.title)}</h2>
      <dl>
        <dt>Rule</dt><dd><code>${escapeHtml(finding.ruleId)}</code></dd>
        <dt>Location</dt><dd><code>${escapeHtml(location)}</code></dd>
        <dt>Confidence</dt><dd>${escapeHtml(finding.confidence)}</dd>
        ${finding.relatedAst === undefined ? '' : `<dt>Related AST</dt><dd>${escapeHtml(finding.relatedAst)}</dd>`}
        ${finding.owasp === undefined ? '' : `<dt>OWASP</dt><dd>${escapeHtml(`${finding.owasp.id} — ${finding.owasp.name}`)}</dd>`}
        <dt>Detected content</dt><dd><code>${escapeHtml(finding.vulnerableContent)}</code></dd>
        <dt>Risk</dt><dd>${escapeHtml(finding.risk)}</dd>
        <dt>Recommended fix</dt><dd>${escapeHtml(finding.recommendedFix)}</dd>
        <dt>Fingerprint</dt><dd><code>${escapeHtml(finding.fingerprint)}</code></dd>
        <dt>Canonical fingerprint</dt><dd><code>${escapeHtml(finding.canonicalFingerprint)}</code></dd>
      </dl>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Security scan report</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem 1.5rem; }
    .summary { padding: .75rem 1rem; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: .25rem; }
    article { border-top: 1px solid var(--vscode-panel-border); margin-top: 1.25rem; padding-top: .75rem; }
    h1, h2 { font-weight: 600; }
    h2 { font-size: 1.1rem; }
    .severity { font-size: .75rem; margin-right: .4rem; }
    dl { display: grid; grid-template-columns: minmax(8rem, auto) 1fr; gap: .4rem 1rem; }
    dt { font-weight: 600; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: var(--vscode-editor-font-family); }
  </style>
</head>
<body>
  <h1>Security scan report</h1>
  <p class="summary">${escapeHtml(summary)}</p>
  ${findings || '<p>No active findings</p>'}
</body>
</html>`;
};
