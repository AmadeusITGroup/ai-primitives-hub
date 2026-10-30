/**
 * TreeDataProvider representing all detected `*.collection.yml` manifests in the
 * workspace (or the currently active collection file).
 *
 * Displays:
 * - Contribution & Validation Status (Workspace summary, Validate All, New Collection, Upstream repo, Open PR status)
 * - Detected Collections (`Collections (N)`) -> each collection node:
 *   - Metadata & Display (`id`, `name`, `version`, `author`, `tags`, `readme`, `display`)
 *   - Items (`Items (K)`) with primitive kind icons, file existence badges, and quick Open/Scaffold/Remove actions
 *   - MCP Configuration (`MCP (M)`) with inputs and servers
 */
import * as path from 'node:path';
import type {
  CollectionDocumentInspection,
  CollectionEditorService,
  CollectionWorkspaceContributionContext,
  WorkspaceCollectionsOverview,
  WorkspaceCollectionSummary,
} from '@ai-primitives-hub/app';
import * as vscode from 'vscode';

export enum CollectionTreeItemType {
  STATUS_ROOT = 'collection_status_root',
  STATUS_ITEM = 'collection_status_item',
  PR_ACTION = 'collection_pr_action',
  VALIDATE_ACTION = 'collection_validate_action',
  CREATE_COLLECTION_ACTION = 'collection_create_action',
  COLLECTIONS_ROOT = 'collection_collections_root',
  COLLECTION_NODE = 'collection_node',
  METADATA_GROUP = 'collection_metadata_group',
  METADATA_FIELD = 'collection_metadata_field',
  ITEMS_GROUP = 'collection_items_group',
  ADD_ITEM_ACTION = 'collection_add_item_action',
  COLLECTION_ITEM = 'collection_item',
  COLLECTION_ITEM_MISSING = 'collection_item_missing',
  MCP_GROUP = 'collection_mcp_group',
  MCP_SERVER_ITEM = 'collection_mcp_server_item',
  MCP_INPUT_ITEM = 'collection_mcp_input_item'
}

export class CollectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly itemType: CollectionTreeItemType,
    public readonly data?: Record<string, unknown>,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = itemType;
  }
}

const KIND_ICON_MAP: Record<string, string> = {
  prompt: 'comment-discussion',
  instruction: 'book',
  agent: 'hubot',
  'chat-mode': 'comment',
  skill: 'lightbulb',
  plugin: 'extensions',
  hook: 'zap',
  'mcp-server': 'plug',
  steering: 'compass',
  spec: 'file-code',
  command: 'terminal',
  rule: 'law',
  'output-style': 'paintcan',
  tool: 'tools',
  power: 'flame',
  knowledge: 'library',
  playbook: 'notebook'
};

