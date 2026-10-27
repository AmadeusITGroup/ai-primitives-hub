// Hub Configuration Visual Editor JavaScript
// Uses IIFE pattern for encapsulation and CSP compliance

(() => {
  const vscode = acquireVsCodeApi();

  const state = {
    inspection: null,
    contributionContext: null,
    selection: { section: 'metadata' },
    selectedBundleSourceId: '',
    pendingSourceDiscoveries: new Set(),
    failedSourceDiscoveries: {},
    filter: ''
  };

  /**
   * Escape HTML special characters to prevent XSS.
   * @param {unknown} str - Value to escape.
   * @returns {string} Escaped string.
   */
  const escapeHtml = (str) => String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  /**
   * Check whether a source's catalog has already been discovered in memory.
   * @param {string} sourceId - Source ID.
   * @returns {boolean} True when catalog exists.
   */
  const hasSourceCatalog = (sourceId) => {
    if (!sourceId || !state.inspection?.catalogsBySourceId) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(state.inspection.catalogsBySourceId, sourceId);
  };

  /**
   * Request source catalog discovery from the extension host.
   * @param {string} sourceId - Source ID to probe.
   * @param {boolean} [force] - Whether to force re-discovery even if cached.
   */
  const requestSourceCatalog = (sourceId, force = false) => {
    if (!sourceId) {
      return;
    }
    if (!force && (hasSourceCatalog(sourceId) || state.pendingSourceDiscoveries.has(sourceId) || state.failedSourceDiscoveries[sourceId])) {
      return;
    }
    delete state.failedSourceDiscoveries[sourceId];
    state.pendingSourceDiscoveries.add(sourceId);
    vscode.postMessage({
      type: 'discoverSourceById',
      sourceId,
      silent: !force
    });
  };

  /**
   * Derive the expected bundle ID prefix for a source.
   * @param {{ id?: string } | undefined} source - Source descriptor.
   * @returns {string} Prefix string or empty string.
   */
  const derivePrefixHint = (source) => {
    if (!source || !source.id) {
      return '';
    }
    return state.inspection?.expectedPrefixBySourceId?.[source.id] || '';
  };

  /**
   * Strip a trailing `-vX.Y.Z` or `-X.Y.Z` version suffix from a GitHub bundle ID.
   * @param {string} bundleId - Raw bundle ID.
   * @param {string} [sourceType] - Source type.
   * @returns {string} Versionless bundle ID.
   */
  const stripGitHubVersionSuffix = (bundleId, sourceType) => {
    if (sourceType !== 'github') {
      return bundleId;
    }
    return String(bundleId || '').replace(/-v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9._-]{1,50})?$/, '');
  };

  /**
   * Extract a trailing semver version from a GitHub bundle ID if present.
   * @param {string} bundleId - Raw bundle ID.
   * @param {string} [sourceType] - Source type.
   * @returns {string | null} Extracted semver or null.
   */
  const extractTrailingSemver = (bundleId, sourceType) => {
    if (sourceType !== 'github') {
      return null;
    }
    const match = /-v?(\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9._-]{1,50})?)$/.exec(String(bundleId || ''));
    return match ? match[1] : null;
  };

  /**
   * Format the option label for a consolidated catalog entry.
   * @param {{ id: string; version: string; versions?: string[] }} entry - Catalog entry.
   * @returns {string} Escaped label HTML.
   */
  const formatCatalogOptionLabel = (entry) => {
    const versions = Array.isArray(entry.versions) ? entry.versions : [];
    if (versions.length > 1) {
      return escapeHtml(entry.id) + ' (latest: v' + escapeHtml(entry.version) + ' • ' + versions.length + ' versions)';
    }
    if (versions.length === 1) {
      return escapeHtml(entry.id) + ' (v' + escapeHtml(versions[0]) + ')';
    }
    return escapeHtml(entry.id) + ' (latest)';
  };

  /**
   * Build `<option>` elements for a bundle version selector.
   * @param {{ version?: string; versions?: string[] } | null | undefined} catalogEntry - Matched catalog entry.
   * @param {string} [selectedVersion] - Currently selected version.
   * @returns {string} HTML string of `<option>` elements.
   */
  const buildVersionOptionsHtml = (catalogEntry, selectedVersion = 'latest') => {
    const versions = Array.isArray(catalogEntry?.versions) ? catalogEntry.versions : [];
    const latestLabel = versions.length > 0
      ? 'latest (v' + escapeHtml(catalogEntry.version) + ')'
      : 'latest';
    let html = '<option value="latest" ' + (selectedVersion === 'latest' ? 'selected' : '') + '>' + latestLabel + '</option>';
    for (const version of versions) {
      html += '<option value="' + escapeHtml(version) + '" ' + (selectedVersion === version ? 'selected' : '') + '>' + escapeHtml(version) + '</option>';
    }
    if (selectedVersion && selectedVersion !== 'latest' && !versions.includes(selectedVersion)) {
      html += '<option value="' + escapeHtml(selectedVersion) + '" selected>' + escapeHtml(selectedVersion) + '</option>';
    }
    return html;
  };

  /**
   * Bind click handlers to all `[data-open-url]` elements within a container.
   * @param {ParentNode} root - Container node.
   */
  const bindExternalUrlLinks = (root) => {
    root.querySelectorAll('[data-open-url]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.dataset.openUrl;
        if (url) {
          vscode.postMessage({ type: 'openExternalUrl', url });
        }
      });
    });
  };

  /**
   * Return the active Pull Request only when it is still open.
   * Closed or merged PRs are not tracked in the editor view.
   * @returns {object | null} Open PR metadata or null.
   */
  const getActiveOpenPullRequest = () => {
    const pr = state.contributionContext?.session?.pullRequest;
    return pr && pr.state === 'open' ? pr : null;
  };

  /**
   * Render the top header bar (title, version, validation status, and PR link pill).
   */
  const renderHeader = () => {
    const cfg = state.inspection?.config;
    const valid = state.inspection?.valid;
    const errors = state.inspection?.errors ?? [];
    document.querySelector('#hubTitle').textContent = cfg?.metadata?.name || 'Hub Configuration';
    document.querySelector('#versionPill').textContent = 'v' + (cfg?.version || '1.0.0');

    const valPill = document.querySelector('#validationPill');
    if (valid) {
      valPill.className = 'pill ok';
      valPill.textContent = '✓ Valid (' + (cfg?.sources?.length || 0) + ' sources, ' + (cfg?.profiles?.length || 0) + ' profiles)';
    } else {
      valPill.className = 'pill err';
      valPill.textContent = '✗ ' + errors.length + ' Validation Error(s)';
    }

    const prPill = document.querySelector('#prPill');
    const pr = getActiveOpenPullRequest();
    if (pr) {
      prPill.style.display = 'inline-flex';
      prPill.className = 'pill clickable';
      const checks = pr.checks ? ' • Checks: ' + pr.checks.state : '';
      prPill.textContent = '🔗 PR #' + pr.number + ' (' + pr.state + checks + ') ↗';
      prPill.title = pr.htmlUrl ? 'Click to open ' + pr.htmlUrl + ' in browser' : 'Open Pull Request in browser';
      prPill.dataset.openUrl = pr.htmlUrl || '';
    } else if (state.contributionContext?.upstreamSlug) {
      const upstreamUrl = 'https://github.com/' + state.contributionContext.upstreamSlug;
      prPill.style.display = 'inline-flex';
      prPill.className = 'pill clickable';
      prPill.textContent = '🔗 ' + state.contributionContext.upstreamSlug + ' (' + (state.contributionContext.currentBranch || 'main') + ') ↗';
      prPill.title = 'Click to open ' + upstreamUrl + ' in browser';
      prPill.dataset.openUrl = upstreamUrl;
    } else {
      prPill.style.display = 'none';
      prPill.dataset.openUrl = '';
    }
  };

  /**
   * Render the Metadata & Contribution detail view.
   * @param {HTMLElement} container - Main inspector container.
   * @param {object} cfg - Parsed hub config.
   */
  const renderMetadataInspector = (container, cfg) => {
    const metadata = cfg.metadata || {};
    const contrib = state.contributionContext;
    const pr = getActiveOpenPullRequest();
    const upstreamSlug = contrib?.upstreamSlug || contrib?.session?.upstreamSlug || '';
    const forkSlug = contrib?.forkSlug || contrib?.session?.forkSlug || '';
    const branchName = contrib?.currentBranch || contrib?.session?.branchName || '';
    const upstreamUrl = upstreamSlug ? ('https://github.com/' + upstreamSlug) : '';
    const forkBranchUrl = forkSlug
      ? ('https://github.com/' + forkSlug + (branchName ? '/tree/' + encodeURIComponent(branchName) : ''))
      : '';

    const checksSuffix = pr?.checks
      ? ' • Checks: ' + escapeHtml(pr.checks.state) + ' (' + escapeHtml(pr.checks.passingCount) + '/' + escapeHtml(pr.checks.totalCount) + ')'
      : '';

    const contributionCardHtml = (upstreamSlug || pr)
      ? `
        <div class="card">
          <h2>Contribution &amp; Pull Request</h2>
          <div class="form-grid">
            ${upstreamSlug
    ? `
              <div class="form-group">
                <label>Upstream Hub Repository</label>
                <div><a href="#" class="ext-link" data-open-url="${escapeHtml(upstreamUrl)}">${escapeHtml(upstreamSlug)} ↗</a></div>
              </div>
            `
    : ''}
            ${forkSlug
    ? `
              <div class="form-group">
                <label>Fork &amp; Working Branch</label>
                <div><a href="#" class="ext-link" data-open-url="${escapeHtml(forkBranchUrl)}">${escapeHtml(forkSlug)}${branchName ? ' (' + escapeHtml(branchName) + ')' : ''} ↗</a></div>
              </div>
            `
    : ''}
            ${pr
    ? `
              <div class="form-group full">
                <label>Pull Request</label>
                <div class="bundle-row">
                  <div>
                    <a href="#" class="ext-link" data-open-url="${escapeHtml(pr.htmlUrl)}"><strong>PR #${escapeHtml(pr.number)}: ${escapeHtml(pr.title)}</strong> ↗</a>
                    <span class="hint"> • ${escapeHtml(pr.state.toUpperCase())}${checksSuffix}</span>
                  </div>
                  <div class="actions-group">
                    <button class="secondary" type="button" data-open-url="${escapeHtml(pr.htmlUrl)}">↗ Open PR in Browser</button>
                    <button class="secondary" type="button" id="btnRefreshPrDetail">↻ Refresh PR Status</button>
                  </div>
                </div>
              </div>
            `
    : ''}
          </div>
        </div>
      `
      : '';

    container.innerHTML = `
      ${contributionCardHtml}
      <div class="card">
        <h2>Hub Metadata</h2>
        <div class="form-grid">
          <div class="form-group">
            <label for="metaName">Hub Name</label>
            <input id="metaName" value="${escapeHtml(metadata.name)}" />
          </div>
          <div class="form-group">
            <label for="metaVersion">Schema Version</label>
            <input id="metaVersion" value="${escapeHtml(cfg.version || '1.0.0')}" />
          </div>
          <div class="form-group full">
            <label for="metaDesc">Description</label>
            <input id="metaDesc" value="${escapeHtml(metadata.description)}" />
          </div>
          <div class="form-group">
            <label for="metaMaintainer">Maintainer</label>
            <input id="metaMaintainer" value="${escapeHtml(metadata.maintainer)}" />
          </div>
          <div class="form-group">
            <label for="metaUpdated">Last Updated (ISO 8601)</label>
            <input id="metaUpdated" value="${escapeHtml(metadata.updatedAt)}" />
          </div>
        </div>
        <div class="actions-row">
          <button id="btnSaveMeta" type="button">Save Metadata</button>
        </div>
      </div>
    `;

    bindExternalUrlLinks(container);
    document.querySelector('#btnRefreshPrDetail')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshPullRequest' });
    });
    document.querySelector('#btnSaveMeta')?.addEventListener('click', () => {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'update-metadata',
          version: document.querySelector('#metaVersion').value.trim(),
          metadata: {
            name: document.querySelector('#metaName').value.trim(),
            description: document.querySelector('#metaDesc').value.trim(),
            maintainer: document.querySelector('#metaMaintainer').value.trim(),
            updatedAt: new Date().toISOString()
          }
        }
      });
    });
  };

  /**
   * Render the Source editor & discovered catalog bundles detail view.
   * @param {HTMLElement} container - Main inspector container.
   * @param {object} cfg - Parsed hub config.
   */
  const renderSourceInspector = (container, cfg) => {
    const isNew = state.selection.section === 'new-source';
    const source = isNew
      ? {
        id: '',
        name: '',
        type: 'github',
        url: 'https://github.com/owner/repo',
        enabled: true,
        priority: 10,
        metadata: { description: '', homepage: '' }
      }
      : (cfg.sources?.[state.selection.index] || {});
    const prefixHint = derivePrefixHint(source);
    const discovered = state.inspection.catalogsBySourceId?.[source.id] || [];
    if (!isNew && source.id && source.enabled !== false && !hasSourceCatalog(source.id)) {
      requestSourceCatalog(source.id);
    }
    const isLoadingSource = !isNew && source.id && state.pendingSourceDiscoveries.has(source.id) && !hasSourceCatalog(source.id);

    const sourceTypes = ['github', 'skills', 'awesome-copilot', 'apm', 'local'];
    const typeOptionsHtml = sourceTypes
      .map((t) => '<option value="' + t + '" ' + (source.type === t ? 'selected' : '') + '>' + t + '</option>')
      .join('');

    const repoLinkHtml = source.url && /^https?:\/\//i.test(source.url)
      ? '<a href="#" class="ext-link" id="btnOpenSourceRepo">↗ Open Repository</a>'
      : '';

    const prefixHintHtml = prefixHint
      ? 'Expected bundle ID prefix in profiles: <code>' + escapeHtml(prefixHint) + '&lt;bundleId&gt;</code>'
      : 'No prefix required for this source type.';

    let discoveredBodyHtml = '<p class="hint">Click "Verify &amp; Discover Bundles" or "Deep Validate" to load available bundles from this source.</p>';
    if (isLoadingSource) {
      discoveredBodyHtml = '<p class="hint">⏳ Discovering available bundles from source...</p>';
    } else if (source.id && state.failedSourceDiscoveries[source.id]) {
      discoveredBodyHtml = '<p class="hint">⚠ Discovery failed: ' + escapeHtml(state.failedSourceDiscoveries[source.id]) + '</p>';
    } else if (discovered.length > 0) {
      discoveredBodyHtml = discovered.map((b) => {
        const versions = Array.isArray(b.versions) ? b.versions : [];
        const badge = versions.length > 0
          ? 'latest: v' + escapeHtml(b.version) + (versions.length > 1 ? ' (' + versions.length + ' versions)' : '')
          : 'latest';
        return '<div class="bundle-row"><code>' + escapeHtml(b.id) + '</code><span class="pill info">' + badge + '</span></div>';
      }).join('');
    }

    container.innerHTML = `
      <div class="card">
        <h2>${isNew ? 'Add New Source' : 'Edit Source: ' + escapeHtml(source.name || source.id)}</h2>
        <div class="form-grid">
          <div class="form-group">
            <label for="srcId">Source ID (unique, kebab-case)</label>
            <input id="srcId" value="${escapeHtml(source.id)}" placeholder="my-source-id" />
          </div>
          <div class="form-group">
            <label for="srcName">Display Name</label>
            <input id="srcName" value="${escapeHtml(source.name)}" placeholder="My Prompt Collection" />
          </div>
          <div class="form-group">
            <label for="srcType">Source Type</label>
            <select id="srcType">${typeOptionsHtml}</select>
          </div>
          <div class="form-group">
            <label for="srcPriority">Priority (0 - 100)</label>
            <input id="srcPriority" type="number" min="0" max="100" value="${Number(source.priority ?? 10)}" />
          </div>
          <div class="form-group full">
            <label class="label-row" for="srcUrl">
              <span>Repository / Skills URL</span>
              ${repoLinkHtml}
            </label>
            <input id="srcUrl" value="${escapeHtml(source.url)}" placeholder="https://github.com/org/repo" />
            <span class="hint">${prefixHintHtml}</span>
          </div>
          <div class="form-group">
            <label for="srcDesc">Description</label>
            <input id="srcDesc" value="${escapeHtml(source.metadata?.description || '')}" />
          </div>
          <div class="form-group">
            <label for="srcHomepage">Homepage URL</label>
            <input id="srcHomepage" value="${escapeHtml(source.metadata?.homepage || '')}" />
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="srcEnabled" ${source.enabled === false ? '' : 'checked'} /> Enabled</label>
          </div>
        </div>
        <div class="actions-row">
          <div class="actions-group">
            <button id="btnSaveSource" type="button">${isNew ? 'Add Source' : 'Save Source'}</button>
            ${isNew ? '' : '<button class="secondary" id="btnDiscoverBundles" type="button">🔍 Verify &amp; Discover Bundles</button>'}
          </div>
          ${isNew ? '' : '<button class="danger" id="btnDeleteSource" type="button">Delete Source</button>'}
        </div>
      </div>
      ${isNew
    ? ''
    : `
        <div class="card">
          <h3>Discovered Catalog Bundles (${discovered.length})</h3>
          ${discoveredBodyHtml}
        </div>
      `}
    `;

    document.querySelector('#btnOpenSourceRepo')?.addEventListener('click', (e) => {
      e.preventDefault();
      const url = document.querySelector('#srcUrl')?.value?.trim();
      if (url) {
        vscode.postMessage({ type: 'openExternalUrl', url });
      }
    });

    document.querySelector('#btnSaveSource')?.addEventListener('click', () => {
      const typeVal = document.querySelector('#srcType').value;
      const urlVal = document.querySelector('#srcUrl').value.trim();
      const descVal = document.querySelector('#srcDesc').value.trim();
      const homeVal = document.querySelector('#srcHomepage').value.trim();
      const mergedMeta = { ...source.metadata };
      if (descVal) {
        mergedMeta.description = descVal;
      } else {
        delete mergedMeta.description;
      }
      if (homeVal) {
        mergedMeta.homepage = homeVal;
      } else {
        delete mergedMeta.homepage;
      }
      const preservedConfig = typeVal === 'github'
        ? undefined
        : (source.config || (typeVal === 'awesome-copilot' ? { branch: 'main', collectionsPath: 'collections' } : undefined));
      const sourcePayload = {
        ...source,
        id: document.querySelector('#srcId').value.trim(),
        name: document.querySelector('#srcName').value.trim(),
        type: typeVal,
        url: urlVal,
        enabled: document.querySelector('#srcEnabled').checked,
        priority: Number(document.querySelector('#srcPriority').value || 10),
        config: preservedConfig,
        metadata: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined
      };
      vscode.postMessage({
        type: 'applyMutation',
        mutation: isNew
          ? { kind: 'add-source', source: sourcePayload }
          : { kind: 'update-source', index: state.selection.index, source: sourcePayload, cascadeIdRename: true }
      });
    });

    document.querySelector('#btnDiscoverBundles')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'discoverSource', index: state.selection.index });
    });

    document.querySelector('#btnDeleteSource')?.addEventListener('click', () => {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: { kind: 'delete-source', index: state.selection.index }
      });
      state.selection = { section: 'metadata' };
    });
  };

  /**
   * Render the Profile editor & bundle assignment detail view.
   * @param {HTMLElement} container - Main inspector container.
   * @param {object} cfg - Parsed hub config.
   */
  const renderProfileInspector = (container, cfg) => {
    const isNew = state.selection.section === 'new-profile';
    const profile = isNew
      ? { id: '', name: '', description: '', icon: '🧩', path: ['Roles'], bundles: [] }
      : (cfg.profiles?.[state.selection.index] || {});
    const sources = cfg.sources || [];
    const firstSourceId = sources[0]?.id || '';
    const activeSourceId = (state.selectedBundleSourceId && sources.some((src) => src.id === state.selectedBundleSourceId))
      ? state.selectedBundleSourceId
      : firstSourceId;
    state.selectedBundleSourceId = activeSourceId;
    const catalogForActive = state.inspection.catalogsBySourceId?.[activeSourceId] || [];

    if (!isNew && activeSourceId && !hasSourceCatalog(activeSourceId)) {
      requestSourceCatalog(activeSourceId);
    }
    for (const existingBundle of (profile.bundles || [])) {
      if (existingBundle?.source && !hasSourceCatalog(existingBundle.source)) {
        requestSourceCatalog(existingBundle.source);
      }
    }
    const isLoadingActiveCatalog = Boolean(
      activeSourceId && state.pendingSourceDiscoveries.has(activeSourceId) && !hasSourceCatalog(activeSourceId)
    );

    const existingBundlesHtml = (profile.bundles || []).map((bundle, bIdx) => {
      const bundleCatalog = state.inspection.catalogsBySourceId?.[bundle.source] || [];
      const matchedEntry = bundleCatalog.find((cb) => cb.id.toLowerCase() === String(bundle.id || '').toLowerCase());
      return `
        <div class="bundle-row">
          <div>
            <strong><code>${escapeHtml(bundle.id)}</code></strong>
            <span class="hint"> • source: ${escapeHtml(bundle.source)} • ${bundle.required ? 'required' : 'optional'}</span>
          </div>
          <div class="actions-group">
            <select data-version-bundle="${bIdx}" title="Bundle Version">
              ${buildVersionOptionsHtml(matchedEntry, bundle.version || 'latest')}
            </select>
            <button class="danger" type="button" data-rm-bundle="${bIdx}">Remove</button>
          </div>
        </div>
      `;
    }).join('');

    const sourceOptionsHtml = sources.map((src) => {
      const selectedAttr = src.id === activeSourceId ? 'selected' : '';
      return '<option value="' + escapeHtml(src.id) + '" ' + selectedAttr + '>'
        + escapeHtml(src.name || src.id) + ' (' + escapeHtml(src.type) + ')</option>';
    }).join('');

    const catalogOptionsHtml = catalogForActive
      .map((cb) => '<option value="' + escapeHtml(cb.id) + '">' + formatCatalogOptionLabel(cb) + '</option>')
      .join('');

    const defaultCatalogPlaceholder = isLoadingActiveCatalog
      ? '⏳ Discovering bundles from source...'
      : (activeSourceId && state.failedSourceDiscoveries[activeSourceId]
        ? '⚠ Discovery failed — click Refresh or type ID below'
        : '-- Select from discovered catalog or type below --');

    container.innerHTML = `
      <div class="card">
        <h2>${isNew ? 'Add New Profile' : 'Edit Profile: ' + escapeHtml(profile.name || profile.id)}</h2>
        <div class="form-grid">
          <div class="form-group">
            <label for="profId">Profile ID (kebab-case)</label>
            <input id="profId" value="${escapeHtml(profile.id)}" placeholder="frontend-developer" />
          </div>
          <div class="form-group">
            <label for="profName">Display Name</label>
            <input id="profName" value="${escapeHtml(profile.name)}" placeholder="Frontend Developer" />
          </div>
          <div class="form-group">
            <label for="profIcon">Icon (Emoji)</label>
            <input id="profIcon" value="${escapeHtml(profile.icon || '')}" placeholder="🌐" />
          </div>
          <div class="form-group">
            <label for="profPath">Category Path (comma-separated, e.g. Roles, Domains, Languages)</label>
            <input id="profPath" value="${escapeHtml((profile.path || []).join(', '))}" placeholder="Roles" />
          </div>
          <div class="form-group full">
            <label for="profDesc">Description</label>
            <input id="profDesc" value="${escapeHtml(profile.description)}" placeholder="Curated tools and skills for..." />
          </div>
        </div>
        <div class="actions-row">
          <button id="btnSaveProfile" type="button">${isNew ? 'Create Profile' : 'Save Profile Details'}</button>
          ${isNew ? '' : '<button class="danger" id="btnDeleteProfile" type="button">Delete Profile</button>'}
        </div>
      </div>

      ${isNew
    ? ''
    : `
        <div class="card">
          <h3>Profile Bundles (${(profile.bundles || []).length})</h3>
          <div>${existingBundlesHtml}</div>

          <h3 style="margin-top: 16px;">Add Bundle to Profile</h3>
          <div class="form-grid">
            <div class="form-group">
              <label for="newBundleSource">Source</label>
              <select id="newBundleSource">${sourceOptionsHtml}</select>
            </div>
            <div class="form-group">
              <label class="label-row" for="newBundleCatalogSelect">
                <span>Discovered Catalog Bundle (unique bundles)</span>
                <a href="#" class="ext-link" id="btnRefreshCatalogForProfile" title="Discover or refresh bundles from selected source">↻ Refresh</a>
              </label>
              <select id="newBundleCatalogSelect">
                <option value="">${defaultCatalogPlaceholder}</option>
                ${catalogOptionsHtml}
              </select>
            </div>
            <div class="form-group">
              <label for="newBundleId">Bundle ID (auto-prefixed on add)</label>
              <input id="newBundleId" placeholder="webapp-testing" />
            </div>
            <div class="form-group">
              <label for="newBundleVersion">Version</label>
              <select id="newBundleVersion">
                ${buildVersionOptionsHtml(null, 'latest')}
              </select>
            </div>
            <div class="form-group">
              <label><input type="checkbox" id="newBundleRequired" checked /> Required bundle</label>
            </div>
          </div>
          <button id="btnAddBundleToProfile" type="button">+ Add Bundle</button>
        </div>
      `}
    `;

    document.querySelector('#btnSaveProfile')?.addEventListener('click', () => {
      const pathSegments = document.querySelector('#profPath').value
        .split(',')
        .map((seg) => seg.trim())
        .filter(Boolean);
      const defaultBundles = firstSourceId
        ? [{ id: derivePrefixHint(sources[0]) + 'example-bundle', version: 'latest', source: firstSourceId, required: true }]
        : [];
      const profilePayload = {
        id: document.querySelector('#profId').value.trim(),
        name: document.querySelector('#profName').value.trim(),
        description: document.querySelector('#profDesc').value.trim(),
        icon: document.querySelector('#profIcon').value.trim(),
        path: pathSegments.length > 0 ? pathSegments : ['Roles'],
        bundles: profile.bundles && profile.bundles.length > 0 ? profile.bundles : defaultBundles
      };
      vscode.postMessage({
        type: 'applyMutation',
        mutation: isNew
          ? { kind: 'add-profile', profile: profilePayload }
          : { kind: 'update-profile', index: state.selection.index, profile: profilePayload }
      });
    });

    document.querySelector('#btnDeleteProfile')?.addEventListener('click', () => {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: { kind: 'delete-profile', index: state.selection.index }
      });
      state.selection = { section: 'metadata' };
    });

    document.querySelector('#btnRefreshCatalogForProfile')?.addEventListener('click', (e) => {
      e.preventDefault();
      const srcId = document.querySelector('#newBundleSource')?.value;
      if (!srcId) {
        return;
      }
      const sel = document.querySelector('#newBundleCatalogSelect');
      if (sel) {
        sel.innerHTML = '<option value="">⏳ Discovering bundles from source...</option>';
      }
      requestSourceCatalog(srcId, true);
    });

    document.querySelector('#newBundleSource')?.addEventListener('change', (e) => {
      const srcId = e.target.value;
      state.selectedBundleSourceId = srcId;
      const catLoaded = hasSourceCatalog(srcId);
      const cat = state.inspection.catalogsBySourceId?.[srcId] || [];
      const sel = document.querySelector('#newBundleCatalogSelect');
      if (sel) {
        if (catLoaded) {
          sel.innerHTML = '<option value="">-- Select from discovered catalog or type below --</option>'
            + cat.map((cb) => '<option value="' + escapeHtml(cb.id) + '">' + formatCatalogOptionLabel(cb) + '</option>').join('');
        } else {
          sel.innerHTML = '<option value="">⏳ Discovering bundles from source...</option>';
          requestSourceCatalog(srcId);
        }
      }
      const verSel = document.querySelector('#newBundleVersion');
      if (verSel) {
        verSel.innerHTML = buildVersionOptionsHtml(null, 'latest');
      }
      const idInput = document.querySelector('#newBundleId');
      if (idInput) {
        idInput.value = '';
      }
    });

    document.querySelector('#newBundleCatalogSelect')?.addEventListener('change', (e) => {
      const selectedId = e.target.value;
      const srcId = document.querySelector('#newBundleSource')?.value;
      const cat = state.inspection.catalogsBySourceId?.[srcId] || [];
      const matched = cat.find((cb) => cb.id === selectedId);
      if (selectedId) {
        document.querySelector('#newBundleId').value = selectedId;
      }
      const verSel = document.querySelector('#newBundleVersion');
      if (verSel) {
        verSel.innerHTML = buildVersionOptionsHtml(matched, 'latest');
      }
    });

    document.querySelector('#newBundleId')?.addEventListener('input', (e) => {
      const srcId = document.querySelector('#newBundleSource')?.value;
      const srcObj = sources.find((s) => s.id === srcId);
      const rawVal = e.target.value.trim();
      const trailingVer = extractTrailingSemver(rawVal, srcObj?.type);
      const baseVal = stripGitHubVersionSuffix(rawVal, srcObj?.type);
      const prefix = derivePrefixHint(srcObj);
      const candidateId = (prefix && baseVal && !baseVal.toLowerCase().startsWith(prefix.toLowerCase()))
        ? (prefix + baseVal)
        : baseVal;
      const cat = state.inspection.catalogsBySourceId?.[srcId] || [];
      const matched = cat.find((cb) => cb.id.toLowerCase() === candidateId.toLowerCase());
      const catSel = document.querySelector('#newBundleCatalogSelect');
      if (catSel) {
        catSel.value = matched ? matched.id : '';
      }
      const verSel = document.querySelector('#newBundleVersion');
      if (verSel) {
        const targetVer = trailingVer || verSel.value || 'latest';
        verSel.innerHTML = buildVersionOptionsHtml(matched, targetVer);
      }
    });

    document.querySelector('#btnAddBundleToProfile')?.addEventListener('click', () => {
      const srcId = document.querySelector('#newBundleSource').value;
      const srcObj = sources.find((s) => s.id === srcId);
      const rawId = document.querySelector('#newBundleId').value.trim();
      if (!rawId || !srcId) {
        return;
      }
      const strippedId = stripGitHubVersionSuffix(rawId, srcObj?.type);
      const prefix = derivePrefixHint(srcObj);
      const formattedId = (prefix && !strippedId.toLowerCase().startsWith(prefix.toLowerCase()))
        ? (prefix + strippedId)
        : strippedId;
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'add-profile-bundle',
          profileIndex: state.selection.index,
          bundle: {
            id: formattedId,
            version: document.querySelector('#newBundleVersion').value || 'latest',
            source: srcId,
            required: document.querySelector('#newBundleRequired').checked
          }
        }
      });
    });

    container.querySelectorAll('[data-version-bundle]').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const bIdx = Number(sel.dataset.versionBundle);
        const existingBundle = profile.bundles?.[bIdx];
        if (!existingBundle) {
          return;
        }
        vscode.postMessage({
          type: 'applyMutation',
          mutation: {
            kind: 'update-profile-bundle',
            profileIndex: state.selection.index,
            bundleIndex: bIdx,
            bundle: {
              ...existingBundle,
              version: e.target.value || 'latest'
            }
          }
        });
      });
    });

    container.querySelectorAll('[data-rm-bundle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({
          type: 'applyMutation',
          mutation: {
            kind: 'remove-profile-bundle',
            profileIndex: state.selection.index,
            bundleIndex: Number(btn.dataset.rmBundle)
          }
        });
      });
    });
  };

  /**
   * Render the active detail inspector pane based on `state.selection`.
   */
  const renderInspector = () => {
    const container = document.querySelector('#inspectorContainer');
    const cfg = state.inspection?.config;
    if (!cfg) {
      container.innerHTML = '<div class="card"><h3>YAML Syntax Error</h3><p>Fix syntax errors in the YAML view to use the visual inspector.</p></div>';
      return;
    }

    if (state.selection.section === 'metadata') {
      renderMetadataInspector(container, cfg);
      return;
    }

    if (state.selection.section === 'source' || state.selection.section === 'new-source') {
      renderSourceInspector(container, cfg);
      return;
    }

    if (state.selection.section === 'profile' || state.selection.section === 'new-profile') {
      renderProfileInspector(container, cfg);
    }
  };

  /**
   * Render the master sidebar navigation tree (Metadata, Sources, categorized Profiles, and Diagnostics).
   */
  const renderTree = () => {
    const container = document.querySelector('#treeContainer');
    const cfg = state.inspection?.config;
    if (!cfg) {
      container.innerHTML = '<div class="hint">Unable to parse YAML document. Check syntax errors.</div>';
      return;
    }
    const query = state.filter.trim().toLowerCase();
    let html = '';

    const metaActive = state.selection.section === 'metadata' ? 'active' : '';
    html += '<div class="section-header"><span>Configuration</span></div>';
    html += '<div class="tree-item ' + metaActive + '" data-nav="metadata"><span>📋 Metadata</span><span class="hint">' + escapeHtml(cfg.version) + '</span></div>';

    html += '<div class="section-header"><span>Sources (' + (cfg.sources?.length || 0) + ')</span><button class="secondary" id="btnTreeAddSource" type="button">+ Add</button></div>';
    (cfg.sources || []).forEach((source, idx) => {
      if (query && !String(source.id).toLowerCase().includes(query) && !String(source.name || '').toLowerCase().includes(query)) {
        return;
      }
      const isActive = state.selection.section === 'source' && state.selection.index === idx ? 'active' : '';
      const hasErr = (state.inspection.diagnostics || []).some(
        (d) => d.jsonPath[0] === 'sources' && d.jsonPath[1] === idx && d.severity === 'error'
      );
      html += '<div class="tree-item ' + isActive + '" data-nav="source" data-idx="' + idx + '">'
        + '<span>' + (hasErr ? '⚠️ ' : '🔌 ') + escapeHtml(source.name || source.id) + '</span>'
        + '<span class="hint">' + escapeHtml(source.type) + '</span></div>';
    });

    html += '<div class="section-header"><span>Profiles (' + (cfg.profiles?.length || 0) + ')</span><button class="secondary" id="btnTreeAddProfile" type="button">+ Add</button></div>';
    (state.inspection.profileCategories || []).forEach((group) => {
      const filtered = group.profiles.filter(
        ({ profile }) => !query || String(profile.id).toLowerCase().includes(query) || String(profile.name || '').toLowerCase().includes(query)
      );
      if (filtered.length === 0) {
        return;
      }
      html += '<div class="category-label">📁 ' + escapeHtml(group.category) + '</div>';
      filtered.forEach(({ index, profile }) => {
        const isActive = state.selection.section === 'profile' && state.selection.index === index ? 'active' : '';
        const hasErr = (state.inspection.diagnostics || []).some(
          (d) => d.jsonPath[0] === 'profiles' && d.jsonPath[1] === index && d.severity === 'error'
        );
        html += '<div class="tree-item ' + isActive + '" data-nav="profile" data-idx="' + index + '">'
          + '<span>' + (hasErr ? '⚠️ ' : '') + escapeHtml((profile.icon ? profile.icon + ' ' : '') + (profile.name || profile.id)) + '</span>'
          + '<span class="hint">' + (profile.bundles?.length || 0) + '</span></div>';
      });
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-nav]').forEach((el) => {
      el.addEventListener('click', () => {
        const nav = el.dataset.nav;
        const idx = el.dataset.idx;
        state.selection = { section: nav, index: idx === undefined ? undefined : Number(idx) };
        renderTree();
        renderInspector();
        vscode.postMessage({
          type: 'revealSelectionInYaml',
          selection: state.selection
        });
      });
    });

    document.querySelector('#btnTreeAddSource')?.addEventListener('click', () => {
      state.selection = { section: 'new-source' };
      renderInspector();
    });
    document.querySelector('#btnTreeAddProfile')?.addEventListener('click', () => {
      state.selection = { section: 'new-profile' };
      renderInspector();
    });

    const diagContainer = document.querySelector('#diagnosticsSidebar');
    const diags = state.inspection?.diagnostics ?? [];
    if (diags.length === 0) {
      diagContainer.innerHTML = '';
    } else {
      let dHtml = '<div class="section-header"><span>Validation Issues (' + diags.length + ')</span></div>';
      diags.forEach((diag, dIdx) => {
        dHtml += '<div class="diag-item"><span>' + escapeHtml(diag.message) + '</span>'
          + (diag.quickFix ? '<button class="secondary" type="button" data-qfix="' + dIdx + '">Quick Fix</button>' : '')
          + '</div>';
      });
      diagContainer.innerHTML = dHtml;
      diagContainer.querySelectorAll('[data-qfix]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const diag = diags[Number(btn.dataset.qfix)];
          if (diag?.quickFix) {
            vscode.postMessage({
              type: 'applyMutation',
              mutation: { kind: 'apply-quick-fix', quickFix: diag.quickFix }
            });
          }
        });
      });
    }
  };

  // Global toolbar & filter event listeners
  document.querySelector('#treeFilter')?.addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderTree();
  });
  document.querySelector('#btnDeepValidate')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'validateDeep' });
  });
  document.querySelector('#btnTouchTimestamp')?.addEventListener('click', () => {
    vscode.postMessage({
      type: 'applyMutation',
      mutation: { kind: 'touch-updated-at', updatedAt: new Date().toISOString() }
    });
  });
  document.querySelector('#btnSplitYaml')?.addEventListener('click', () => {
    vscode.postMessage({
      type: 'openYamlSplit',
      selection: state.selection
    });
  });
  document.querySelector('#btnSubmitPr')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'submitPullRequest' });
  });
  document.querySelector('#prPill')?.addEventListener('click', () => {
    const url = document.querySelector('#prPill')?.dataset?.openUrl;
    if (url) {
      vscode.postMessage({ type: 'openExternalUrl', url });
    }
  });

  // Handle state updates from extension host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'documentState') {
      state.inspection = msg.inspection;
      state.contributionContext = msg.contributionContext;
      for (const loadedSourceId of Object.keys(msg.inspection?.catalogsBySourceId || {})) {
        state.pendingSourceDiscoveries.delete(loadedSourceId);
        delete state.failedSourceDiscoveries[loadedSourceId];
      }
      if (msg.focusTarget) {
        state.selection = msg.focusTarget;
      }
      renderHeader();
      renderTree();
      renderInspector();
      if (msg.focusTarget) {
        document.querySelector('#treeContainer .tree-item.active')?.scrollIntoView?.({ block: 'nearest' });
      }
    } else if (msg.type === 'discoveryFinished' && msg.sourceId) {
      state.pendingSourceDiscoveries.delete(msg.sourceId);
      if (msg.valid) {
        delete state.failedSourceDiscoveries[msg.sourceId];
      } else {
        state.failedSourceDiscoveries[msg.sourceId] = (msg.errors || []).join(', ') || 'Source discovery failed';
      }
      renderInspector();
    }
  });

  // Signal readiness after message listener is installed
  vscode.postMessage({ type: 'ready' });
})();
