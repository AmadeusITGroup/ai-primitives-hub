// Registry Explorer View JavaScript
// Renders the tree data as HTML with Amadeus Neue font

(() => {
  const vscode = acquireVsCodeApi();
  let treeData = [];
  let expandedNodes = new Set();

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'treeData') {
      treeData = message.nodes;
      renderTree();
    } else if (message.type === 'refresh') {
      vscode.postMessage({ type: 'requestTreeData' });
    }
  });

  // Request initial data
  vscode.postMessage({ type: 'requestTreeData' });

  const renderTree = () => {
    const explorer = document.querySelector('#explorer');
    if (!treeData || treeData.length === 0) {
      explorer.innerHTML = '<div class="loading"><span class="spinner"></span>Loading...</div>';
      return;
    }
    explorer.innerHTML = treeData.map((node) => renderNode(node, 0)).join('');
  };

  const renderNode = (node, indent) => {
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expandedNodes.has(node.id);
    const chevron = hasChildren
      ? `<span class="tree-chevron ${isExpanded ? '' : 'collapsed'}" data-action="toggle" data-node-id="${escapeAttr(node.id)}">▾</span>`
      : '<span class="tree-chevron-spacer"></span>';
    const icon = node.icon ? `<span class="tree-icon fa-icon ${node.icon}"></span>` : '<span class="tree-chevron-spacer"></span>';
    const description = node.description ? `<span class="tree-description">${escapeHtml(node.description)}</span>` : '';
    const statusClass = node.statusClass ? ` ${node.statusClass}` : '';

    // Render action buttons (shown on hover)
    let actionsHtml = '';
    if (node.actions && node.actions.length > 0) {
      actionsHtml = '<span class="tree-actions">' + node.actions.map((action) => {
        const dangerClass = action.danger ? ' tree-action-danger' : '';
        return `<button class="tree-action-btn${dangerClass}" data-action="executeAction" data-command="${escapeAttr(action.command)}" data-node-id="${escapeAttr(node.id)}" title="${escapeAttr(action.label)}"><i class="fa-icon ${action.icon}"></i></button>`;
      }).join('') + '</span>';
    }

    let html = `<div class="tree-node indent-${Math.min(indent, 4)}${statusClass}" data-action="click" data-node-id="${escapeAttr(node.id)}" data-command="${escapeAttr(node.command || '')}" data-context="${escapeAttr(node.contextValue || '')}">`
      + chevron
      + icon
      + `<span class="tree-label">${node.label}</span>`
      + description
      + actionsHtml
      + '</div>';

    if (hasChildren && isExpanded) {
      html += node.children.map((child) => renderNode(child, indent + 1)).join('');
    }

    return html;
  };

  const escapeHtml = (text) => {
    if (!text) { return ''; }
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  const escapeAttr = (text) => {
    if (!text) { return ''; }
    return escapeHtml(text).replace(/"/g, '&quot;');
  };

  // Event delegation
  document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) { return; }

    const action = actionEl.dataset.action;
    const nodeId = actionEl.dataset.nodeId;

    if (action === 'toggle') {
      e.stopPropagation();
      if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);
      } else {
        expandedNodes.add(nodeId);
      }
      renderTree();
    } else if (action === 'executeAction') {
      e.stopPropagation();
      const command = actionEl.dataset.command;
      if (command) {
        vscode.postMessage({ type: 'executeCommand', command: command, nodeId: nodeId });
      }
    } else if (action === 'click') {
      const command = actionEl.dataset.command;
      const contextValue = actionEl.dataset.context;
      if (command) {
        vscode.postMessage({ type: 'executeCommand', command: command, nodeId: nodeId });
      }
    }
  });

  // Context menu (right-click)
  document.addEventListener('contextmenu', (e) => {
    const nodeEl = e.target.closest('[data-context]');
    if (!nodeEl) { return; }

    e.preventDefault();
    const nodeId = nodeEl.dataset.nodeId;
    const contextValue = nodeEl.dataset.context;

    vscode.postMessage({ type: 'contextMenu', nodeId: nodeId, contextValue: contextValue, x: e.clientX, y: e.clientY });
  });
})();