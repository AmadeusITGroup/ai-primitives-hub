// Marketplace View JavaScript
// Uses IIFE pattern for encapsulation and CSP compliance

(() => {
  const vscode = acquireVsCodeApi();
  let allBundles = [];
  let filterOptions = { tags: [], sources: [], environments: [] };
  let selectedSource = 'all';
  let selectedTags = [];
  let selectedContentTypes = [];
  let sortBy = 'relevance';
  // Natural default direction per field: best/newest first, names A→Z.
  const SORT_DEFAULT_DIRECTION = { relevance: 'desc', name: 'asc', recent: 'desc' };
  let sortDirection = SORT_DEFAULT_DIRECTION[sortBy];
  // Tracks whether the search box currently holds a query. Used to detect the
  // empty→typing transition so entering a search switches ordering to relevance
  // ("best match"), the way every marketplace search does — otherwise a lingering
  // "Recently updated"/"Name" sort re-orders the ranked hits and buries the most
  // relevant bundles under unrelated recent ones.
  let searchModeActive = false;
  let indexedBundleKeys = null;
  let indexedSearchQuery = null;
  // True from the moment a query is typed until its semantic results arrive.
  // While pending we show a "Searching…" state instead of flashing literal
  // keyword matches, so the final view is always the index's hybrid ranking.
  let semanticSearchPending = false;
  let searchRequestTimer;
  let selectedTab = 'for-you';
  let openVersionDropdownId = null;
  let setupState = 'complete'; // Default to complete to avoid showing setup prompt unnecessarily
  let sourcesCount = 0;

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'bundlesLoaded') {
      allBundles = message.bundles;
      filterOptions = message.filterOptions || { tags: [], sources: [], environments: [] };
      setupState = message.setupState || 'complete';
      sourcesCount = message.sourcesCount || 0;
      updateFilterUI();
      updateMarketplaceSummary();
      renderBundles();
    }
    if (message.type === 'primitiveSearchResults') {
      var currentQuery = document.querySelector('#searchBox').value;
      if (message.query === currentQuery) {
        semanticSearchPending = false;
        indexedBundleKeys = message.bundleKeys;
        indexedSearchQuery = message.bundleKeys === null ? null : currentQuery;
        updateMarketplaceSummary();
        renderBundles();
      }
    }
  });

  // Signal readiness only after the message listener is installed. The extension
  // retains the latest marketplace payload until this handshake completes.
  vscode.postMessage({ type: 'ready' });

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
        document.querySelector('#sourceSelectorText').textContent = source.name;
        sourceItem.querySelector('input[type="radio"]').checked = true;
        document.querySelector('#sourceDropdown').style.display = 'none';
        updateMarketplaceSummary();
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
      document.querySelector('#sourceSelectorText').textContent = 'Sources';
      allItem.querySelector('input[type="radio"]').checked = true;
      document.querySelector('#sourceDropdown').style.display = 'none';
      updateMarketplaceSummary();
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

    // Populate content type selector
    var contentTypeList = document.querySelector('#contentTypeList');
    var contentTypes = [
      { id: 'agents', label: 'Agents', icon: 'fa-robot' },
      { id: 'skills', label: 'Skills', icon: 'fa-puzzle-piece' },
      { id: 'prompts', label: 'Prompts', icon: 'fa-file-lines' },
      { id: 'mcpServers', label: 'MCP Servers', icon: 'fa-plug' },
      { id: 'instructions', label: 'Instructions', icon: 'fa-list-check' }
    ];

    contentTypeList.innerHTML = '';

    // Add "Select All" option at the top
    var selectAllItem = document.createElement('div');
    selectAllItem.className = 'content-type-item content-type-select-all';

    var selectAllCheckbox = document.createElement('input');
    selectAllCheckbox.type = 'checkbox';
    selectAllCheckbox.id = 'contentType-selectAll';
    selectAllCheckbox.checked = selectedContentTypes.length === 0 || selectedContentTypes.length === contentTypes.length;

    var selectAllLabel = document.createElement('label');
    selectAllLabel.htmlFor = 'contentType-selectAll';
    selectAllLabel.textContent = 'Select All';
    selectAllLabel.style.cursor = 'pointer';
    selectAllLabel.style.flex = '1';
    selectAllLabel.style.fontWeight = '500';

    selectAllItem.append(selectAllCheckbox);
    selectAllItem.append(selectAllLabel);

    selectAllItem.addEventListener('click', (e) => {
      if (e.target !== selectAllCheckbox) {
        selectAllCheckbox.checked = !selectAllCheckbox.checked;
      }
      var allCheckboxes = document.querySelectorAll('#contentTypeList input[type="checkbox"]:not(#contentType-selectAll)');
      allCheckboxes.forEach((cb) => {
        cb.checked = selectAllCheckbox.checked;
      });
      updateSelectedContentTypes();
    });

    contentTypeList.append(selectAllItem);

    contentTypes.forEach((ct) => {
      var item = document.createElement('div');
      item.className = 'content-type-item';
      item.dataset.contentType = ct.id;

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'contentType-' + ct.id;
      checkbox.value = ct.id;
      checkbox.checked = selectedContentTypes.includes(ct.id);

      var label = document.createElement('label');
      label.htmlFor = 'contentType-' + ct.id;
      label.innerHTML = '<span class="fa-icon ' + ct.icon + '" aria-hidden="true"></span> ' + ct.label;
      label.style.cursor = 'pointer';
      label.style.flex = '1';

      item.append(checkbox);
      item.append(label);

      item.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
        }
        // Update "Select All" checkbox state
        var allCheckboxes = document.querySelectorAll('#contentTypeList input[type="checkbox"]:not(#contentType-selectAll)');
        var allChecked = Array.from(allCheckboxes).every((cb) => cb.checked);
        document.querySelector('#contentType-selectAll').checked = allChecked;
        updateSelectedContentTypes();
      });

      contentTypeList.append(item);
    });
  };

  // Update selected tags from checkboxes
  const updateSelectedTags = () => {
    var checkboxes = document.querySelectorAll('#tagList input[type="checkbox"]:checked');
    selectedTags = Array.from(checkboxes).map((cb) => {
      return cb.value;
    });
    updateTagButtonText();
    updateMarketplaceSummary();
    renderBundles();
  };

  // Update the tag button text based on selection
  const updateTagButtonText = () => {
    var tagSelectorText = document.querySelector('#tagSelectorText');
    if (selectedTags.length === 0) {
      tagSelectorText.textContent = 'Tags';
    } else if (selectedTags.length === 1) {
      tagSelectorText.textContent = selectedTags[0];
    } else {
      tagSelectorText.textContent = selectedTags.length + ' tags';
    }
  };

  // Update selected content types from checkboxes
  const updateSelectedContentTypes = () => {
    var allCheckboxes = document.querySelectorAll('#contentTypeList input[type="checkbox"]:not(#contentType-selectAll)');
    var checkedBoxes = Array.from(allCheckboxes).filter((cb) => cb.checked);
    // When all types are selected (or none are selected), treat as no filter so all bundles are shown
    if (checkedBoxes.length === 0 || checkedBoxes.length === allCheckboxes.length) {
      selectedContentTypes = [];
      document.querySelector('#contentType-selectAll').checked = true;
    } else {
      selectedContentTypes = checkedBoxes.map((cb) => cb.value);
    }
    updateContentTypeButtonText();
    updateMarketplaceSummary();
    renderBundles();
  };

  // Keep the compact tab and active-filter strip in sync with the current state.
  const clearFilter = (filter, value) => {
    switch (filter) {
      case 'search': {
        document.querySelector('#searchBox').value = '';
        updateSearchClearButton();

        break;
      }
      case 'source': {
        selectedSource = 'all';
        document.querySelector('#sourceSelectorText').textContent = 'Sources';

        break;
      }
      case 'tag': {
        selectedTags = selectedTags.filter((tag) => tag !== value);

        break;
      }
      case 'content': {
        selectedContentTypes = selectedContentTypes.filter((type) => type !== value);

        break;
      }
      // No default
    }
    updateFilterUI();
    updateContentTypeButtonText();
    updateMarketplaceSummary();
    renderBundles();
  };

  // Match bundles against the current search and return them in relevance order
  // as { bundle, rank } (rank 0 = best). When the extension has semantic results
  // for this exact query, lead with the index's hybrid ranking (the same the CLI
  // shows) and honour explicit exclusion tokens (e.g. "-deprecated"). We then
  // union back any *strong* literal matches — bundles whose query terms appear
  // in their id/name/tags — that the semantic relevance floor dropped, ranked
  // just below the semantic hits. The floor exists to cut semantic *noise*
  // (a query flooding to dozens of loosely-related bundles); it must never
  // eliminate a bundle literally named/tagged for the query (e.g. a second
  // "renovate" bundle). Weak, description-only matches stay subject to the floor.
  // Fall back to literal keyword matching only when the index did not respond
  // (unavailable/errored), so results still appear.
  const applySearch = (bundles, searchTerm) => {
    if (!searchTerm || searchTerm.trim() === '') {
      return bundles.map((bundle, index) => ({ bundle: bundle, rank: index }));
    }
    if (indexedSearchQuery === searchTerm && Array.isArray(indexedBundleKeys)) {
      var SEP = String.fromCharCode(0);
      var tokens = parseSearchTokens(searchTerm);
      var rankByKey = new Map();
      for (const [i, indexedBundleKey] of indexedBundleKeys.entries()) {
        if (!rankByKey.has(indexedBundleKey)) {
          rankByKey.set(indexedBundleKey, i);
        }
      }
      var matched = [];
      var strongExtras = [];
      bundles.forEach((bundle) => {
        var fields = getSearchFields(bundle);
        if (tokens.some((token) => token.excluded && tokenMatches(fields, token))) {
          return;
        }
        var rank = rankByKey.get(bundle.sourceId + SEP + bundle.id);
        if (rank !== undefined) {
          // Keep the semantic rank as the within-tier order, and flag whether
          // this hit is also a strong literal match (every query term in its
          // id/name/tags) so it can be promoted above loosely-related hits.
          matched.push({ bundle: bundle, semanticRank: rank, strong: hasStrongKeywordMatch(fields, tokens) });
          return;
        }
        // Not in the semantic set. Rescue it only if it is an unambiguous
        // literal match the floor discarded.
        if (hasStrongKeywordMatch(fields, tokens)) {
          strongExtras.push({ bundle: bundle, score: scoreSearchMatch(fields, tokens) });
        }
      });
      // Promote strong literal matches to the top of the semantic set. The
      // index's hybrid score can rank a paraphrase above a bundle literally
      // named/tagged for the query; for the user that reads as "the most
      // relevant result is not at the top". Tiering strong matches first — while
      // preserving the index's semantic order *within* each tier — puts the
      // bundle actually named for the query where it belongs without discarding
      // the hybrid ranking. This is a stable, deterministic re-order (both keys
      // are total orders), so there is no jitter between renders.
      matched.sort((a, b) => {
        if (a.strong !== b.strong) {
          return a.strong ? -1 : 1;
        }
        return a.semanticRank - b.semanticRank;
      });
      var ordered = matched.map((entry, i) => ({ bundle: entry.bundle, rank: i }));
      // Append rescued literal matches after every semantic hit, best keyword
      // score first. Basing the offset on the ordered length keeps them strictly
      // below the semantic hits.
      var extrasBase = ordered.length;
      strongExtras.sort((a, b) => b.score - a.score);
      strongExtras.forEach((entry, i) => {
        ordered.push({ bundle: entry.bundle, rank: extrasBase + i });
      });
      return ordered;
    }
    // Deterministic keyword fallback: rank by the local relevance score (highest
    // first) so the instant results — shown before semantic hits arrive — lead
    // with the strongest matches. Ties keep the catalog's original order for a
    // stable, non-jittery list. Once semantic results land, the branch above
    // takes over and these ranks are replaced by the index's hybrid ranking.
    var scored = searchBundles(bundles, searchTerm);
    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return scored.map((entry, index) => ({ bundle: entry.bundle, rank: index }));
  };

  const getFilteredBundles = () => {
    var searchTerm = document.querySelector('#searchBox')?.value || '';
    var filteredBundles = applyBaseFilters(allBundles);

    if (searchTerm.trim() !== '') {
      filteredBundles = applySearch(filteredBundles, searchTerm).map((entry) => entry.bundle);
    }
    return filteredBundles;
  };

  // Sync the Sort control's state. The selection (field + direction) is shown
  // as a "Sort: <field> <arrow>" label beside the bundle count, and the active
  // option in the menu carries the same direction arrow (click it again to
  // flip ascending/descending).
  const SORT_LABELS = { relevance: 'Relevance', name: 'Name', recent: 'Recently updated' };
  const directionArrow = (direction) => (direction === 'asc' ? '↑' : '↓');
  const updateSortControls = () => {
    // Relevance is not reversible, so it shows no direction arrow; Name and
    // Recently updated show ↑/↓ for their current direction.
    var summaryEl = document.querySelector('#sortSummary');
    if (summaryEl) {
      var label = SORT_LABELS[sortBy] || SORT_LABELS.relevance;
      var summaryArrow = sortBy === 'relevance' ? '' : ' ' + directionArrow(sortDirection);
      summaryEl.textContent = 'Sort: ' + label + summaryArrow;
    }
    document.querySelectorAll('.sort-option').forEach((option) => {
      var active = option.dataset.sort === sortBy;
      option.setAttribute('aria-checked', String(active));
      var dirEl = option.querySelector('.sort-dir');
      if (dirEl) {
        dirEl.textContent = (active && option.dataset.sort !== 'relevance') ? directionArrow(sortDirection) : '';
      }
    });
  };

  const updateMarketplaceSummary = () => {
    var chips = document.querySelector('#filterChips');
    var searchValue = document.querySelector('#searchBox')?.value.trim();
    // Refresh filter chips and tab counts. Bundle counts are shown only in the
    // marketplace tabs, not in the active-filters bar.
    updateSortControls();
    if (chips) {
      var activeFilters = [];
      if (searchValue) {
        activeFilters.push({ filter: 'search', label: 'Search: ' + searchValue });
      }
      if (selectedSource !== 'all') {
        activeFilters.push({ filter: 'source', label: 'Source: ' + document.querySelector('#sourceSelectorText').textContent });
      }
      selectedTags.forEach((tag) => activeFilters.push({ filter: 'tag', value: tag, label: 'Tag: ' + tag }));
      selectedContentTypes.forEach((type) => activeFilters.push({ filter: 'content', value: type, label: 'Content: ' + type }));
      chips.innerHTML = activeFilters.map((activeFilter) => '<span class="filter-chip">'
        + '<span class="filter-chip-label">' + activeFilter.label + '</span>'
        + '<button class="filter-chip-remove" type="button" data-filter="' + activeFilter.filter
        + '" data-value="' + (activeFilter.value || '') + '" aria-label="Remove ' + activeFilter.label + '">×</button>'
        + '</span>').join('');
      chips.querySelectorAll('.filter-chip-remove').forEach((button) => {
        button.addEventListener('click', () => clearFilter(button.dataset.filter, button.dataset.value));
      });
    }

    var filteredBundles = getFilteredBundles();
    var updatesCount = document.querySelector('#updatesCount');
    if (updatesCount) {
      updatesCount.textContent = filteredBundles.filter((bundle) => bundle.buttonState === 'update').length;
    }

    var installedCount = document.querySelector('#installedCount');
    if (installedCount) {
      installedCount.textContent = filteredBundles.filter((bundle) => bundle.installed === true).length;
    }

    var forYouCount = document.querySelector('#forYouCount');
    if (forYouCount) {
      forYouCount.textContent = filteredBundles.length;
    }
  };

  // Update the content type button text based on selection
  const updateContentTypeButtonText = () => {
    var text = document.querySelector('#contentTypeSelectorText');
    if (selectedContentTypes.length === 0) {
      text.textContent = 'Primitives';
    } else if (selectedContentTypes.length === 1) {
      var labels = { agents: 'Agents', skills: 'Skills', prompts: 'Prompts', mcpServers: 'MCP Servers', instructions: 'Instructions' };
      text.textContent = labels[selectedContentTypes[0]] || selectedContentTypes[0];
    } else {
      text.textContent = selectedContentTypes.length + ' types';
    }
  };

  // Toggle tag dropdown
  document.querySelector('#tagSelectorBtn').addEventListener('click', (e) => {
    e.stopPropagation();
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

  // Content type selector button click
  document.querySelector('#contentTypeSelectorBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    var dropdown = document.querySelector('#contentTypeDropdown');
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });

  // Close content type dropdown when clicking outside
  document.addEventListener('click', (e) => {
    var contentTypeSelector = document.querySelector('.content-type-selector');
    var dropdown = document.querySelector('#contentTypeDropdown');

    if (contentTypeSelector && !contentTypeSelector.contains(e.target) && dropdown && dropdown.style.display === 'block') {
      dropdown.style.display = 'none';
    }
  });

  // Show the clear (×) button only while the search box holds text.
  const updateSearchClearButton = () => {
    var clearBtn = document.querySelector('#searchClearBtn');
    if (clearBtn) {
      clearBtn.hidden = document.querySelector('#searchBox').value === '';
    }
  };

  // Search functionality
  document.querySelector('#searchBox').addEventListener('input', (event) => {
    var query = event.target.value;
    updateSearchClearButton();
    indexedBundleKeys = null;
    indexedSearchQuery = null;
    clearTimeout(searchRequestTimer);

    // Entering a search (empty → typing) switches ordering to relevance so the
    // ranked hits lead. A prior "Recently updated"/"Name" selection otherwise
    // persists into the search and buries the best matches. Only resets on the
    // transition, so the user can still re-sort results afterwards.
    var isSearching = query.trim() !== '';
    if (isSearching && !searchModeActive && sortBy !== 'relevance') {
      sortBy = 'relevance';
      sortDirection = SORT_DEFAULT_DIRECTION[sortBy];
      updateSortControls();
    }
    searchModeActive = isSearching;

    // Structured (advanced-operator) and empty queries are handled entirely by
    // the keyword engine — no semantic request is issued, so field filters and
    // quoted phrases keep working exactly as typed.
    if (query.trim() === '' || hasAdvancedOperators(query)) {
      semanticSearchPending = false;
      updateMarketplaceSummary();
      renderBundles();
      return;
    }

    // Free-text query: wait for the index's hybrid results before rendering.
    semanticSearchPending = true;
    updateMarketplaceSummary();
    renderBundles();
    searchRequestTimer = setTimeout(() => {
      vscode.postMessage({ type: 'search', query: query });
    }, 250);
  });

  // Clear (×) button inside the search box: empty the query and re-run the
  // input handler so the results and all search state reset consistently.
  document.querySelector('#searchClearBtn').addEventListener('click', () => {
    var searchBox = document.querySelector('#searchBox');
    searchBox.value = '';
    searchBox.dispatchEvent(new Event('input', { bubbles: true }));
    searchBox.focus();
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
      updateMarketplaceSummary();
      renderBundles();
    });
  });

  // Reset filters from the compact active-filter strip.
  const resetFilters = () => {
    document.querySelector('#searchBox').value = '';
    updateSearchClearButton();
    document.querySelector('#sourceSearch').value = '';
    document.querySelector('#tagSearch').value = '';

    // Reset source selector
    selectedSource = 'all';
    document.querySelector('#sourceSelectorText').textContent = 'Sources';
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

    // Reset content type selector
    selectedContentTypes = [];
    document.querySelector('#contentTypeSelectorText').textContent = 'Primitives';
    var contentTypeCheckboxes = document.querySelectorAll('#contentTypeList input[type="checkbox"]');
    contentTypeCheckboxes.forEach((cb) => {
      cb.checked = true;
    });

    // Reset Sort back to Relevance (default direction) and close its popover
    sortBy = 'relevance';
    sortDirection = SORT_DEFAULT_DIRECTION[sortBy];
    closeSortPopover();

    selectedSource = 'all';
    selectedTags = [];
    selectedTab = 'for-you';
    document.querySelectorAll('.marketplace-tab').forEach((item) => item.classList.toggle('active', item.dataset.tab === selectedTab));
    updateTagButtonText();
    updateMarketplaceSummary();
    renderBundles();
  };

  document.querySelector('#clearActiveFilters').addEventListener('click', () => {
    resetFilters();
  });

  // Sort popover (opened from the Sort button in the active-filters bar)
  const closeSortPopover = () => {
    var popover = document.querySelector('#sortPopover');
    var toggle = document.querySelector('#sortToggleBtn');
    if (popover) {
      popover.style.display = 'none';
    }
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
    }
  };

  document.querySelector('#sortToggleBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    var popover = document.querySelector('#sortPopover');
    var isOpen = popover.style.display !== 'none';
    popover.style.display = isOpen ? 'none' : 'block';
    e.currentTarget.setAttribute('aria-expanded', String(!isOpen));
  });

  // Close the sort popover on outside click or Escape.
  document.addEventListener('click', (e) => {
    var wrap = document.querySelector('.sort-control-wrap');
    var popover = document.querySelector('#sortPopover');
    if (wrap && !wrap.contains(e.target) && popover && popover.style.display === 'block') {
      closeSortPopover();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSortPopover();
    }
  });

  document.querySelectorAll('.sort-option').forEach((option) => {
    option.addEventListener('click', () => {
      if (option.disabled) {
        return;
      }
      var nextSort = option.dataset.sort;
      if (nextSort === sortBy) {
        // Re-selecting the active field flips ascending ⇄ descending — except
        // Relevance, which is always best-first (an ascending "least relevant
        // first" order is meaningless and only confuses the results).
        if (nextSort !== 'relevance') {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        }
      } else {
        sortBy = nextSort;
        sortDirection = SORT_DEFAULT_DIRECTION[sortBy] || 'desc';
      }
      closeSortPopover();
      updateMarketplaceSummary();
      renderBundles();
    });
  });

  // Search-tips popover: click the (?) button to pin the tooltip open (it also
  // still opens on hover/focus via CSS); click outside or press Escape to close.
  const searchHelpBtn = document.querySelector('#searchHelpBtn');
  const searchHelpTip = document.querySelector('#search-help');
  const closeSearchHelp = () => {
    if (searchHelpTip) {
      searchHelpTip.classList.remove('is-open');
    }
    if (searchHelpBtn) {
      searchHelpBtn.setAttribute('aria-expanded', 'false');
    }
  };
  if (searchHelpBtn && searchHelpTip) {
    searchHelpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      var isOpen = searchHelpTip.classList.toggle('is-open');
      searchHelpBtn.setAttribute('aria-expanded', String(isOpen));
    });
    document.addEventListener('click', (e) => {
      if (!searchHelpBtn.contains(e.target) && !searchHelpTip.contains(e.target)) {
        closeSearchHelp();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSearchHelp();
      }
    });
  }

  document.querySelectorAll('.marketplace-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      selectedTab = tab.dataset.tab;
      document.querySelectorAll('.marketplace-tab').forEach((item) => item.classList.remove('active'));
      tab.classList.add('active');
      renderBundles();
    });
  });

  document.querySelectorAll('.category-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.category-pill').forEach((item) => item.classList.remove('active'));
      pill.classList.add('active');
      document.querySelector('#searchBox').value = pill.textContent === 'All' ? '' : pill.textContent.replace('⌄', '').trim();
      updateSearchClearButton();
      updateMarketplaceSummary();
      renderBundles();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      event.preventDefault();
      document.querySelector('#searchBox').focus();
    }
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

  // Compact search syntax shared with the extension host (see filter-utils.ts).
  // Words combine with AND, quotes preserve phrases, a leading minus excludes a
  // term, and field prefixes (tag:, author:, env:, source:, name:, id:) scope it.
  const normalizeSearchValue = (value) => {
    return String(value || '')
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim();
  };

  const parseSearchTokens = (searchText) => {
    var tokens = [];
    // `\s*` after the field colon tolerates the common `tag: value` habit
    // (space after the colon), so the field filter still applies instead of the
    // query silently degrading to a free-text semantic search.
    var pattern = /(-)?(?:(id|name|description|tag|author|env|source|platform):\s*)?(?:"([^"]+)"|(\S+))/giu;
    var match;
    while ((match = pattern.exec(searchText)) !== null) {
      var value = normalizeSearchValue(match[3] || match[4]);
      if (value) {
        // match[3] is the content inside quotes — flag it so a quoted term is
        // treated as an exact literal even when it is a single word (e.g.
        // `"security"`), which has no space to detect it by.
        tokens.push({ excluded: match[1] === '-', field: match[2], value: value, quoted: Boolean(match[3]) });
      }
    }
    return tokens;
  };

  // A query is "advanced" when it uses structured operators the semantic index
  // cannot interpret: field filters (tag:, author:, env:, source:, name:, id:),
  // quoted phrases, or -exclusions. Such queries are matched literally by the
  // keyword engine and must bypass semantic search entirely — otherwise the
  // embedding lookup treats e.g. `tag:security` as free text and the field
  // filter silently stops working.
  const hasAdvancedOperators = (searchText) => {
    return parseSearchTokens(searchText).some((token) =>
      Boolean(token.field) || token.excluded || token.quoted || token.value.includes(' ')
    );
  };

  const getSearchFields = (bundle) => {
    return {
      id: [normalizeSearchValue(bundle.id)],
      name: [normalizeSearchValue(bundle.name)],
      description: [normalizeSearchValue(bundle.description)],
      tag: (bundle.tags || []).map((tag) => normalizeSearchValue(tag)),
      author: [normalizeSearchValue(bundle.author)],
      env: (bundle.environments || []).map((environment) => normalizeSearchValue(environment)),
      source: [normalizeSearchValue(bundle.sourceId)]
    };
  };

  const tokenMatches = (fields, token) => {
    var fieldName = token.field;
    // Support 'platform' as alias for 'env'
    if (fieldName === 'platform') {
      fieldName = 'env';
    }
    var values = fieldName ? fields[fieldName] : Object.values(fields).flat();
    return values.some((value) => value.includes(token.value));
  };

  // A "strong" literal match has every query term present in the bundle's id,
  // name, or tags — not merely its description. These are unambiguous keyword
  // hits (a bundle literally named/tagged for the query), so they are unioned
  // back in when the semantic relevance floor drops them (see applySearch);
  // description-only matches are deliberately excluded to avoid re-flooding on
  // common words.
  const STRONG_MATCH_FIELDS = ['id', 'name', 'tag'];
  const hasStrongKeywordMatch = (fields, tokens) => {
    var required = tokens.filter((token) => !token.excluded);
    if (required.length === 0) {
      return false;
    }
    return required.every((token) =>
      STRONG_MATCH_FIELDS.some((field) => fields[field].some((value) => value.includes(token.value)))
    );
  };

  // Relevance tiers mirror scoreBundle() in filter-utils.ts — keep in sync.
  const scoreSearchMatch = (fields, tokens) => {
    let score = 0;
    for (const token of tokens) {
      if (token.excluded) {
        continue;
      }
      if (fields.id.includes(token.value)) {
        score += 120;
      } else if (fields.name.includes(token.value)) {
        score += 100;
      } else if (fields.name.some((value) => value.startsWith(token.value))) {
        score += 70;
      } else if (fields.tag.includes(token.value)) {
        score += 50;
      } else if (fields.env.includes(token.value)) {
        score += 40;
      } else if (fields.author.includes(token.value)) {
        score += 35;
      } else if (fields.name.some((value) => value.includes(token.value))) {
        score += 30;
      } else if (fields.id.some((value) => value.includes(token.value))) {
        score += 28;
      } else if (fields.tag.some((value) => value.includes(token.value))) {
        score += 26;
      } else if (fields.source.includes(token.value)) {
        score += 25;
      } else if (fields.env.some((value) => value.includes(token.value))) {
        score += 24;
      } else if (fields.author.some((value) => value.includes(token.value))) {
        score += 22;
      } else if (fields.source.some((value) => value.includes(token.value))) {
        score += 18;
      } else if (fields.description.some((value) => value.includes(token.value))) {
        score += 8;
      } else {
        score += 2;
      }
    }
    return score;
  };

  // Filter + relevance-rank a set of bundles using the local search syntax.
  // Returns an array of { bundle, score, index } entries (unsorted).
  const searchBundles = (bundles, searchText) => {
    var tokens = parseSearchTokens(searchText);
    if (tokens.length === 0) {
      return bundles.map((bundle, index) => ({ bundle: bundle, score: 0, index: index }));
    }
    return bundles.map((bundle, index) => {
      return { bundle: bundle, fields: getSearchFields(bundle), index: index };
    }).filter((entry) => {
      return tokens.every((token) => token.excluded
        ? !tokenMatches(entry.fields, token)
        : tokenMatches(entry.fields, token));
    }).map((entry) => {
      return { bundle: entry.bundle, score: scoreSearchMatch(entry.fields, tokens), index: entry.index };
    });
  };

  // Apply source/installed/tag/content filters (everything except
  // the free-text search and tab partition). Shared by the tab-count summary.
  const applyBaseFilters = (bundles) => {
    var filtered = bundles;

    if (selectedSource && selectedSource !== 'all') {
      filtered = filtered.filter((bundle) => bundle.sourceId === selectedSource);
    }
    if (selectedTags.length > 0) {
      filtered = filtered.filter((bundle) => {
        if (!bundle.tags || bundle.tags.length === 0) {
          return false;
        }
        var normalizedBundleTags = bundle.tags.map((tag) => tag.toLowerCase());
        return selectedTags.some((tag) => normalizedBundleTags.includes(tag.toLowerCase()));
      });
    }
    // NOTE: content-type OR logic mirrors filterBundlesByContentType() in filter-utils.ts — keep in sync
    if (selectedContentTypes.length > 0) {
      filtered = filtered.filter((bundle) =>
        selectedContentTypes.some((type) => (bundle.contentBreakdown?.[type] || 0) > 0)
      );
    }
    return filtered;
  };

  const renderBundles = () => {
    var marketplace = document.querySelector('#marketplace');
    var searchTerm = document.querySelector('#searchBox').value;
    var hasSearch = Boolean(searchTerm && searchTerm.trim() !== '');

    var filteredBundles = allBundles;

    // 1. Partition by active tab
    if (selectedTab === 'installed') {
      filteredBundles = filteredBundles.filter((bundle) => bundle.installed === true);
    } else if (selectedTab === 'updates') {
      filteredBundles = filteredBundles.filter((bundle) => bundle.buttonState === 'update');
    }
    // 2. Apply structured filters (source, installed, tags, environment, content)
    filteredBundles = applyBaseFilters(filteredBundles);

    // 3. Match against the search. Semantic results (when available) are the
    //    source of truth — the same hybrid ranking the CLI shows — so we trust
    //    them as-is with no webview-side score threshold. See applySearch().
    var results = applySearch(filteredBundles, searchTerm);

    // 4. Sort. Relevance is only meaningful while searching; fall back to Name
    //    when the search box is empty (the button still shows the selection).
    var effectiveSort = (sortBy === 'relevance' && !hasSearch) ? 'name' : sortBy;
    var dir = sortDirection === 'asc' ? 1 : -1;
    switch (effectiveSort) {
      case 'name': {
        results.sort((a, b) => dir * a.bundle.name.localeCompare(b.bundle.name));
        break;
      }
      case 'recent': {
        results.sort((a, b) => dir * (new Date(a.bundle.lastUpdated || 0).getTime() - new Date(b.bundle.lastUpdated || 0).getTime()));
        break;
      }
      default: {
        // By relevance = the index's hybrid rank (0 = best). Always best-first:
        // relevance has no meaningful ascending ("least relevant first") mode,
        // so it is not reversible (unlike Name/Recently updated).
        results.sort((a, b) => a.rank - b.rank);
      }
    }
    filteredBundles = results.map((entry) => entry.bundle);

    // Progressive search: the deterministic keyword pass above renders instantly
    // on every keystroke, then the semantic hits swap in when they arrive. Only
    // fall back to a loading state when that instant pass found nothing AND the
    // index is still working — otherwise a purely-semantic query (no literal
    // keyword overlap) would flash a misleading "no bundles match" before its
    // real results land.
    if (semanticSearchPending && hasSearch && filteredBundles.length === 0) {
      marketplace.innerHTML = '<div class="loading">'
        + '<div class="spinner"></div>'
        + '<p>Searching…</p>'
        + '</div>';
      return;
    }

    // Reflect the number of collections remaining after the active tab,
    // search, and filter criteria have been applied.
    if (filteredBundles.length === 0) {
      // Check if we have any bundles at all (before filtering)
      var hasFiltersApplied = searchTerm || selectedSource !== 'all' || selectedTags.length > 0 || selectedContentTypes.length > 0;

      if (allBundles.length === 0) {
        var hasNoSources = setupState === 'complete' && sourcesCount === 0;
        var shouldShowSetupPrompt = setupState === 'incomplete' || setupState === 'not_started' || setupState === 'in_progress' || hasNoSources;

        var setupMessage = hasNoSources
          ? 'No sources are configured. Complete setup to browse bundles.'
          : 'No hub is configured. Complete setup to browse bundles.';

        marketplace.innerHTML = shouldShowSetupPrompt
          ? '<div class="empty-state">'
          + '<div class="empty-state-icon fa-icon fa-gear"></div>'
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
          + '<div class="empty-state-icon fa-icon fa-magnifying-glass"></div>'
          + '<div class="empty-state-title">No bundles match your filters</div>'
          + '<p>Try adjusting your search or filters</p>'
          + '</div>';
      } else {
        marketplace.innerHTML =
          '<div class="empty-state">'
          + '<div class="empty-state-icon fa-icon fa-box"></div>'
          + '<div class="empty-state-title">No bundles found</div>'
          + '<p>Try adjusting your search or filters</p>'
          + '</div>';
      }
      return;
    }

    marketplace.innerHTML = filteredBundles.map((bundle) => {
      return '<div class="bundle-card ' + (bundle.installed ? 'installed' : '') + '" data-bundle-id="' + bundle.id + '" data-action="openDetails">'
        + '<div class="bundle-header">'
        + '<div class="bundle-title">' + bundle.name + '</div>'
        + '<div class="bundle-author">by ' + (bundle.author || 'Unknown') + ' • ' + formatVersionLabel(bundle.version) + '</div>'
        + '</div>'

        + '<div class="bundle-description">'
        + (bundle.description || 'No description available')
        + '</div>'

        + '<div class="content-breakdown">'
        + renderContentItem('fa-file-lines', 'Prompts', bundle.contentBreakdown ? bundle.contentBreakdown.prompts || 0 : 0)
        + renderContentItem('fa-list-check', 'Instructions', bundle.contentBreakdown ? bundle.contentBreakdown.instructions || 0 : 0)
        + renderContentItem('fa-robot', 'Agents', bundle.contentBreakdown ? bundle.contentBreakdown.agents || 0 : 0)
        + renderContentItem('fa-puzzle-piece', 'Skills', bundle.contentBreakdown ? bundle.contentBreakdown.skills || 0 : 0)
        + renderContentItem('fa-plug', 'MCP Servers', bundle.contentBreakdown ? bundle.contentBreakdown.mcpServers || 0 : 0)
        + '</div>'

        + '<div class="bundle-tags">'
        + (bundle.tags || []).slice(0, 4).map((tag) => {
          return '<span class="tag">' + tag + '</span>';
        }).join('')
        + '</div>'

        + '<div class="bundle-actions" data-stop-propagation="true">'
        + renderBundleButtons(bundle)
        + '<button class="btn btn-link source-repo-button" data-action="openSourceRepo" data-bundle-id="' + bundle.id + '" title="Open Source Repository" aria-label="Open Source Repository">'
        + '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">'
        + '<path d="M4.5 3A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-2a.5.5 0 0 1 1 0v2'
        + 'a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-7A2.5 2.5 0 0 1 4.5 2h2a.5.5 0 0 1 0 1h-2z'
        + 'M9 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V3.707l-5.146 5.147a.5.5 0 0 1-.708-.708L12.293 3H9.5a.5.5 0 0 1-.5-.5z"/>'
        + '</svg>'
        + '<span>Repository</span>'
        + '</button>'
        + '</div>'
        + '</div>';
    }).join('');

    // Keep an open version menu visible when a background bundle refresh rerenders the cards.
    if (openVersionDropdownId) {
      var openDropdown = document.querySelector('#' + CSS.escape('version-dropdown-' + openVersionDropdownId));
      if (openDropdown) {
        openDropdown.classList.add('show');
      } else {
        openVersionDropdownId = null;
      }
    }
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
      + '<span class="content-icon fa-icon ' + icon + '" aria-hidden="true"></span>'
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

    // Toggle this dropdown and remember it across background card refreshes.
    var shouldShow = !dropdown.classList.contains('show');
    dropdown.classList.toggle('show', shouldShow);
    openVersionDropdownId = shouldShow ? dropdownId : null;
  };

  const installBundleVersion = (bundleId, version) => {
    // Close dropdown
    openVersionDropdownId = null;
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
      openVersionDropdownId = null;
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