export class CollectionTreeProvider implements vscode.TreeDataProvider<CollectionTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<CollectionTreeItem | undefined | null>();
  private workspaceRoot: string | undefined;
  private collectionsPath = 'collections';
  private overview: WorkspaceCollectionsOverview | undefined;
  private activeFilePath: string | undefined;
  private readonly activeInspectionByPath = new Map<string, CollectionDocumentInspection>();
  private contributionContext: CollectionWorkspaceContributionContext | undefined;

  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly editorService: CollectionEditorService) {}

  private getEffectiveCollections(): WorkspaceCollectionSummary[] {
    const map = new Map<string, WorkspaceCollectionSummary>();
    for (const col of (this.overview?.collections ?? [])) {
      const liveInspection = this.activeInspectionByPath.get(col.filePath) ?? col.inspection;
      const manifest = liveInspection.manifest;
      const errorCount = liveInspection.diagnostics.filter((d) => d.severity === 'error').length;
      const warningCount = liveInspection.diagnostics.filter((d) => d.severity === 'warning').length;
      map.set(col.filePath, {
        ...col,
        id: manifest?.id ?? col.id,
        name: manifest?.name ?? col.name,
        version: manifest?.version ?? col.version,
        description: manifest?.description ?? col.description,
        itemCount: Array.isArray(manifest?.items) ? manifest.items.length : 0,
        mcpServerCount: manifest?.mcp?.items ? Object.keys(manifest.mcp.items).length : 0,
        valid: liveInspection.valid,
        errorCount,
        warningCount,
        inspection: liveInspection
      });
    }

    if (this.activeFilePath && !map.has(this.activeFilePath)) {
      const liveInspection = this.activeInspectionByPath.get(this.activeFilePath);
      if (liveInspection) {
        const manifest = liveInspection.manifest;
        const baseName = path.basename(this.activeFilePath);
        const errorCount = liveInspection.diagnostics.filter((d) => d.severity === 'error').length;
        const warningCount = liveInspection.diagnostics.filter((d) => d.severity === 'warning').length;
        map.set(this.activeFilePath, {
          filePath: this.activeFilePath,
          relPath: this.workspaceRoot
            ? path.relative(this.workspaceRoot, this.activeFilePath).replaceAll('\\', '/')
            : baseName,
          id: manifest?.id ?? baseName.replace(/\.collection\.ya?ml$/i, ''),
          name: manifest?.name ?? baseName,
          version: manifest?.version ?? '1.0.0',
          description: manifest?.description ?? '',
          itemCount: Array.isArray(manifest?.items) ? manifest.items.length : 0,
          mcpServerCount: manifest?.mcp?.items ? Object.keys(manifest.mcp.items).length : 0,
          valid: liveInspection.valid,
          errorCount,
          warningCount,
          inspection: liveInspection
        });
      }
    }

    return [...map.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  private buildRootItems(): CollectionTreeItem[] {
    const collections = this.getEffectiveCollections();
    if (collections.length === 0) {
      const emptyItem = new CollectionTreeItem(
        'Open a collection repository or run "Contribute to Collection"',
        CollectionTreeItemType.STATUS_ITEM,
        undefined,
        vscode.TreeItemCollapsibleState.None
      );
      emptyItem.iconPath = new vscode.ThemeIcon('info');
      emptyItem.command = {
        command: 'promptregistry.contributeToCollection',
        title: 'Contribute to Collection'
      };

      const createItem = new CollectionTreeItem(
        'Create New Collection...',
        CollectionTreeItemType.CREATE_COLLECTION_ACTION,
        undefined,
        vscode.TreeItemCollapsibleState.None
      );
      createItem.iconPath = new vscode.ThemeIcon('add');
      createItem.command = {
        command: 'promptregistry.createNewCollectionVisual',
        title: 'Create New Collection'
      };
      return [emptyItem, createItem];
    }

    const totalErrors = collections.reduce((acc, c) => acc + c.errorCount, 0);
    const totalWarnings = collections.reduce((acc, c) => acc + c.warningCount, 0);
    const allValid = totalErrors === 0;

    const statusRoot = new CollectionTreeItem(
      'Contribution & Validation',
      CollectionTreeItemType.STATUS_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );
    statusRoot.description = allValid
      ? `✓ ${collections.length} valid${totalWarnings > 0 ? ` (${totalWarnings} warning(s))` : ''}`
      : `✗ ${totalErrors} error(s)`;
    statusRoot.iconPath = new vscode.ThemeIcon(allValid ? 'pass' : 'error');

    const collectionsRoot = new CollectionTreeItem(
      `Collections (${collections.length})`,
      CollectionTreeItemType.COLLECTIONS_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );
    collectionsRoot.iconPath = new vscode.ThemeIcon('library');

    return [statusRoot, collectionsRoot];
  }

  private buildStatusChildren(): CollectionTreeItem[] {
    const items: CollectionTreeItem[] = [];
    const collections = this.getEffectiveCollections();
    const totalErrors = collections.reduce((acc, c) => acc + c.errorCount, 0);

    const validationItem = new CollectionTreeItem(
      totalErrors === 0
        ? `Validation: All ${collections.length} collection(s) passing`
        : `Validation: ${totalErrors} error(s) across ${collections.length} collection(s)`,
      CollectionTreeItemType.VALIDATE_ACTION
    );
    validationItem.iconPath = new vscode.ThemeIcon(totalErrors === 0 ? 'check-all' : 'warning');
    validationItem.description = 'Click to validate';
    validationItem.command = {
      command: 'promptRegistry.validateCollections',
      title: 'Validate Collections'
    };
    items.push(validationItem);

    const createItem = new CollectionTreeItem(
      'Create New Collection...',
      CollectionTreeItemType.CREATE_COLLECTION_ACTION
    );
    createItem.iconPath = new vscode.ThemeIcon('add');
    createItem.command = {
      command: 'promptregistry.createNewCollectionVisual',
      title: 'Create New Collection'
    };
    items.push(createItem);

    if (this.contributionContext?.upstreamSlug) {
      const upstreamUrl = `https://github.com/${this.contributionContext.upstreamSlug}`;
      const repoItem = new CollectionTreeItem(
        `Upstream: ${this.contributionContext.upstreamSlug}`,
        CollectionTreeItemType.STATUS_ITEM,
        { url: upstreamUrl }
      );
      repoItem.description = this.contributionContext.currentBranch
        ? `branch: ${this.contributionContext.currentBranch}`
        : undefined;
      repoItem.tooltip = `Click to open ${upstreamUrl} in browser`;
      repoItem.iconPath = new vscode.ThemeIcon('repo-forked');
      repoItem.command = {
        command: 'promptregistry.openCollectionPullRequest',
        title: 'Open Upstream Repository in Browser',
        arguments: [upstreamUrl]
      };
      items.push(repoItem);
    }

    const rawPr = this.contributionContext?.session?.pullRequest;
    const pr = rawPr?.state === 'open' ? rawPr : undefined;
    if (pr) {
      const checksLabel = pr.checks
        ? ` • Checks: ${pr.checks.state} (${pr.checks.passingCount}/${pr.checks.totalCount})`
        : '';
      const prItem = new CollectionTreeItem(
        `PR #${pr.number}: ${pr.title}`,
        CollectionTreeItemType.PR_ACTION,
        { url: pr.htmlUrl }
      );
      prItem.description = `${pr.state.toUpperCase()}${checksLabel}`;
      prItem.tooltip = `Click to open ${pr.htmlUrl} in browser`;
      prItem.iconPath = new vscode.ThemeIcon('git-pull-request');
      prItem.command = {
        command: 'promptregistry.openCollectionPullRequest',
        title: 'Open Pull Request in Browser',
        arguments: [pr.htmlUrl]
      };
      items.push(prItem);

      const refreshPrItem = new CollectionTreeItem(
        `Refresh PR #${pr.number} Status`,
        CollectionTreeItemType.STATUS_ITEM,
        { url: pr.htmlUrl }
      );
      refreshPrItem.description = 'Check CI & merge status';
      refreshPrItem.iconPath = new vscode.ThemeIcon('sync');
      refreshPrItem.command = {
        command: 'promptregistry.refreshCollectionPullRequestStatus',
        title: 'Refresh Pull Request Status'
      };
      items.push(refreshPrItem);
    } else {
      const submitPrItem = new CollectionTreeItem(
        'Commit & Create Pull Request...',
        CollectionTreeItemType.STATUS_ITEM,
        { filePath: this.activeFilePath ?? collections[0]?.filePath }
      );
      submitPrItem.iconPath = new vscode.ThemeIcon('git-pull-request-create');
      submitPrItem.command = {
        command: 'promptregistry.submitCollectionPullRequest',
        title: 'Submit Pull Request'
      };
      items.push(submitPrItem);
    }

    return items;
  }

  private buildCollectionNodes(): CollectionTreeItem[] {
    const collections = this.getEffectiveCollections();
    return collections.map((col, idx) => {
      const isFocused = this.activeFilePath === col.filePath || (!this.activeFilePath && idx === 0);
      const node = new CollectionTreeItem(
        col.name,
        CollectionTreeItemType.COLLECTION_NODE,
        {
          filePath: col.filePath,
          relPath: col.relPath,
          collectionId: col.id
        },
        isFocused ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      const statusBadge = col.valid
        ? (col.warningCount > 0 ? '⚠' : '✓')
        : `✗ (${col.errorCount})`;
      node.description = `${col.id} • v${col.version} • ${col.itemCount} item(s) ${statusBadge}`;
      node.tooltip = `${col.name} (${col.relPath})\n${col.description || 'No description'}`;
      node.iconPath = new vscode.ThemeIcon(col.valid ? 'package' : 'error');
      node.command = {
        command: 'promptregistry.openCollectionVisualEditor',
        title: 'Open Collection in Visual Editor',
        arguments: [vscode.Uri.file(col.filePath), { section: 'metadata' }]
      };
      return node;
    });
  }

  private buildCollectionSectionNodes(filePath: string): CollectionTreeItem[] {
    const col = this.getEffectiveCollections().find((c) => c.filePath === filePath);
    if (!col) {
      return [];
    }

    const metadataGroup = new CollectionTreeItem(
      'Metadata & Display',
      CollectionTreeItemType.METADATA_GROUP,
      { filePath },
      vscode.TreeItemCollapsibleState.Collapsed
    );
    metadataGroup.description = `v${col.version} • ${col.inspection.manifest?.author ?? 'No author'}`;
    metadataGroup.iconPath = new vscode.ThemeIcon('info');
    metadataGroup.command = {
      command: 'promptregistry.openCollectionVisualEditor',
      title: 'Focus Metadata in Visual Editor',
      arguments: [vscode.Uri.file(filePath), { section: 'metadata' }]
    };

    const itemsGroup = new CollectionTreeItem(
      `Primitive Items (${col.itemCount})`,
      CollectionTreeItemType.ITEMS_GROUP,
      { filePath },
      vscode.TreeItemCollapsibleState.Expanded
    );
    itemsGroup.iconPath = new vscode.ThemeIcon('list-unordered');

    const mcpInputsCount = col.inspection.manifest?.mcp?.inputs?.length ?? 0;
    const mcpTotal = col.mcpServerCount + mcpInputsCount;
    const mcpGroup = new CollectionTreeItem(
      `MCP Configuration (${mcpTotal})`,
      CollectionTreeItemType.MCP_GROUP,
      { filePath },
      mcpTotal > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    mcpGroup.iconPath = new vscode.ThemeIcon('plug');
    mcpGroup.command = {
      command: 'promptregistry.openCollectionVisualEditor',
      title: 'Focus MCP Configuration in Visual Editor',
      arguments: [vscode.Uri.file(filePath), { section: 'mcp' }]
    };

    return [metadataGroup, itemsGroup, mcpGroup];
  }

  private buildMetadataFields(filePath: string): CollectionTreeItem[] {
    const col = this.getEffectiveCollections().find((c) => c.filePath === filePath);
    const m = col?.inspection.manifest;
    if (!m) {
      return [];
    }

    const rows: [string, string][] = [
      ['ID', m.id ?? ''],
      ['Name', m.name ?? ''],
      ['Version', m.version ?? '1.0.0'],
      ['Author', m.author ?? '—'],
      ['Tags', Array.isArray(m.tags) && m.tags.length > 0 ? m.tags.join(', ') : '—'],
      ['README', m.readme?.path ? `${m.readme.path} (${col.inspection.readmeExists ? '✓' : '✗ missing'})` : 'None'],
      ['Ordering', m.display?.ordering ?? 'manual']
    ];

    return rows.map(([key, val]) => {
      const item = new CollectionTreeItem(
        `${key}: ${val}`,
        CollectionTreeItemType.METADATA_FIELD,
        { filePath }
      );
      item.command = {
        command: 'promptregistry.openCollectionVisualEditor',
        title: 'Edit Collection Metadata',
        arguments: [
          vscode.Uri.file(filePath),
          { section: key === 'README' ? 'readme' : (key === 'Ordering' ? 'display' : 'metadata') }
        ]
      };
      return item;
    });
  }

  private buildItemChildren(filePath: string): CollectionTreeItem[] {
    const col = this.getEffectiveCollections().find((c) => c.filePath === filePath);
    if (!col) {
      return [];
    }

    const addAction = new CollectionTreeItem(
      'Create or Add Primitive Item...',
      CollectionTreeItemType.ADD_ITEM_ACTION,
      { filePath }
    );
    addAction.iconPath = new vscode.ThemeIcon('add');
    addAction.command = {
      command: 'promptregistry.addCollectionItemVisual',
      title: 'Create or Add Primitive Item',
      arguments: [vscode.Uri.file(filePath)]
    };

    const itemNodes = col.inspection.itemStatuses.map((status) => {
      const label = status.previewTitle || status.title || path.basename(status.path || `item-${status.index + 1}`);
      const itemType = status.exists
        ? CollectionTreeItemType.COLLECTION_ITEM
        : CollectionTreeItemType.COLLECTION_ITEM_MISSING;
      const node = new CollectionTreeItem(
        label,
        itemType,
        {
          filePath,
          index: status.index,
          itemPath: status.path,
          kind: status.kind,
          exists: status.exists
        }
      );
      const badge = status.exists ? (status.routeMismatch ? '⚠ route' : '✓') : '✗ missing file';
      node.description = `${status.kind} • ${status.path} (${badge})`;
      node.tooltip = `${label}\nKind: ${status.kind}\nPath: ${status.path}\nStatus: ${status.exists ? 'File exists' : 'File not found on disk'}`;
      const iconId = status.exists ? (KIND_ICON_MAP[status.kind] ?? 'file') : 'warning';
      node.iconPath = new vscode.ThemeIcon(iconId);
      node.command = {
        command: 'promptregistry.openCollectionVisualEditor',
        title: 'Inspect Item in Visual Collection Editor',
        arguments: [vscode.Uri.file(filePath), { section: 'item', index: status.index }]
      };
      return node;
    });

    return [addAction, ...itemNodes];
  }

  private buildMcpChildren(filePath: string): CollectionTreeItem[] {
    const col = this.getEffectiveCollections().find((c) => c.filePath === filePath);
    const mcp = col?.inspection.manifest?.mcp;
    if (!mcp) {
      return [];
    }

    const children: CollectionTreeItem[] = [];
    for (const [idx, input] of (mcp.inputs ?? []).entries()) {
      const node = new CollectionTreeItem(
        `Input: ${input.id}`,
        CollectionTreeItemType.MCP_INPUT_ITEM,
        { filePath, index: idx, id: input.id }
      );
      node.description = `${input.type}${input.password ? ' (secret)' : ''}`;
      node.iconPath = new vscode.ThemeIcon('key');
      node.command = {
        command: 'promptregistry.openCollectionVisualEditor',
        title: 'Focus MCP Input in Visual Editor',
        arguments: [vscode.Uri.file(filePath), { section: 'mcp', subKey: input.id }]
      };
      children.push(node);
    }

    for (const [serverKey, srv] of Object.entries(mcp.items ?? {})) {
      const node = new CollectionTreeItem(
        `Server: ${serverKey}`,
        CollectionTreeItemType.MCP_SERVER_ITEM,
        { filePath, key: serverKey }
      );
      const transport = srv.type ?? 'stdio';
      node.description = `${transport}${srv.disabled ? ' [disabled]' : ''}`;
      node.iconPath = new vscode.ThemeIcon('server-process');
      node.command = {
        command: 'promptregistry.openCollectionVisualEditor',
        title: 'Focus MCP Server in Visual Editor',
        arguments: [vscode.Uri.file(filePath), { section: 'mcp', subKey: serverKey }]
      };
      children.push(node);
    }

    return children;
  }

  public refreshWorkspace(workspaceRoot?: string, collectionsPath = 'collections'): WorkspaceCollectionsOverview | undefined {
    this.workspaceRoot = workspaceRoot;
    this.collectionsPath = collectionsPath;
    if (workspaceRoot) {
      this.overview = this.editorService.detectWorkspaceCollections(workspaceRoot, collectionsPath);
      const livePaths = new Set(this.overview.collections.map((c) => c.filePath));
      for (const key of this.activeInspectionByPath.keys()) {
        if (!livePaths.has(key)) {
          this.activeInspectionByPath.delete(key);
        }
      }
      if (this.activeFilePath && !livePaths.has(this.activeFilePath)) {
        this.activeFilePath = undefined;
      }
      for (const col of this.overview.collections) {
        this.activeInspectionByPath.set(col.filePath, col.inspection);
      }
      if (!this.activeFilePath && this.overview.collections.length > 0) {
        this.activeFilePath = this.overview.collections[0].filePath;
      }
    } else {
      this.overview = undefined;
    }
    this._onDidChangeTreeData.fire(undefined);
    return this.overview;
  }

  public updateFromContent(
    filePath: string,
    content: string,
    precomputedInspection?: CollectionDocumentInspection
  ): CollectionDocumentInspection {
    this.activeFilePath = filePath;
    if (!this.workspaceRoot) {
      const parent = path.dirname(filePath);
      this.workspaceRoot = path.basename(parent) === 'collections' ? path.dirname(parent) : parent;
    }
    const inspection = precomputedInspection ?? this.editorService.inspectDocument(content, {
      filePath,
      workspaceRoot: this.workspaceRoot
    });
    this.activeInspectionByPath.set(filePath, inspection);
    if (this.workspaceRoot && !this.overview) {
      this.overview = this.editorService.detectWorkspaceCollections(this.workspaceRoot, this.collectionsPath);
    }
    this._onDidChangeTreeData.fire(undefined);
    return inspection;
  }

  public setContributionContext(context: CollectionWorkspaceContributionContext | undefined): void {
    this.contributionContext = context;
    this._onDidChangeTreeData.fire(undefined);
  }

  public getActiveFilePath(): string | undefined {
    return this.activeFilePath ?? this.overview?.collections[0]?.filePath;
  }

  public getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
  }

  public getOverview(): WorkspaceCollectionsOverview | undefined {
    return this.overview;
  }

  public getTreeItem(element: CollectionTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: CollectionTreeItem): Promise<CollectionTreeItem[]> {
    if (!element) {
      return Promise.resolve(this.buildRootItems());
    }

    const filePath = typeof element.data?.filePath === 'string' ? element.data.filePath : undefined;

    switch (element.itemType) {
      case CollectionTreeItemType.STATUS_ROOT: {
        return Promise.resolve(this.buildStatusChildren());
      }
      case CollectionTreeItemType.COLLECTIONS_ROOT: {
        return Promise.resolve(this.buildCollectionNodes());
      }
      case CollectionTreeItemType.COLLECTION_NODE: {
        return Promise.resolve(filePath ? this.buildCollectionSectionNodes(filePath) : []);
      }
      case CollectionTreeItemType.METADATA_GROUP: {
        return Promise.resolve(filePath ? this.buildMetadataFields(filePath) : []);
      }
      case CollectionTreeItemType.ITEMS_GROUP: {
        return Promise.resolve(filePath ? this.buildItemChildren(filePath) : []);
      }
      case CollectionTreeItemType.MCP_GROUP: {
        return Promise.resolve(filePath ? this.buildMcpChildren(filePath) : []);
      }
      default: {
        return Promise.resolve([]);
      }
    }
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
