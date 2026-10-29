// AI Primitives Hub — Visual Collection Editor Webview Script
// Uses IIFE pattern for encapsulation and CSP compliance

(() => {
  const vscode = acquireVsCodeApi();

  let state = {
    filePath: '',
    workspaceRoot: '',
    inspection: null,
    siblingCollections: [],
    contributionContext: null,
    readmeContent: null,
    selection: { section: 'metadata' },
    filterText: '',
    primitiveContentsByPath: {},
    savedToastMessage: ''
  };

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const notifySelectionChanged = () => {
    vscode.postMessage({
      type: 'selectionChanged',
      target: state.selection
    });
  };

  const requestPrimitiveContent = (relPath, kind) => {
    if (!relPath) {
      return;
    }
    vscode.postMessage({
      type: 'loadPrimitiveContent',
      relPath,
      kind
    });
  };

  const renderHeader = () => {
    const manifest = state.inspection?.manifest || {};
    const titleEl = document.querySelector('#collectionTitle');
    const verEl = document.querySelector('#versionPill');
    const valEl = document.querySelector('#validationPill');
    const switcherEl = document.querySelector('#collectionSwitcher');
    const upstreamPill = document.querySelector('#upstreamPill');
    const prPill = document.querySelector('#prPill');

    if (titleEl) {
      titleEl.textContent = manifest.name || manifest.id || 'Collection';
    }
    if (verEl) {
      verEl.textContent = `v${manifest.version || '1.0.0'}`;
    }
    if (valEl) {
      const valid = Boolean(state.inspection?.valid);
      const errCount = (state.inspection?.diagnostics || []).filter((d) => d.severity === 'error').length;
      const warnCount = (state.inspection?.diagnostics || []).filter((d) => d.severity === 'warning').length;
      valEl.className = `pill ${valid ? (warnCount > 0 ? 'warn' : 'ok') : 'err'}`;
      valEl.textContent = valid
        ? (warnCount > 0 ? `✓ Valid (${warnCount} warning(s))` : '✓ Valid')
        : `✗ ${errCount} Error(s)`;
    }

    if (switcherEl) {
      const siblings = state.siblingCollections || [];
      if (siblings.length > 0) {
        switcherEl.style.display = 'inline-block';
        switcherEl.innerHTML = siblings.map((c) =>
          `<option value="${escapeHtml(c.filePath)}" ${c.filePath === state.filePath ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.id)})</option>`
        ).join('');
      } else {
        switcherEl.style.display = 'none';
      }
    }

    if (upstreamPill) {
      const slug = state.contributionContext?.upstreamSlug;
      if (slug) {
        const branch = state.contributionContext?.currentBranch;
        upstreamPill.style.display = 'inline-flex';
        upstreamPill.textContent = `Upstream: ${slug}${branch ? ` (${branch})` : ''}`;
        upstreamPill.dataset.url = `https://github.com/${slug}`;
      } else {
        upstreamPill.style.display = 'none';
      }
    }

    if (prPill) {
      const pr = state.contributionContext?.session?.pullRequest;
      if (pr && pr.state === 'open') {
        const checksText = pr.checks ? ` • Checks: ${pr.checks.state}` : '';
        prPill.style.display = 'inline-flex';
        prPill.textContent = `PR #${pr.number} (${pr.state.toUpperCase()}${checksText})`;
        prPill.dataset.url = pr.htmlUrl || '';
      } else {
        prPill.style.display = 'none';
      }
    }
  };

  const renderTree = () => {
    const container = document.querySelector('#treeContainer');
    const diagContainer = document.querySelector('#diagnosticsSidebar');
    if (!container || !diagContainer) {
      return;
    }

    const manifest = state.inspection?.manifest || {};
    const itemStatuses = state.inspection?.itemStatuses || [];
    const unassigned = state.inspection?.unassignedPrimitives || [];
    const mcpInputs = manifest.mcp?.inputs || [];
    const mcpServers = Object.keys(manifest.mcp?.items || {});
    const filter = (state.filterText || '').trim().toLowerCase();

    const matchesFilter = (text) => !filter || String(text || '').toLowerCase().includes(filter);

    // 1. Core sections & 2. Primitive Items header
    const html = [
      `<div class="section-header"><span>Collection Sections</span></div>`,
      `<div class="tree-item ${state.selection.section === 'metadata' ? 'active' : ''}" data-select-section="metadata">`
      + `<span>📋 Metadata &amp; Display</span>`
      + `<span class="hint">${escapeHtml(manifest.id || '')}</span>`
      + `</div>`,
      `<div class="tree-item ${state.selection.section === 'readme' ? 'active' : ''}" data-select-section="readme">`
      + `<span>📖 README Documentation</span>`
      + `<span class="hint">${state.inspection?.readmeExists ? '✓' : (manifest.readme?.path ? '✗ missing' : 'none')}</span>`
      + `</div>`,
      `<div class="section-header">`
      + `<span>Primitive Items (${itemStatuses.length})</span>`
      + `<div class="actions-group">`
      + `<button class="secondary small" type="button" id="btnSortItems" title="Sort items alphabetically">A–Z</button>`
      + `<button class="secondary small" type="button" id="btnAddNewItemOutline">+ Add</button>`
      + `</div>`
      + `</div>`
    ];

    itemStatuses.forEach((st, idx) => {
      const label = st.previewTitle || st.title || st.path || `item-${idx + 1}`;
      if (!matchesFilter(label) && !matchesFilter(st.path) && !matchesFilter(st.kind)) {
        return;
      }
      const isSelected = state.selection.section === 'item' && state.selection.index === idx;
      const statusBadge = st.exists ? (st.routeMismatch ? '⚠' : '✓') : '✗';
      html.push(
        `<div class="tree-item ${isSelected ? 'active' : ''}" data-select-section="item" data-select-index="${idx}">`
        + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(label)}</span>`
        + `<span class="hint">${escapeHtml(st.kind)} ${statusBadge}</span>`
        + `</div>`
      );
    });

    // 3. MCP Configuration
    const mcpTotal = mcpInputs.length + mcpServers.length;
    html.push(
      `<div class="section-header">`
      + `<span>MCP Servers &amp; Inputs (${mcpTotal})</span>`
      + `<button class="secondary small" type="button" id="btnInspectMcp">Manage</button>`
      + `</div>`,
      `<div class="tree-item ${state.selection.section === 'mcp' ? 'active' : ''}" data-select-section="mcp">`
      + `<span>🔌 MCP Configuration</span>`
      + `<span class="hint">${mcpServers.length} srv / ${mcpInputs.length} in</span>`
      + `</div>`
    );

    // 4. Unassigned Workspace Primitives
    if (unassigned.length > 0) {
      html.push(
        `<div class="section-header"><span>Unassigned Repo Files (${unassigned.length})</span></div>`
      );
      unassigned.slice(0, 15).forEach((cand) => {
        if (!matchesFilter(cand.path) && !matchesFilter(cand.title)) {
          return;
        }
        const pEsc = escapeHtml(cand.path);
        const kEsc = escapeHtml(cand.kind);
        const tEsc = escapeHtml(cand.title);
        html.push(
          `<div class="tree-item" data-quick-add-path="${pEsc}" data-quick-add-kind="${kEsc}" `
          + `data-quick-add-title="${tEsc}" title="Click to add ${pEsc} to this collection">`
          + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">+ ${pEsc}</span>`
          + `<span class="hint">${kEsc}</span>`
          + `</div>`
        );
      });
    }

    container.innerHTML = html.join('');

    // Diagnostics summary in sidebar
    const diags = state.inspection?.diagnostics || [];
    diagContainer.innerHTML = diags.length === 0
      ? `<div class="hint">No validation issues in this collection.</div>`
      : `<div class="section-header"><span>Diagnostics (${diags.length})</span></div>`
        + diags.map((d, dIdx) =>
          `<div class="diag-item ${d.severity === 'warning' ? 'warn' : ''}">`
          + `<span>${escapeHtml(d.message)}</span>`
          + (d.quickFix
            ? `<button class="secondary small" type="button" data-quick-fix-idx="${dIdx}">Fix</button>`
            : '')
          + `</div>`
        ).join('');
  };

  const renderMetadataInspector = (manifest) => {
    const tagsStr = Array.isArray(manifest.tags) ? manifest.tags.join(', ') : '';
    const display = manifest.display || {};

    return `
      <div class="card">
        <h2>Collection Metadata</h2>
        <div class="form-grid">
          <div class="form-group">
            <label for="metaId">Collection ID (lowercase, numbers, hyphens)</label>
            <input id="metaId" type="text" value="${escapeHtml(manifest.id || '')}" placeholder="python-development">
          </div>
          <div class="form-group">
            <label for="metaName">Display Name</label>
            <input id="metaName" type="text" value="${escapeHtml(manifest.name || '')}" placeholder="Python Development Suite">
          </div>
          <div class="form-group">
            <div class="label-row">
              <label for="metaVersion">Version (semver)</label>
              <div class="actions-group">
                <button class="secondary small" type="button" data-bump-version="patch">+Patch</button>
                <button class="secondary small" type="button" data-bump-version="minor">+Minor</button>
                <button class="secondary small" type="button" data-bump-version="major">+Major</button>
              </div>
            </div>
            <input id="metaVersion" type="text" value="${escapeHtml(manifest.version || '1.0.0')}" placeholder="1.0.0">
          </div>
          <div class="form-group">
            <label for="metaAuthor">Author / Team</label>
            <input id="metaAuthor" type="text" value="${escapeHtml(manifest.author || '')}" placeholder="Platform Team">
          </div>
          <div class="form-group full">
            <label for="metaDescription">Description</label>
            <textarea id="metaDescription" rows="3" placeholder="Describe what this collection provides...">${escapeHtml(manifest.description || '')}</textarea>
          </div>
          <div class="form-group full">
            <label for="metaTags">Tags (comma-separated)</label>
            <input id="metaTags" type="text" value="${escapeHtml(tagsStr)}" placeholder="python, testing, clean-code">
          </div>
        </div>
        <div class="actions-row">
          <span class="hint">Comments and $schema headers are preserved automatically.</span>
          <button type="button" id="btnSaveMetadata">Save Metadata</button>
        </div>
      </div>

      <div class="card">
        <h3>Display Preferences</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="dispColor">Theme Color (Hex)</label>
            <input id="dispColor" type="text" value="${escapeHtml(display.color || '')}" placeholder="#3776AB">
          </div>
          <div class="form-group">
            <label for="dispIcon">Icon Identifier</label>
            <input id="dispIcon" type="text" value="${escapeHtml(display.icon || '')}" placeholder="python">
          </div>
          <div class="form-group">
            <label for="dispOrdering">Item Ordering</label>
            <select id="dispOrdering">
              <option value="manual" ${(display.ordering || 'manual') === 'manual' ? 'selected' : ''}>manual</option>
              <option value="alphabetical" ${display.ordering === 'alphabetical' ? 'selected' : ''}>alphabetical</option>
            </select>
          </div>
          <div class="form-group">
            <label for="dispShowBadge">Show Badge in UI</label>
            <select id="dispShowBadge">
              <option value="true" ${display.show_badge === false ? '' : 'selected'}>true</option>
              <option value="false" ${display.show_badge === false ? 'selected' : ''}>false</option>
            </select>
          </div>
        </div>
        <div class="actions-row">
          <span></span>
          <button type="button" id="btnSaveDisplay">Save Display Preferences</button>
        </div>
      </div>
    `;
  };

  const renderReadmeInspector = (manifest) => {
    const readmePath = manifest.readme?.path || `docs/${manifest.id || 'collection'}/README.md`;
    const exists = Boolean(state.inspection?.readmeExists);
    const loaded = state.readmeContent || state.primitiveContentsByPath[readmePath];
    const bodyText = loaded?.rawContent ?? loaded?.body ?? '';

    return `
      <div class="card">
        <h2>Collection README Documentation</h2>
        <div class="form-grid">
          <div class="form-group full">
            <label for="readmePathInput">README Path (repo-root relative)</label>
            <input id="readmePathInput" type="text" value="${escapeHtml(readmePath)}" placeholder="docs/my-collection/README.md">
          </div>
        </div>
        <div class="actions-row">
          <div class="actions-group">
            <button type="button" id="btnSaveReadmePath">Set README Path in Collection</button>
            ${exists
    ? `<button class="secondary" type="button" id="btnOpenReadmeBeside">Open README Beside</button>`
    : `<button class="secondary" type="button" id="btnScaffoldReadme">✨ Create README.md File</button>`}
          </div>
        </div>
      </div>

      ${exists
    ? `
        <div class="card">
          <h3>Edit README Content (<code>${escapeHtml(readmePath)}</code>)</h3>
          <div class="form-group full">
            <label for="readmeBodyEditor">Markdown Content</label>
            <textarea id="readmeBodyEditor" class="code-editor" rows="12">${escapeHtml(bodyText)}</textarea>
          </div>
          <div class="actions-row">
            <span class="hint">Displayed in the Marketplace Bundle Details panel.</span>
            <button type="button" id="btnSaveReadmeContent" data-rel-path="${escapeHtml(readmePath)}">Save README Content</button>
          </div>
        </div>
        `
    : ''}
    `;
  };

  const renderItemInspector = (manifest, itemIndex) => {
    const items = manifest.items || [];
    const item = items[itemIndex];
    const status = (state.inspection?.itemStatuses || [])[itemIndex];
    if (!item) {
      return `<div class="card"><p>Item not found.</p></div>`;
    }

    const kinds = state.inspection?.primitiveKinds || [
      'prompt', 'instruction', 'chat-mode', 'agent', 'skill', 'plugin', 'hook', 'mcp-server',
      'steering', 'spec', 'command', 'rule', 'output-style', 'tool', 'power', 'knowledge', 'playbook'
    ];
    const tagsStr = Array.isArray(item.tags) ? item.tags.join(', ') : '';
    const loaded = state.primitiveContentsByPath[item.path];

    let contentEditorHtml = '';
    if (!status?.exists) {
      contentEditorHtml = `
        <div class="card">
          <h3>Referenced File Not Found (<code>${escapeHtml(item.path)}</code>)</h3>
          <p class="hint">This item points to a file that does not exist in the repository yet. You can create it with 1 click from a starter template.</p>
          <div class="actions-row">
            <button type="button" id="btnScaffoldMissingItem"
              data-rel-path="${escapeHtml(item.path)}"
              data-item-kind="${escapeHtml(item.kind)}"
              data-item-title="${escapeHtml(item.title || item.name || item.path)}">
              ✨ Create Missing ${escapeHtml(item.kind)} File from Template
            </button>
          </div>
        </div>
      `;
    } else if (!loaded) {
      requestPrimitiveContent(item.path, item.kind);
      contentEditorHtml = `
        <div class="card">
          <h3>Primitive Content (<code>${escapeHtml(item.path)}</code>)</h3>
          <p class="hint">Loading file content...</p>
        </div>
      `;
    } else if (loaded.format === 'plugin-json') {
      const pm = loaded.pluginManifest || {};
      const authorName = (pm.author && typeof pm.author === 'object') ? (pm.author.name || '') : '';
      contentEditorHtml = `
        <div class="card">
          <div class="label-row">
            <h3>Visual Plugin Manifest Editor (<code>${escapeHtml(item.path)}</code>)</h3>
            <button class="secondary small" type="button" data-open-file="${escapeHtml(item.path)}">Open File Beside</button>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label for="primPluginName">Plugin Name (must match directory)</label>
              <input id="primPluginName" type="text" value="${escapeHtml(pm.name || '')}">
            </div>
            <div class="form-group">
              <label for="primPluginVersion">Plugin Version</label>
              <input id="primPluginVersion" type="text" value="${escapeHtml(pm.version || '1.0.0')}">
            </div>
            <div class="form-group">
              <label for="primPluginAuthor">Author Name</label>
              <input id="primPluginAuthor" type="text" value="${escapeHtml(authorName)}">
            </div>
            <div class="form-group full">
              <label for="primPluginDescription">Description</label>
              <input id="primPluginDescription" type="text" value="${escapeHtml(pm.description || '')}">
            </div>
          </div>
          <div class="actions-row">
            <span class="hint">${escapeHtml(state.savedToastMessage)}</span>
            <button type="button" id="btnSavePluginContent" data-rel-path="${escapeHtml(item.path)}">Save Plugin Manifest</button>
          </div>
        </div>
      `;
    } else {
      const fm = loaded.frontmatter || {};
      const toolsStr = Array.isArray(fm.tools) ? fm.tools.join(', ') : (typeof fm.tools === 'string' ? fm.tools : '');
      contentEditorHtml = `
        <div class="card">
          <div class="label-row">
            <h3>Visual Primitive Content Editor (<code>${escapeHtml(item.path)}</code>)</h3>
            <button class="secondary small" type="button" data-open-file="${escapeHtml(item.path)}">Open File Beside</button>
          </div>
          <p class="hint">Edit frontmatter properties and Markdown instructions visually — no manual YAML frontmatter delimiters required.</p>
          <div class="form-grid">
            <div class="form-group">
              <label for="primFmName">Frontmatter Name</label>
              <input id="primFmName" type="text" value="${escapeHtml(fm.name || '')}" placeholder="my-primitive">
            </div>
            <div class="form-group">
              <label for="primFmApplyTo">ApplyTo Glob (Instructions)</label>
              <input id="primFmApplyTo" type="text" value="${escapeHtml(fm.applyTo || '')}" placeholder="**/*.ts">
            </div>
            <div class="form-group full">
              <label for="primFmDescription">Frontmatter Description</label>
              <input id="primFmDescription" type="text" value="${escapeHtml(fm.description || '')}" placeholder="When and how to use this primitive">
            </div>
            <div class="form-group">
              <label for="primFmTools">Tools (comma-separated, optional)</label>
              <input id="primFmTools" type="text" value="${escapeHtml(toolsStr)}" placeholder="grep, view, edit">
            </div>
            <div class="form-group">
              <label for="primFmModel">Model (optional)</label>
              <input id="primFmModel" type="text" value="${escapeHtml(fm.model || '')}" placeholder="gpt-4o">
            </div>
            <div class="form-group full">
              <label for="primBodyEditor">Markdown Instructions / Prompt Body</label>
              <textarea id="primBodyEditor" class="code-editor" rows="12">${escapeHtml(loaded.body || '')}</textarea>
            </div>
          </div>
          <div class="actions-row">
            <span class="hint">${escapeHtml(state.savedToastMessage)}</span>
            <button type="button" id="btnSavePrimitiveMarkdown" data-rel-path="${escapeHtml(item.path)}" data-item-kind="${escapeHtml(item.kind)}">Save Primitive File Content</button>
          </div>
        </div>
      `;
    }

    return `
      <div class="card">
        <div class="label-row">
          <h2>Item #${itemIndex + 1}: ${escapeHtml(item.title || item.name || item.path)}</h2>
          <div class="actions-group">
            <button class="secondary small" type="button" id="btnMoveItemUp" ${itemIndex === 0 ? 'disabled' : ''}>↑ Move Up</button>
            <button class="secondary small" type="button" id="btnMoveItemDown" ${itemIndex >= items.length - 1 ? 'disabled' : ''}>↓ Move Down</button>
            <button class="danger small" type="button" id="btnDeleteItem" data-item-index="${itemIndex}">Remove from Collection</button>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label for="itemPath">File Path (repo-root relative)</label>
            <input id="itemPath" type="text" value="${escapeHtml(item.path || '')}" placeholder="prompts/my-prompt.prompt.md">
          </div>
          <div class="form-group">
            <label for="itemKind">Primitive Kind</label>
            <select id="itemKind">
              ${kinds.map((k) => `<option value="${escapeHtml(k)}" ${item.kind === k ? 'selected' : ''}>${escapeHtml(k)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="itemTitle">Display Title (optional)</label>
            <input id="itemTitle" type="text" value="${escapeHtml(item.title || item.name || '')}" placeholder="Test Writer">
          </div>
          <div class="form-group">
            <label for="itemTags">Item Tags (comma-separated, optional)</label>
            <input id="itemTags" type="text" value="${escapeHtml(tagsStr)}" placeholder="testing, unit">
          </div>
          <div class="form-group full">
            <label for="itemDescription">Item Description (optional)</label>
            <input id="itemDescription" type="text" value="${escapeHtml(item.description || '')}" placeholder="Generates unit tests">
          </div>
        </div>
        <div class="actions-row">
          <span class="hint">${status?.exists ? '✓ Referenced file exists on disk' : '✗ Referenced file not found on disk'}</span>
          <button type="button" id="btnSaveItemManifest" data-item-index="${itemIndex}">Save Item Entry</button>
        </div>
      </div>
      ${contentEditorHtml}
    `;
  };

  const renderNewPrimitiveWizard = () => {
    const unassigned = state.inspection?.unassignedPrimitives || [];
    return `
      <div class="card">
        <h2>✨ Create New Primitive &amp; Add to Collection</h2>
        <p class="hint">Scaffolds the file in the right folder with valid frontmatter/schema and adds it to this collection automatically.</p>
        <div class="form-grid">
          <div class="form-group">
            <label for="wizName">Primitive Name</label>
            <input id="wizName" type="text" placeholder="Code Review Helper">
          </div>
          <div class="form-group">
            <label for="wizKind">Primitive Kind</label>
            <select id="wizKind">
              <option value="prompt">prompt (prompts/*.prompt.md)</option>
              <option value="instruction">instruction (instructions/*.instructions.md)</option>
              <option value="agent">agent (agents/*.agent.md)</option>
              <option value="skill">skill (skills/*/SKILL.md)</option>
              <option value="plugin">plugin (plugins/*/plugin.json)</option>
              <option value="hook">hook (hooks/*.hook.json)</option>
              <option value="chat-mode">chat-mode (chat-modes/*.chatmode.md)</option>
            </select>
          </div>
          <div class="form-group full">
            <label for="wizDescription">Description</label>
            <input id="wizDescription" type="text" placeholder="Helps review pull requests for best practices and bugs">
          </div>
          <div class="form-group">
            <label for="wizApplyTo">ApplyTo Pattern (for instructions)</label>
            <input id="wizApplyTo" type="text" value="**" placeholder="**/*.ts">
          </div>
          <div class="form-group">
            <label for="wizTags">Item Tags (comma-separated)</label>
            <input id="wizTags" type="text" placeholder="review, quality">
          </div>
          <div class="form-group full">
            <label for="wizBody">Initial Instructions / Markdown Body</label>
            <textarea id="wizBody" class="code-editor" rows="8" placeholder="# Instructions&#10;&#10;Describe how the AI assistant should perform this task..."></textarea>
          </div>
        </div>
        <div class="actions-row">
          <span class="hint">Creates the file on disk and appends it to items[] in .collection.yml.</span>
          <button type="button" id="btnRunScaffoldWizard">Create File &amp; Add to Collection</button>
        </div>
      </div>

      ${unassigned.length > 0
    ? `
        <div class="card">
          <h3>Or Add an Existing Repository File (${unassigned.length} available)</h3>
          <div class="form-grid">
            <div class="form-group full">
              <label for="existingFileSelect">Select Unassigned File in Workspace</label>
              <select id="existingFileSelect">
                ${unassigned.map((u) => {
    const uPath = escapeHtml(u.path);
    const uKind = escapeHtml(u.kind);
    const uTitle = escapeHtml(u.title);
    return `<option value="${uPath}" data-kind="${uKind}" data-title="${uTitle}">${uPath} (${uKind})</option>`;
  }).join('')}
              </select>
            </div>
          </div>
          <div class="actions-row">
            <span></span>
            <button class="secondary" type="button" id="btnAddSelectedExistingFile">Add Selected File to Collection</button>
          </div>
        </div>
        `
    : ''}
    `;
  };

  const renderMcpInspector = (manifest) => {
    const inputs = manifest.mcp?.inputs || [];
    const servers = manifest.mcp?.items || {};

    return `
      <div class="card">
        <h2>🔌 MCP Servers (${Object.keys(servers).length})</h2>
        ${Object.entries(servers).map(([key, srv]) => `
          <div class="item-row">
            <div>
              <strong>${escapeHtml(key)}</strong>
              <span class="hint">(${escapeHtml(srv.type || 'stdio')}) ${escapeHtml(srv.command || srv.url || '')}</span>
            </div>
            <button class="danger small" type="button" data-remove-mcp-server="${escapeHtml(key)}">Remove</button>
          </div>
        `).join('')}

        <h3>Add / Update MCP Server</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="mcpSrvKey">Server Key</label>
            <input id="mcpSrvKey" type="text" placeholder="python-analyzer">
          </div>
          <div class="form-group">
            <label for="mcpSrvType">Transport Type</label>
            <select id="mcpSrvType">
              <option value="stdio">stdio (local process)</option>
              <option value="http">http (remote HTTP)</option>
              <option value="sse">sse (remote SSE)</option>
            </select>
          </div>
          <div class="form-group">
            <label for="mcpSrvCommandOrUrl">Command (for stdio) or URL (for http/sse)</label>
            <input id="mcpSrvCommandOrUrl" type="text" placeholder="python or https://api.example.com/mcp">
          </div>
          <div class="form-group">
            <label for="mcpSrvArgs">Arguments (comma-separated, stdio only)</label>
            <input id="mcpSrvArgs" type="text" placeholder="\${bundlePath}/server.py">
          </div>
          <div class="form-group full">
            <label for="mcpSrvDesc">Description (optional)</label>
            <input id="mcpSrvDesc" type="text" placeholder="Local MCP analyzer">
          </div>
        </div>
        <div class="actions-row">
          <span></span>
          <button type="button" id="btnSaveMcpServer">Save MCP Server</button>
        </div>
      </div>

      <div class="card">
        <h2>🔑 MCP Inputs (${inputs.length})</h2>
        ${inputs.map((inp, idx) => `
          <div class="item-row">
            <div>
              <strong>\${input:${escapeHtml(inp.id)}}</strong>
              <span class="hint">${escapeHtml(inp.type)}${inp.password ? ' • secret' : ''} — ${escapeHtml(inp.description || '')}</span>
            </div>
            <button class="danger small" type="button" data-remove-mcp-input="${idx}">Remove</button>
          </div>
        `).join('')}

        <h3>Add / Update MCP Input</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="mcpInpId">Input ID</label>
            <input id="mcpInpId" type="text" placeholder="apiToken">
          </div>
          <div class="form-group">
            <label for="mcpInpType">Input Type</label>
            <select id="mcpInpType">
              <option value="promptString">promptString</option>
              <option value="pickString">pickString</option>
              <option value="command">command</option>
            </select>
          </div>
          <div class="form-group">
            <label for="mcpInpDesc">Description</label>
            <input id="mcpInpDesc" type="text" placeholder="API access token">
          </div>
          <div class="form-group">
            <label for="mcpInpPassword">Secret / Password Masked</label>
            <select id="mcpInpPassword">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        </div>
        <div class="actions-row">
          <span></span>
          <button type="button" id="btnSaveMcpInput">Save MCP Input</button>
        </div>
      </div>
    `;
  };

  const renderInspector = () => {
    const container = document.querySelector('#inspectorContainer');
    if (!container) {
      return;
    }

    const manifest = state.inspection?.manifest || {};
    switch (state.selection.section) {
      case 'readme': {
        container.innerHTML = renderReadmeInspector(manifest);
        break;
      }
      case 'item': {
        container.innerHTML = renderItemInspector(manifest, Number(state.selection.index ?? 0));
        break;
      }
      case 'new-primitive': {
        container.innerHTML = renderNewPrimitiveWizard();
        break;
      }
      case 'mcp': {
        container.innerHTML = renderMcpInspector(manifest);
        break;
      }
      default: {
        container.innerHTML = renderMetadataInspector(manifest);
        break;
      }
    }
  };

  const renderAll = () => {
    renderHeader();
    renderTree();
    renderInspector();
  };

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }
    if (msg.type === 'documentState') {
      state.filePath = msg.filePath || state.filePath;
      state.workspaceRoot = msg.workspaceRoot || state.workspaceRoot;
      state.inspection = msg.inspection;
      state.siblingCollections = msg.siblingCollections || [];
      if (msg.contributionContext !== undefined) {
        state.contributionContext = msg.contributionContext;
      }
      state.readmeContent = msg.readmeContent || null;
      state.primitiveContentsByPath = {};
      if (msg.focusTarget) {
        state.selection = msg.focusTarget;
      }
      renderAll();
    } else if (msg.type === 'contributionContextUpdated') {
      state.contributionContext = msg.contributionContext || null;
      renderHeader();
    } else if (msg.type === 'primitiveContentLoaded' && msg.relPath) {
      state.primitiveContentsByPath[msg.relPath] = msg.content;
      if (msg.savedToast) {
        state.savedToastMessage = '✓ Saved to disk';
      }
      renderInspector();
    }
  });

  // Filter input listener
  document.querySelector('#treeFilter')?.addEventListener('input', (e) => {
    state.filterText = e.target.value || '';
    renderTree();
  });

  // Collection switcher listener
  document.querySelector('#collectionSwitcher')?.addEventListener('change', (e) => {
    const filePath = e.target.value;
    if (filePath && filePath !== state.filePath) {
      vscode.postMessage({ type: 'switchCollection', filePath });
    }
  });

  // Delegated click handler
  document.addEventListener('click', (e) => {
    const target = e.target;

    // Header actions
    if (target.closest('#btnNewCollection')) {
      vscode.postMessage({ type: 'createNewCollection' });
      return;
    }
    if (target.closest('#btnValidateAll')) {
      vscode.postMessage({ type: 'validateAll' });
      return;
    }
    if (target.closest('#btnCreatePrimitive') || target.closest('#btnAddNewItemOutline')) {
      state.selection = { section: 'new-primitive' };
      renderAll();
      return;
    }
    if (target.closest('#btnInspectMcp')) {
      state.selection = { section: 'mcp' };
      renderAll();
      notifySelectionChanged();
      return;
    }
    if (target.closest('#btnSplitYaml')) {
      vscode.postMessage({
        type: 'openYamlBeside',
        target: state.selection
      });
      return;
    }
    if (target.closest('#btnSubmitPr')) {
      vscode.postMessage({ type: 'submitPullRequest' });
      return;
    }
    if (target.closest('#upstreamPill') || target.closest('#prPill')) {
      const pill = target.closest('.pill.clickable');
      if (pill?.dataset.url) {
        vscode.postMessage({ type: 'openExternalUrl', url: pill.dataset.url });
      }
      return;
    }

    // Tree selection
    const selectEl = target.closest('[data-select-section]');
    if (selectEl) {
      const section = selectEl.dataset.selectSection;
      const idx = selectEl.dataset.selectIndex === undefined ? undefined : Number(selectEl.dataset.selectIndex);
      if (section === 'item' && typeof idx === 'number') {
        const selectedItem = (state.inspection?.manifest?.items || [])[idx];
        if (selectedItem?.path) {
          delete state.primitiveContentsByPath[selectedItem.path];
        }
      }
      state.savedToastMessage = '';
      state.selection = { section, index: idx };
      renderAll();
      notifySelectionChanged();
      return;
    }

    // Quick add unassigned file
    const quickAddEl = target.closest('[data-quick-add-path]');
    if (quickAddEl) {
      const itemCount = (state.inspection?.manifest?.items || []).length;
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'add-item',
          item: {
            path: quickAddEl.dataset.quickAddPath,
            kind: quickAddEl.dataset.quickAddKind || 'prompt',
            title: quickAddEl.dataset.quickAddTitle || undefined
          }
        },
        focusTarget: { section: 'item', index: itemCount }
      });
      return;
    }

    // Quick fix button
    const qfBtn = target.closest('[data-quick-fix-idx]');
    if (qfBtn) {
      const dIdx = Number(qfBtn.dataset.quickFixIdx);
      const diag = (state.inspection?.diagnostics || [])[dIdx];
      if (diag?.quickFix) {
        if (diag.quickFix.kind === 'scaffold-missing-item') {
          vscode.postMessage({
            type: 'scaffoldPrimitive',
            input: {
              kind: diag.quickFix.itemKind || 'prompt',
              name: diag.quickFix.filePath || 'example',
              customRelPath: diag.quickFix.filePath,
              addToCollection: false
            }
          });
        } else if (diag.quickFix.kind === 'scaffold-missing-readme') {
          vscode.postMessage({
            type: 'scaffoldPrimitive',
            input: {
              kind: 'readme',
              name: state.inspection?.manifest?.name || 'Collection',
              customRelPath: diag.quickFix.filePath
            }
          });
        } else {
          vscode.postMessage({
            type: 'applyMutation',
            mutation: {
              kind: 'apply-quick-fix',
              quickFix: diag.quickFix
            }
          });
        }
      }
      return;
    }

    // Sort items A-Z
    if (target.closest('#btnSortItems')) {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: { kind: 'sort-items' }
      });
      return;
    }

    // Version bump buttons
    const bumpBtn = target.closest('[data-bump-version]');
    if (bumpBtn) {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'bump-version',
          bump: bumpBtn.dataset.bumpVersion
        }
      });
      return;
    }

    // Save Metadata
    if (target.closest('#btnSaveMetadata')) {
      const rawTags = document.querySelector('#metaTags')?.value || '';
      const tags = rawTags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'update-metadata',
          metadata: {
            id: document.querySelector('#metaId')?.value.trim(),
            name: document.querySelector('#metaName')?.value.trim(),
            version: document.querySelector('#metaVersion')?.value.trim(),
            author: document.querySelector('#metaAuthor')?.value.trim(),
            description: document.querySelector('#metaDescription')?.value.trim(),
            tags
          }
        }
      });
      return;
    }

    // Save Display
    if (target.closest('#btnSaveDisplay')) {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'update-display',
          display: {
            color: document.querySelector('#dispColor')?.value.trim() || undefined,
            icon: document.querySelector('#dispIcon')?.value.trim() || undefined,
            ordering: document.querySelector('#dispOrdering')?.value || 'manual',
            show_badge: document.querySelector('#dispShowBadge')?.value === 'true'
          }
        }
      });
      return;
    }

    // README actions
    if (target.closest('#btnSaveReadmePath')) {
      const pathVal = document.querySelector('#readmePathInput')?.value.trim();
      vscode.postMessage({
        type: 'applyMutation',
        mutation: { kind: 'update-readme', path: pathVal || null }
      });
      return;
    }
    if (target.closest('#btnScaffoldReadme')) {
      const pathVal = document.querySelector('#readmePathInput')?.value.trim();
      vscode.postMessage({
        type: 'scaffoldPrimitive',
        input: {
          kind: 'readme',
          name: state.inspection?.manifest?.name || 'Collection',
          description: state.inspection?.manifest?.description || '',
          customRelPath: pathVal
        }
      });
      return;
    }
    if (target.closest('#btnOpenReadmeBeside')) {
      const pathVal = document.querySelector('#readmePathInput')?.value.trim();
      if (pathVal) {
        vscode.postMessage({ type: 'openReferencedFile', relPath: pathVal });
      }
      return;
    }
    if (target.closest('#btnSaveReadmeContent')) {
      const btn = target.closest('#btnSaveReadmeContent');
      const relPath = btn.dataset.relPath;
      const rawContent = document.querySelector('#readmeBodyEditor')?.value || '';
      vscode.postMessage({
        type: 'savePrimitiveContent',
        relPath,
        update: { rawContent }
      });
      return;
    }

    // Item Manifest CRUD & Reorder
    if (target.closest('#btnSaveItemManifest')) {
      const idx = Number(target.closest('#btnSaveItemManifest').dataset.itemIndex);
      const rawTags = document.querySelector('#itemTags')?.value || '';
      const tags = rawTags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'update-item',
          index: idx,
          item: {
            path: document.querySelector('#itemPath')?.value.trim() || '',
            kind: document.querySelector('#itemKind')?.value || 'prompt',
            title: document.querySelector('#itemTitle')?.value.trim() || undefined,
            description: document.querySelector('#itemDescription')?.value.trim() || undefined,
            tags: tags.length > 0 ? tags : undefined
          }
        },
        focusTarget: { section: 'item', index: idx }
      });
      return;
    }
    if (target.closest('#btnMoveItemUp')) {
      const idx = Number(state.selection.index ?? 0);
      if (idx > 0) {
        vscode.postMessage({
          type: 'applyMutation',
          mutation: { kind: 'move-item', fromIndex: idx, toIndex: idx - 1 },
          focusTarget: { section: 'item', index: idx - 1 }
        });
      }
      return;
    }
    if (target.closest('#btnMoveItemDown')) {
      const idx = Number(state.selection.index ?? 0);
      const total = (state.inspection?.manifest?.items || []).length;
      if (idx < total - 1) {
        vscode.postMessage({
          type: 'applyMutation',
          mutation: { kind: 'move-item', fromIndex: idx, toIndex: idx + 1 },
          focusTarget: { section: 'item', index: idx + 1 }
        });
      }
      return;
    }
    if (target.closest('#btnDeleteItem')) {
      const idx = Number(target.closest('#btnDeleteItem').dataset.itemIndex);
      vscode.postMessage({
        type: 'applyMutation',
        mutation: { kind: 'remove-item', index: idx },
        focusTarget: { section: 'metadata' }
      });
      return;
    }

    // Item Content actions
    const openFileBtn = target.closest('[data-open-file]');
    if (openFileBtn) {
      vscode.postMessage({
        type: 'openReferencedFile',
        relPath: openFileBtn.dataset.openFile
      });
      return;
    }
    if (target.closest('#btnScaffoldMissingItem')) {
      const btn = target.closest('#btnScaffoldMissingItem');
      vscode.postMessage({
        type: 'scaffoldPrimitive',
        input: {
          kind: btn.dataset.itemKind || 'prompt',
          name: btn.dataset.itemTitle || 'Example',
          customRelPath: btn.dataset.relPath,
          addToCollection: false
        }
      });
      return;
    }
    if (target.closest('#btnSavePrimitiveMarkdown')) {
      const btn = target.closest('#btnSavePrimitiveMarkdown');
      const relPath = btn.dataset.relPath;
      const toolsRaw = document.querySelector('#primFmTools')?.value || '';
      const tools = toolsRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      vscode.postMessage({
        type: 'savePrimitiveContent',
        relPath,
        update: {
          kind: btn.dataset.itemKind,
          frontmatter: {
            name: document.querySelector('#primFmName')?.value.trim() || undefined,
            description: document.querySelector('#primFmDescription')?.value.trim() || undefined,
            applyTo: document.querySelector('#primFmApplyTo')?.value.trim() || undefined,
            tools: tools.length > 0 ? tools : undefined,
            model: document.querySelector('#primFmModel')?.value.trim() || undefined
          },
          body: document.querySelector('#primBodyEditor')?.value || ''
        }
      });
      return;
    }
    if (target.closest('#btnSavePluginContent')) {
      const btn = target.closest('#btnSavePluginContent');
      const relPath = btn.dataset.relPath;
      const existingLoaded = state.primitiveContentsByPath[relPath];
      const existingAuthor = (existingLoaded?.pluginManifest?.author && typeof existingLoaded.pluginManifest.author === 'object')
        ? existingLoaded.pluginManifest.author
        : {};
      const authorNameVal = document.querySelector('#primPluginAuthor')?.value.trim();
      const mergedAuthor = {
        ...existingAuthor,
        ...(authorNameVal ? { name: authorNameVal } : {})
      };
      vscode.postMessage({
        type: 'savePrimitiveContent',
        relPath,
        update: {
          kind: 'plugin',
          pluginManifest: {
            name: document.querySelector('#primPluginName')?.value.trim() || 'plugin',
            version: document.querySelector('#primPluginVersion')?.value.trim() || '1.0.0',
            description: document.querySelector('#primPluginDescription')?.value.trim() || '',
            ...(Object.keys(mergedAuthor).length > 0 ? { author: mergedAuthor } : {})
          }
        }
      });
      return;
    }

    // Create New Primitive Wizard
    if (target.closest('#btnRunScaffoldWizard')) {
      const name = document.querySelector('#wizName')?.value.trim() || 'New Primitive';
      const kind = document.querySelector('#wizKind')?.value || 'prompt';
      const description = document.querySelector('#wizDescription')?.value.trim() || '';
      const applyTo = document.querySelector('#wizApplyTo')?.value.trim() || undefined;
      const tagsRaw = document.querySelector('#wizTags')?.value || '';
      const tags = tagsRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      const body = document.querySelector('#wizBody')?.value || '';

      vscode.postMessage({
        type: 'scaffoldPrimitive',
        input: {
          name,
          kind,
          description,
          applyTo,
          tags,
          body,
          addToCollection: true
        }
      });
      return;
    }
    if (target.closest('#btnAddSelectedExistingFile')) {
      const sel = document.querySelector('#existingFileSelect');
      const opt = sel?.selectedOptions?.[0];
      if (sel?.value) {
        const itemCount = (state.inspection?.manifest?.items || []).length;
        vscode.postMessage({
          type: 'applyMutation',
          mutation: {
            kind: 'add-item',
            item: {
              path: sel.value,
              kind: opt?.dataset.kind || 'prompt',
              title: opt?.dataset.title || undefined
            }
          },
          focusTarget: { section: 'item', index: itemCount }
        });
      }
      return;
    }

    // MCP actions
    if (target.closest('#btnSaveMcpServer')) {
      const key = document.querySelector('#mcpSrvKey')?.value.trim();
      if (!key) {
        return;
      }
      const srvType = document.querySelector('#mcpSrvType')?.value || 'stdio';
      const cmdOrUrl = document.querySelector('#mcpSrvCommandOrUrl')?.value.trim() || '';
      const argsRaw = document.querySelector('#mcpSrvArgs')?.value || '';
      const args = argsRaw.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
      const desc = document.querySelector('#mcpSrvDesc')?.value.trim() || undefined;

      const server = srvType === 'stdio'
        ? {
          type: 'stdio',
          command: cmdOrUrl || 'node',
          ...(args.length > 0 ? { args } : {}),
          ...(desc ? { description: desc } : {})
        }
        : {
          type: srvType,
          url: cmdOrUrl || 'https://api.example.com/mcp',
          ...(desc ? { description: desc } : {})
        };

      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'upsert-mcp-server',
          key,
          server
        },
        focusTarget: { section: 'mcp' }
      });
      return;
    }
    const rmSrvBtn = target.closest('[data-remove-mcp-server]');
    if (rmSrvBtn) {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'remove-mcp-server',
          key: rmSrvBtn.dataset.removeMcpServer
        },
        focusTarget: { section: 'mcp' }
      });
      return;
    }
    if (target.closest('#btnSaveMcpInput')) {
      const id = document.querySelector('#mcpInpId')?.value.trim();
      if (!id) {
        return;
      }
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'upsert-mcp-input',
          input: {
            id,
            type: document.querySelector('#mcpInpType')?.value || 'promptString',
            description: document.querySelector('#mcpInpDesc')?.value.trim() || undefined,
            password: document.querySelector('#mcpInpPassword')?.value === 'true'
          }
        },
        focusTarget: { section: 'mcp' }
      });
      return;
    }
    const rmInpBtn = target.closest('[data-remove-mcp-input]');
    if (rmInpBtn) {
      vscode.postMessage({
        type: 'applyMutation',
        mutation: {
          kind: 'remove-mcp-input',
          index: Number(rmInpBtn.dataset.removeMcpInput)
        },
        focusTarget: { section: 'mcp' }
      });
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
