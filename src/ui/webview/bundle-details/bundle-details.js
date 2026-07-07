// Bundle Details View JavaScript
// Initialized with data from TypeScript via window.bundleDetailsData

(() => {
  var vscode = acquireVsCodeApi();

  // Get initial data from window object (set by TypeScript)
  var autoUpdateEnabled = window.bundleDetailsData ? window.bundleDetailsData.autoUpdateEnabled : false;
  var bundleId = window.bundleDetailsData ? window.bundleDetailsData.bundleId : '';

  /**
   * Update the toggle UI to reflect current state
   */
  const updateToggleUI = () => {
    var toggle = document.querySelector('#autoUpdateToggle');
    if (toggle) {
      toggle.classList.toggle('enabled', autoUpdateEnabled);
    }
  };

  /**
   * Open a prompt file in the editor
   * @param {string} installPath
   * @param {string} filePath
   */
  const openPromptFile = (installPath, filePath) => {
    vscode.postMessage({
      type: 'openPromptFile',
      installPath: installPath,
      filePath: filePath
    });
  };

  /**
   * Toggle auto-update setting
   */
  const toggleAutoUpdate = () => {
    autoUpdateEnabled = !autoUpdateEnabled;
    updateToggleUI();
    vscode.postMessage({
      type: 'toggleAutoUpdate',
      bundleId: bundleId,
      enabled: autoUpdateEnabled
    });
  };

  // Listen for status updates from extension
  window.addEventListener('message', (event) => {
    var message = event.data;
    if (message.type === 'autoUpdateStatusChanged') {
      autoUpdateEnabled = message.enabled;
      updateToggleUI();
    } else if (message.type === 'readmeUpdated') {
      var readmeContent = document.querySelector('.details-content');
      if (readmeContent) {
        readmeContent.innerHTML = message.readmeHtml;
        readmeContent.closest('#readme-section')?.removeAttribute('style');
      }
    }
  });

  // Event delegation for all click handlers (CSP compliant)
  document.addEventListener('click', (e) => {
    var target = e.target;

    // Intercept clicks on rendered README links so they open externally
    // (with a confirmation prompt) instead of navigating the webview.
    var link = target.closest('a[data-external-link]');
    if (link) {
      e.preventDefault();
      var url = link.dataset.externalLink;
      if (url) {
        vscode.postMessage({
          type: 'openExternalLink',
          url: url
        });
      }
      return;
    }

    var actionElement = target.closest('[data-action]');

    if (actionElement) {
      var action = actionElement.dataset.action;
      var installPath = actionElement.dataset.installPath;
      var filePath = actionElement.dataset.filePath;

      switch (action) {
        case 'openPromptFile': {
          if (installPath && filePath) {
            openPromptFile(installPath, filePath);
          }
          break;
        }
        case 'toggleAutoUpdate': {
          toggleAutoUpdate();
          break;
        }
      }
    }
  });
})();
