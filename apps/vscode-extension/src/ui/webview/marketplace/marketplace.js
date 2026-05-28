// Marketplace View JavaScript
// Uses IIFE pattern for encapsulation and CSP compliance

(() => {
  const vscode = acquireVsCodeApi();
  let allBundles = [];
  let filterOptions = { tags: [], sources: [] };
  let selectedSource = 'all';
  let selectedTags = [];
  let showInstalledOnly = false;
  let setupState = 'complete'; // Default to complete to avoid showing setup prompt unnecessarily
  let sourcesCount = 0;

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'bundlesLoaded') {
      allBundles = message.bundles;
      filterOptions = message.filterOptions || { tags: [], sources: [] };
      setupState = message.setupState || 'complete';
      sourcesCount = message.sourcesCount || 0;
      updateFilterUI();
      renderBundles();
    }
  });

  // Request initial data when webview is ready
  // This ensures we get data even if the extension sent it before we were listening
  vscode.postMessage({ type: 'refresh' });

  // Update filter dropdowns with dynamic data
  const updateFilterUI = () => {
    var sourceList = document.querySelector('#sourceList');
    var tagList = document.querySelector('#tagList');

    // Populate source dropdown with radio buttons
    sourceList.innerHTML = '';

    // Add "All Sources" option
    var allItem = document.createElement('div');
    allItem.className = 'source-item' + (selectedSource === 'all' ? ' active' : '');
    allItem.dataset.source = 'all';
    allItem.innerHTML =
      '<input type="radio" name="source" id="source-all" value="all" ' + (selectedSource === 'all' ? 'checked' : '') + '>'
      + '<label for="source-all">All Sources</label>';
    sourceList.append(allItem);

    // Add source options
    filterOptions.sources.forEach((source) => {
      var sourceItem = document.createElement('div');
      sourceItem.className = 'source-item' + (selectedSource === source.id ? ' active' : '');
      sourceItem.dataset.source = source.id;
      sourceItem.innerHTML =
        '<input type="radio" name="source" id="source-' + source.id + '" value="' + source.id + '" ' + (selectedSource === source.id ? 'checked' : '') + '>'
        + '<label for="source-' + source.id + '">' + source.name + ' (' + source.bundleCount + ')</label>';
      sourceList.append(sourceItem);

      // Add click handler
      sourceItem.addEventListener('click', () => {
        document.querySelectorAll('.source-item').forEach((i) => {
          i.classList.remove('active');
        });
        sourceItem.classList.add('active');
        selectedSource = source.id;
        document.querySelector('#sourceSelectorText').textContent = source.name + ' (' + source.bundleCount + ')';
        sourceItem.querySelector('input[type="radio"]').checked = true;
        document.querySelector('#sourceDropdown').style.display = 'none';
        renderBundles();
      });
    });

    // Add click handler for "All Sources"
    allItem.addEventListener('click', () => {
      document.querySelectorAll('.source-item').forEach((i) => {
        i.classList.remove('active');
      });
      allItem.classList.add('active');
      selectedSource = 'all';
      document.querySelector('#sourceSelectorText').textContent = 'All Sources';
      allItem.querySelector('input[type="radio"]').checked = true;
      document.querySelector('#sourceDropdown').style.display = 'none';
      renderBundles();
    });

    // Populate tag list with checkboxes
    tagList.innerHTML = '';
    filterOptions.tags.forEach((tag) => {
      var tagItem = document.createElement('div');
      tagItem.className = 'tag-item';
      tagItem.dataset.tag = tag;

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'tag-' + tag;
      checkbox.value = tag;

      var label = document.createElement('label');
      label.htmlFor = 'tag-' + tag;
      label.textContent = tag;
      label.style.cursor = 'pointer';
      label.style.flex = '1';

      tagItem.append(checkbox);
      tagItem.append(label);

      // Toggle checkbox on item click
      tagItem.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
        }
        updateSelectedTags();
      });

      tagList.append(tagItem);
    });
  };

  // Update selected tags from checkboxes
  const updateSelectedTags = () => {
    var checkboxes = document.querySelectorAll('#tagList input[type="checkbox"]:checked');
    selectedTags = Array.from(checkboxes).map((cb) => {
      return cb.value;
    });
    updateTagButtonText();
    renderBundles();
  };

  // Update the tag button text based on selection
  const updateTagButtonText = () => {
    var tagSelectorText = document.querySelector('#tagSelectorText');
    if (selectedTags.length === 0) {
      tagSelectorText.textContent = 'All Tags';
    } else if (selectedTags.length === 1) {
      tagSelectorText.textContent = selectedTags[0];
    } else {
      tagSelectorText.textContent = selectedTags.length + ' tags';
    }
  };

  // Toggle tag dropdown
  document.querySelector('#tagSelectorBtn').addEventListener('click', () => {
    var dropdown = document.querySelector('#tagDropdown');
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';

    if (dropdown.style.display === 'block') {
      document.querySelector('#tagSearch').focus();
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    var tagSelector = document.querySelector('.tag-selector');
    var dropdown = document.querySelector('#tagDropdown');

    if (tagSelector && !tagSelector.contains(e.target) && dropdown && dropdown.style.display === 'block') {
      dropdown.style.display = 'none';
    }
  });

  // Tag search functionality
  document.querySelector('#tagSearch').addEventListener('input', (e) => {
    var searchTerm = e.target.value.toLowerCase();
    var tagItems = document.querySelectorAll('.tag-item');

    tagItems.forEach((item) => {
      var tagName = item.dataset.tag.toLowerCase();
      item.classList.toggle('hidden', !tagName.includes(searchTerm));
    });
  });

  // Search functionality
  document.querySelector('#searchBox').addEventListener('input', () => {
    renderBundles();
  });

  // Source selector button click
  document.querySelector('#sourceSelectorBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    var dropdown = document.querySelector('#sourceDropdown');
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';

    if (dropdown.style.display === 'block') {
      document.querySelector('#sourceSearch').focus();
    }
  });

  // Close source dropdown when clicking outside
  document.addEventListener('click', (e) => {
    var sourceSelector = document.querySelector('.source-selector');
    var dropdown = document.querySelector('#sourceDropdown');

    if (sourceSelector && !sourceSelector.contains(e.target) && dropdown && dropdown.style.display === 'block') {
      dropdown.style.display = 'none';
    }
  });

  // Source search functionality
  document.querySelector('#sourceSearch').addEventListener('input', (e) => {
    var searchTerm = e.target.value.toLowerCase();
    var sourceItems = document.querySelectorAll('.source-item');

    sourceItems.forEach((item) => {
      var sourceName = item.dataset.source.toLowerCase();
      item.classList.toggle('hidden', !sourceName.includes(searchTerm));
    });
  });

  // Source item selection
  document.querySelectorAll('.source-item').forEach((item) => {
    item.addEventListener('click', () => {
      // Update selection
      document.querySelectorAll('.source-item').forEach((i) => {
        i.classList.remove('active');
      });
      item.classList.add('active');

      // Update selected source
      selectedSource = item.dataset.source;

      // Update button text
      var label = item.querySelector('label').textContent;
      document.querySelector('#sourceSelectorText').textContent = label;

      // Check radio button
      item.querySelector('input[type="radio"]').checked = true;

      // Close dropdown
      document.querySelector('#sourceDropdown').style.display = 'none';

      // Re-render bundles
      renderBundles();
    });
  });

  // Installed filter checkbox
  document.querySelector('#installedCheckbox').addEventListener('change', (e) => {
    showInstalledOnly = e.target.checked;
    renderBundles();
  });

  // Make the filter div clickable to toggle checkbox
  document.querySelector('#installedFilter').addEventListener('click', (e) => {
    if (e.target.id !== 'installedCheckbox') {
      var checkbox = document.querySelector('#installedCheckbox');
      checkbox.checked = !checkbox.checked;
      showInstalledOnly = checkbox.checked;
      renderBundles();
    }
  });

  // Clear filters button
  document.querySelector('#clearFiltersBtn').addEventListener('click', () => {
    document.querySelector('#searchBox').value = '';
    document.querySelector('#sourceSearch').value = '';
    document.querySelector('#tagSearch').value = '';
    document.querySelector('#installedCheckbox').checked = false;

    // Reset source selector
    selectedSource = 'all';
    document.querySelector('#sourceSelectorText').textContent = 'All Sources';
    document.querySelectorAll('.source-item').forEach((item) => {
      item.classList.remove('active');
      if (item.dataset.source === 'all') {
        item.classList.add('active');
        item.querySelector('input[type="radio"]').checked = true;
      }
    });

    // Uncheck all tag checkboxes
    var checkboxes = document.querySelectorAll('#tagList input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      cb.checked = false;
    });

    // Show all tags
    var tagItems = document.querySelectorAll('.tag-item');
    tagItems.forEach((item) => {
      item.classList.remove('hidden');
    });

    selectedSource = 'all';
    selectedTags = [];
    showInstalledOnly = false;
    updateTagButtonText();
    renderBundles();
  });

  // Refresh button
  document.querySelector('#refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  // Shorten hash-based versions for compact UI labels.
  const formatVersionLabel = (version) => {
    if (!version) {
      return '';
    }
    if (version.startsWith('hash:')) {
      var hash = version.slice('hash:'.length);
      var suffix = hash.slice(-6);
      return 'vhash:' + suffix;
    }
    return 'v' + version;
  };

  const formatUpdateLabel = (installedVersion, latestVersion) => {
    if (!installedVersion) {
      return '';
    }
    return ' (' + formatVersionLabel(installedVersion) + ' -> ' + formatVersionLabel(latestVersion) + ')';
  };

  const renderBundles = () => {
    var marketplace = document.querySelector('#marketplace');
    var searchTerm = document.querySelector('#searchBox').value;

    var filteredBundles = allBundles;

    // Apply source filter
    if (selectedSource && selectedSource !== 'all') {
      filteredBundles = filteredBundles.filter((bundle) => {
        return bundle.sourceId === selectedSource;
      });
    }

    // Apply installed filter
    if (showInstalledOnly) {
      filteredBundles = filteredBundles.filter((bundle) => {
        return bundle.installed === true;
      });
    }

    // Apply tag filter (OR logic - bundle matches if it has ANY of the selected tags)
    if (selectedTags.length > 0) {
      filteredBundles = filteredBundles.filter((bundle) => {
        if (!bundle.tags || bundle.tags.length === 0) {
          return false;
        }
        return bundle.tags.some((bundleTag) => {
          return selectedTags.some((selectedTag) => {
            return bundleTag.toLowerCase() === selectedTag.toLowerCase();
          });
        });
      });
    }

    // Apply search filter
    if (searchTerm && searchTerm.trim() !== '') {
      var term = searchTerm.toLowerCase();
      filteredBundles = filteredBundles.filter((bundle) => {
        return bundle.name.toLowerCase().includes(term)
          || bundle.description.toLowerCase().includes(term)
          || (bundle.tags && bundle.tags.some((tag) => {
            return tag.toLowerCase().includes(term);
          }))
          || (bundle.author && bundle.author.toLowerCase().includes(term));
      });
    }

    if (filteredBundles.length === 0) {
      // Check if we have any bundles at all (before filtering)
      var hasFiltersApplied = searchTerm || selectedSource !== 'all' || selectedTags.length > 0 || showInstalledOnly;

      if (allBundles.length === 0) {
        var hasNoSources = setupState === 'complete' && sourcesCount === 0;
        var shouldShowSetupPrompt = setupState === 'incomplete' || setupState === 'not_started' || setupState === 'in_progress' || hasNoSources;

        var setupMessage = hasNoSources
          ? 'No sources are configured. Complete setup to browse bundles.'
          : 'No hub is configured. Complete setup to browse bundles.';

        marketplace.innerHTML = shouldShowSetupPrompt
          ? '<div class="empty-state">'
          + '<div class="empty-state-icon">⚙️</div>'
          + '<div class="empty-state-title">Setup Not Complete</div>'
          + '<p>' + setupMessage + '</p>'
          + '<button class="primary-button" data-action="completeSetup">'
          + 'Complete Setup'
          + '</button>'
          + '</div>'
          : '<div class="empty-state">'
            + '<div class="spinner"></div>'
            + '<div class="empty-state-title">Syncing sources...</div>'
            + '<p>Bundles will appear as sources are synced</p>'
            + '</div>';
      } else if (hasFiltersApplied) {
        // Has bundles but filters hide them all
        marketplace.innerHTML =
          '<div class="empty-state">'
          + '<div class="empty-state-icon">🔍</div>'
          + '<div class="empty-state-title">No bundles match your filters</div>'
          + '<p>Try adjusting your search or filters</p>'
          + '</div>';
      } else {
        marketplace.innerHTML =
          '<div class="empty-state">'
          + '<div class="empty-state-icon">📦</div>'
          + '<div class="empty-state-title">No bundles found</div>'
          + '<p>Try adjusting your search or filters</p>'
          + '</div>';
      }
      return;
    }

    marketplace.innerHTML = filteredBundles.map((bundle) => {
      return '<div class="bundle-card ' + (bundle.installed ? 'installed' : '') + '" data-bundle-id="' + bundle.id + '" data-action="openDetails">'
        + (bundle.installed && bundle.autoUpdateEnabled ? '<div class="installed-badge">🔄 Auto-Update</div>' : (bundle.installed ? '<div class="installed-badge">✓ Installed</div>' : ''))

        + '<div class="bundle-header">'
        + '<div class="bundle-title">' + bundle.name + '</div>'
        + '<div class="bundle-author">by ' + (bundle.author || 'Unknown') + ' • ' + formatVersionLabel(bundle.version) + '</div>'
        + '</div>'

        + '<div class="bundle-description">'
        + (bundle.description || 'No description available')
        + '</div>'

        + '<div class="content-breakdown">'
        + renderContentItem('💬', 'Prompts', bundle.contentBreakdown ? bundle.contentBreakdown.prompts || 0 : 0)
        + renderContentItem('📋', 'Instructions', bundle.contentBreakdown ? bundle.contentBreakdown.instructions || 0 : 0)
        + renderContentItem('🤖', 'Agents', bundle.contentBreakdown ? bundle.contentBreakdown.agents || 0 : 0)
        + renderContentItem('🛠️', 'Skills', bundle.contentBreakdown ? bundle.contentBreakdown.skills || 0 : 0)
        + renderContentItem('🔌', 'MCP Servers', bundle.contentBreakdown ? bundle.contentBreakdown.mcpServers || 0 : 0)
        + '</div>'

        + '<div class="bundle-tags">'
        + (bundle.tags || []).slice(0, 4).map((tag) => {
          return '<span class="tag">' + tag + '</span>';
        }).join('')
        + '</div>'

        + '<div class="bundle-actions" data-stop-propagation="true">'
        + renderBundleButtons(bundle)
        + '<button class="btn btn-secondary" data-action="openDetails" data-bundle-id="' + bundle.id + '">Details</button>'
        + '<button class="btn btn-link" data-action="openSourceRepo" data-bundle-id="' + bundle.id + '" title="Open Source Repository">'
        + '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">'
        + '<path d="M4.5 3A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-2a.5.5 0 0 1 1 0v2'
        + 'a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-7A2.5 2.5 0 0 1 4.5 2h2a.5.5 0 0 1 0 1h-2z'
        + 'M9 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V3.707l-5.146 5.147a.5.5 0 0 1-.708-.708L12.293 3H9.5a.5.5 0 0 1-.5-.5z"/>'
        + '</svg>'
        + '</button>'
        + '</div>'
        + '</div>';
    }).join('');
  };

  const renderBundleButtons = (bundle) => {
    if (bundle.buttonState === 'update') {
      if (bundle.availableVersions && bundle.availableVersions.length > 1) {
        return '<div class="version-selector-group">'
          + '<button class="btn btn-primary" data-action="updateBundle" data-bundle-id="'
          + bundle.id + '">Update'
          + (bundle.installedVersion ? formatUpdateLabel(bundle.installedVersion, bundle.version) : '') + '</button>'
          + '<button class="version-selector-arrow" data-action="toggleVersionDropdown" data-dropdown-id="'
          + bundle.id + '-update">▾</button>'
          + '<div class="version-dropdown" id="version-dropdown-' + bundle.id + '-update">'
          + '<div class="version-item uninstall" data-action="uninstallBundle" data-bundle-id="' + bundle.id + '">'
          + '<span>Uninstall</span>'
          + '</div>'
          + '<div class="version-dropdown-header">Switch Version</div>'
          + (bundle.availableVersions || []).map((versionObj, index) => {
            return '<div class="version-item '
              + (versionObj.version === bundle.installedVersion ? 'current' : '')
              + '" data-action="installBundleVersion" data-bundle-id="' + bundle.id
              + '" data-version="' + versionObj.version + '">'
              + '<span>v' + versionObj.version + '</span>'
              + (versionObj.version === bundle.installedVersion
                ? '<span class="version-badge">Current</span>'
                : (index === 0 ? '<span class="version-badge latest">Latest</span>' : ''))
              + '</div>';
          }).join('')
          + '</div>'
          + '</div>';
      }
      return '<button class="btn btn-primary" data-action="updateBundle" data-bundle-id="'
        + bundle.id + '">Update'
        + (bundle.installedVersion ? formatUpdateLabel(bundle.installedVersion, bundle.version) : '')
        + '</button>';
    }

    if (bundle.buttonState === 'uninstall') {
      if (bundle.availableVersions && bundle.availableVersions.length > 1) {
        return '<div class="version-selector-group">'
          + '<button class="btn btn-danger" data-action="uninstallBundle" data-bundle-id="'
          + bundle.id + '">Uninstall</button>'
          + '<button class="version-selector-arrow danger" data-action="toggleVersionDropdown" data-dropdown-id="'
          + bundle.id + '-installed">▾</button>'
          + '<div class="version-dropdown" id="version-dropdown-' + bundle.id + '-installed">'
          + '<div class="version-item uninstall" data-action="uninstallBundle" data-bundle-id="' + bundle.id + '">'
          + '<span>Uninstall</span>'
          + '</div>'
          + '<div class="version-dropdown-header">Switch Version</div>'
          + (bundle.availableVersions || []).map((versionObj, index) => {
            return '<div class="version-item '
              + (versionObj.version === bundle.installedVersion ? 'current' : '')
              + '" data-action="installBundleVersion" data-bundle-id="' + bundle.id
              + '" data-version="' + versionObj.version + '">'
              + '<span>v' + versionObj.version + '</span>'
              + (versionObj.version === bundle.installedVersion
                ? '<span class="version-badge">Current</span>'
                : (index === 0 ? '<span class="version-badge latest">Latest</span>' : ''))
              + '</div>';
          }).join('')
          + '</div>'
          + '</div>';
      }
      return '<button class="btn btn-danger" data-action="uninstallBundle" data-bundle-id="' + bundle.id + '">Uninstall</button>';
    }

    // Default: install
    if (bundle.availableVersions && bundle.availableVersions.length > 1) {
      return '<div class="version-selector-group">'
        + '<button class="btn btn-primary" data-action="installBundle" data-bundle-id="' + bundle.id + '">Install</button>'
        + '<button class="version-selector-arrow" data-action="toggleVersionDropdown" data-dropdown-id="' + bundle.id + '">▾</button>'
        + '<div class="version-dropdown" id="version-dropdown-' + bundle.id + '">'
        + '<div class="version-dropdown-header">Select Version</div>'
        + (bundle.availableVersions || []).map((versionObj, index) => {
          return '<div class="version-item" data-action="installBundleVersion" data-bundle-id="' + bundle.id + '" data-version="' + versionObj.version + '">'
            + '<span>v' + versionObj.version + '</span>'
            + (index === 0 ? '<span class="version-badge latest">Latest</span>' : '')
            + '</div>';
        }).join('')
        + '</div>'
        + '</div>';
    }
    return '<button class="btn btn-primary" data-action="installBundle" data-bundle-id="' + bundle.id + '">Install</button>';
  };

  const renderContentItem = (icon, label, count) => {
    if (count === 0) {
      return '';
    }
    return '<div class="content-item">'
      + '<span class="content-icon">' + icon + '</span>'
      + '<span class="content-count">' + count + '</span>'
      + '<span>' + label + '</span>'
      + '</div>';
  };

  const installBundle = (bundleId) => {
    vscode.postMessage({ type: 'install', bundleId: bundleId });
  };

  const updateBundle = (bundleId) => {
    vscode.postMessage({ type: 'update', bundleId: bundleId });
  };

  const uninstallBundle = (bundleId) => {
    vscode.postMessage({ type: 'uninstall', bundleId: bundleId });
  };

  const openDetails = (bundleId) => {
    vscode.postMessage({ type: 'openDetails', bundleId: bundleId });
  };

  const openSourceRepo = (bundleId) => {
    vscode.postMessage({ type: 'openSourceRepository', bundleId: bundleId });
  };

  const completeSetup = () => {
    vscode.postMessage({ type: 'completeSetup' });
  };

  const toggleVersionDropdown = (dropdownId) => {
    var dropdown = document.querySelector('#' + CSS.escape('version-dropdown-' + dropdownId));
    if (!dropdown) {
      return;
    }

    // Close all other dropdowns
    document.querySelectorAll('.version-dropdown').forEach((d) => {
      if (d.id !== 'version-dropdown-' + dropdownId) {
        d.classList.remove('show');
      }
    });

    // Toggle this dropdown
    dropdown.classList.toggle('show');
  };

  const installBundleVersion = (bundleId, version) => {
    // Close dropdown
    document.querySelectorAll('.version-dropdown').forEach((d) => {
      d.classList.remove('show');
    });

    vscode.postMessage({
      type: 'installVersion',
      bundleId: bundleId,
      version: version
    });
  };

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.version-selector-group')) {
      document.querySelectorAll('.version-dropdown').forEach((d) => {
        d.classList.remove('show');
      });
    }
  });

  // Event delegation for all click handlers (CSP compliant)
  document.addEventListener('click', (e) => {
    var target = e.target;

    // Handle bundle-actions stop propagation
    if (target.closest('[data-stop-propagation]')) {
      e.stopPropagation();
    }

    // Handle data-action attributes
    var actionElement = target.closest('[data-action]');
    if (actionElement) {
      var action = actionElement.dataset.action;
      var bundleId = actionElement.dataset.bundleId || (actionElement.closest('[data-bundle-id]') ? actionElement.closest('[data-bundle-id]').dataset.bundleId : null);
      var version = actionElement.dataset.version;
      var dropdownId = actionElement.dataset.dropdownId;

      switch (action) {
        case 'openDetails': {
          if (bundleId) {
            openDetails(bundleId);
          }
          break;
        }
        case 'installBundle': {
          if (bundleId) {
            e.stopPropagation();
            installBundle(bundleId);
          }
          break;
        }
        case 'installBundleVersion': {
          if (bundleId && version) {
            e.stopPropagation();
            installBundleVersion(bundleId, version);
          }
          break;
        }
        case 'updateBundle': {
          if (bundleId) {
            e.stopPropagation();
            updateBundle(bundleId);
          }
          break;
        }
        case 'uninstallBundle': {
          if (bundleId) {
            e.stopPropagation();
            uninstallBundle(bundleId);
          }
          break;
        }
        case 'openSourceRepo': {
          if (bundleId) {
            e.stopPropagation();
            openSourceRepo(bundleId);
          }
          break;
        }
        case 'toggleVersionDropdown': {
          if (dropdownId) {
            e.stopPropagation();
            toggleVersionDropdown(dropdownId);
          }
          break;
        }
        case 'completeSetup': {
          e.stopPropagation();
          completeSetup();
          break;
        }
      }
    }
  });
})();
