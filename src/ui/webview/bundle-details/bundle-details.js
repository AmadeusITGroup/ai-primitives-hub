// Bundle Details View JavaScript
// Initialized with data from TypeScript via window.bundleDetailsData

(() => {
  var vscode = acquireVsCodeApi();

  // Get initial data from window object (set by TypeScript)
  var autoUpdateEnabled = window.bundleDetailsData ? window.bundleDetailsData.autoUpdateEnabled : false;
  var bundleId = window.bundleDetailsData ? window.bundleDetailsData.bundleId : '';
  var sourceId = window.bundleDetailsData ? window.bundleDetailsData.sourceId : '';

  // The rating the user has committed to; used as the rating value when the
  // inline feedback form is submitted. null means "no rating pending yet".
  var pendingStars = null;

  // User's existing rating (loaded from cache on panel open)
  var initialUserRating = window.bundleDetailsData ? window.bundleDetailsData.userRating : 0;

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
   * Visually mark the first N stars as filled.
   * @param {number} upTo
   */
  const updateStarsFilled = (upTo) => {
    var stars = document.querySelectorAll('#detailStars .star');
    stars.forEach((el) => {
      var n = Number.parseInt(el.dataset.star, 10);
      el.classList.toggle('filled', n <= upTo);
    });
  };

  /**
   * Show the inline feedback form so the user can add an optional comment.
   */
  const showFeedbackForm = () => {
    var form = document.querySelector('#detailFeedbackForm');
    if (form) {
      form.classList.add('visible');
    }
  };

  /**
   * Hide the inline feedback form and clear the textarea.
   */
  const hideFeedbackForm = () => {
    var form = document.querySelector('#detailFeedbackForm');
    var textarea = document.querySelector('#detailFeedbackText');
    if (form) {
      form.classList.remove('visible');
    }
    if (textarea) {
      textarea.value = '';
    }
  };

  /**
   * Re-render the rating display snapshot using a CachedRating pushed by the extension.
   * @param {{ starRating: number, voteCount: number } | undefined} bundleRating
   */
  const renderRatingDisplay = (bundleRating) => {
    var container = document.querySelector('.rating-display');
    if (!container) {
      return;
    }
    if (!bundleRating || !bundleRating.voteCount) {
      container.innerHTML = '<div class="rating-text rating-text-empty">No ratings yet</div>';
      return;
    }
    var txt = '★ ' + (bundleRating.starRating || 0).toFixed(1) + '  (' + bundleRating.voteCount + ')';
    var div = document.createElement('div');
    div.className = 'rating-text';
    div.textContent = txt;
    container.innerHTML = '';
    container.append(div);
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

  // Pre-fill stars if the user has already rated this bundle in this session
  if (initialUserRating > 0) {
    updateStarsFilled(initialUserRating);
    var label = document.querySelector('#detailStars .star-label');
    if (label) {
      label.textContent = 'Your rating';
    }
  }

  // Listen for status updates from extension
  window.addEventListener('message', (event) => {
    var message = event.data;
    switch (message.type) {
      case 'autoUpdateStatusChanged': {
        autoUpdateEnabled = message.enabled;
        updateToggleUI();

        break;
      }
      case 'ratingUpdated': {
        renderRatingDisplay(message.bundleRating);

        break;
      }
      case 'ratingSubmitted': {
        updateStarsFilled(message.stars);
        pendingStars = message.stars;
        var lbl = document.querySelector('#detailStars .star-label');
        if (lbl) {
          lbl.textContent = 'Your rating';
        }
        showFeedbackForm();

        break;
      }
      case 'ratingFailed': {
        pendingStars = null;
        updateStarsFilled(0);

        break;
      }
      case 'feedbackSubmitted': {
        hideFeedbackForm();
        pendingStars = null;

        break;
      }
    }
  });

  // Event delegation for all click handlers (CSP compliant)
  document.addEventListener('click', (e) => {
    var target = e.target;
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
        case 'rateBundle': {
          e.stopPropagation();
          var stars = Number.parseInt(actionElement.dataset.star, 10);
          if (stars >= 1 && stars <= 5) {
            vscode.postMessage({
              type: 'rateBundle',
              bundleId: bundleId,
              sourceId: sourceId,
              stars: stars
            });
          }
          break;
        }
        case 'cancelFeedbackForm': {
          e.stopPropagation();
          hideFeedbackForm();
          pendingStars = null;
          break;
        }
        case 'submitFeedbackForm': {
          e.stopPropagation();
          if (pendingStars !== null) {
            var textarea = document.querySelector('#detailFeedbackText');
            var comment = textarea ? textarea.value.trim() : '';
            vscode.postMessage({
              type: 'submitFeedback',
              bundleId: bundleId,
              sourceId: sourceId,
              stars: pendingStars,
              comment: comment
            });
          }
          break;
        }
        case 'reportIssue': {
          e.stopPropagation();
          vscode.postMessage({ type: 'reportIssue' });
          break;
        }
        case 'requestFeature': {
          e.stopPropagation();
          vscode.postMessage({ type: 'requestFeature' });
          break;
        }
      }
    }
  });
})();
