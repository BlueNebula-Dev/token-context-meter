/**
 * Token & Context Meter - Concept 4: Cardless Editorial Ledger
 * Dynamic Telemetry Controller
 */

(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const conversationId = urlParams.get('conversationId') || '';
  const token = urlParams.get('token') || '';

  // Theme sync: follow the Antigravity host background (dark by default)
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #131417)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  let currentTelemetry = null;
  let pollInterval = null;
  let activeView = localStorage.getItem('token_meter_view') || 'prompt';
  // Telemetry item compaction: default mode (all compacted vs all expanded) + per-item overrides
  // When defaultItemsCompact is true, any newly arriving prompts/steps are compacted automatically.
  let defaultItemsCompact = localStorage.getItem('token_meter_items_default_compact') === 'true';
  let itemCompactOverrides = new Set();
  try {
    itemCompactOverrides = new Set(JSON.parse(localStorage.getItem('token_meter_compacted_overrides') || '[]'));
  } catch {}
  function saveCompacted() {
    try {
      localStorage.setItem('token_meter_items_default_compact', String(defaultItemsCompact));
      localStorage.setItem('token_meter_compacted_overrides', JSON.stringify([...itemCompactOverrides].slice(-200)));
    } catch {}
  }
  function itemKey(kind, num) {
    return `${currentTelemetry?.cascadeId || 'active'}:${kind}:${num}`;
  }
  function isItemCompact(key) {
    return defaultItemsCompact ? !itemCompactOverrides.has(key) : itemCompactOverrides.has(key);
  }

  // Persisted UI preferences: visible sections, compacted sections, telemetry fields
  const DEFAULT_SECTIONS = { windowUtil: true, activeTurn: true, genOutput: true, sessionTotals: true, telemetry: true };
  const DEFAULT_SECTION_COMPACT = { windowUtil: false, activeTurn: false, genOutput: false, sessionTotals: false, telemetry: false };
  const DEFAULT_TELEMETRY_FIELDS = { model: true, chat: true, calls: true, cache: true };

  function loadJsonPref(key, defaults) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed && typeof parsed === 'object' ? { ...defaults, ...parsed } : { ...defaults };
    } catch {
      return { ...defaults };
    }
  }
  function saveJsonPref(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
    } catch {}
  }

  const sectionVisibility = loadJsonPref('token_meter_sections', DEFAULT_SECTIONS);
  const sectionCompact = loadJsonPref('token_meter_section_compact', DEFAULT_SECTION_COMPACT);
  const telemetryFields = loadJsonPref('token_meter_telemetry_fields', DEFAULT_TELEMETRY_FIELDS);

  const POLL_MS = 2500;

  // DOM Elements
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const refreshBtn = document.getElementById('refreshBtn');
  const copyMarkdownBtn = document.getElementById('copyMarkdownBtn');
  const cascadeIdBadge = document.getElementById('cascadeIdBadge');

  const headerMenuBtn = document.getElementById('headerMenuBtn');
  const headerMenu = document.getElementById('headerMenu');
  const telemetryMenuBtn = document.getElementById('telemetryMenuBtn');
  const telemetryMenu = document.getElementById('telemetryMenu');
  const telemetryHeaderToggle = document.getElementById('telemetryHeaderToggle');
  const compactAllBtn = document.getElementById('compactAllBtn');

  const windowUtilCompactVal = document.getElementById('windowUtilCompactVal');
  const activeTurnCompactVal = document.getElementById('activeTurnCompactVal');
  const sessionCompactVal = document.getElementById('sessionCompactVal');
  const telemetryCompactVal = document.getElementById('telemetryCompactVal');

  const viewPromptBtn = document.getElementById('viewPromptBtn');
  const viewStepBtn = document.getElementById('viewStepBtn');
  const telemetryList = document.getElementById('telemetryList');

  const contextPctValue = document.getElementById('contextPctValue');
  const healthBadge = document.getElementById('healthBadge');
  const contextProgressBar = document.getElementById('contextProgressBar');
  const activeTokensVal = document.getElementById('activeTokensVal');
  const remainingTokensVal = document.getElementById('remainingTokensVal');
  const modelNameBadge = document.getElementById('modelNameBadge');
  const multiModelBadge = document.getElementById('multiModelBadge');

  const compactionAlert = document.getElementById('compactionAlert');
  const compactionTitle = document.getElementById('compactionTitle');
  const compactionDesc = document.getElementById('compactionDesc');

  const cacheHitBadge = document.getElementById('cacheHitBadge');
  const turnPromptTotalVal = document.getElementById('turnPromptTotalVal');
  const turnCacheReadVal = document.getElementById('turnCacheReadVal');
  const turnNewInputVal = document.getElementById('turnNewInputVal');

  const turnOutputTotalBadge = document.getElementById('turnOutputTotalBadge');
  const turnThinkingVal = document.getElementById('turnThinkingVal');
  const turnResponseVal = document.getElementById('turnResponseVal');

  const totalTurnsBadge = document.getElementById('totalTurnsBadge');
  const sessionProcessedVal = document.getElementById('sessionProcessedVal');
  const sessionCacheSavingsVal = document.getElementById('sessionCacheSavingsVal');
  const sessionInputTotal = document.getElementById('sessionInputTotal');
  const sessionOutputTotal = document.getElementById('sessionOutputTotal');
  const sessionThinkingTotal = document.getElementById('sessionThinkingTotal');

  function formatNum(num) {
    return (num || 0).toLocaleString();
  }

  function formatCompactNum(num) {
    const val = Number(num) || 0;
    if (Math.abs(val) >= 1_000_000) {
      return (val / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
    }
    if (Math.abs(val) >= 10_000) {
      return (val / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    if (Math.abs(val) >= 1_000) {
      return (val / 1_000).toFixed(1) + 'K';
    }
    return val.toLocaleString();
  }

  function truncate(str, maxLen = 24) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen).trim() + '…' : str;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getModelPillClass(name) {
    if (!name) return '';
    const lower = name.toLowerCase();
    if (lower.includes('high')) return 'flash-high';
    if (lower.includes('low')) return 'flash-low';
    if (lower.includes('pro')) return 'pro';
    if (lower.includes('argon')) return 'argon';
    return '';
  }

  function getCacheBadgeClass(pct) {
    const num = parseFloat(pct) || 0;
    if (num >= 90) return 'cache-high';
    if (num >= 60) return 'cache-mid';
    return 'cache-low';
  }

  async function fetchTelemetry() {
    try {
      const q = new URLSearchParams();
      if (conversationId) q.set('conversationId', conversationId);
      if (token) q.set('token', token);

      const res = await fetch(`/api/tokens?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      currentTelemetry = data;
      renderDashboard(data);

      if (statusDot) {
        statusDot.style.background = 'var(--tm-ok)';
      }
      if (statusText) statusText.textContent = '2.5s live';
    } catch (err) {
      console.warn('Telemetry sync error:', err.message);
      if (statusDot) {
        statusDot.style.background = 'var(--tm-crit)';
      }
      if (statusText) statusText.textContent = 'Reconnecting';
    }
  }

  function renderDashboard(data) {
    const ctx = data.liveContext || {};
    const latest = data.latestTurn || {};
    const cum = data.cumulative || {};
    const model = data.activeModel || {};

    // Header Cascade ID
    const shortId = data.cascadeId ? data.cascadeId.slice(0, 8) : 'active';
    cascadeIdBadge.textContent = `Cascade · ${shortId}`;
    cascadeIdBadge.title = `Cascade ID: ${data.cascadeId || 'Active'}`;

    // Model badges
    const latestModel = latest.modelDisplayName || model.displayName || 'Gemini 3.8 Flash';
    modelNameBadge.textContent = latestModel;

    if (data.isMultiModel && data.sessionModels && data.sessionModels.length > 1) {
      modelNameBadge.title = `Latest turn model: ${latestModel}\nSession models (${data.sessionModels.length}):\n• ${data.sessionModels.join('\n• ')}`;
      if (multiModelBadge) {
        multiModelBadge.style.display = 'inline-flex';
        multiModelBadge.textContent = `${data.sessionModels.length} Models`;
        multiModelBadge.title = `Multiple models used across session:\n• ${data.sessionModels.join('\n• ')}`;
      }
    } else {
      modelNameBadge.title = `Handled by ${latestModel}`;
      if (multiModelBadge) {
        multiModelBadge.style.display = 'none';
      }
    }

    // Capacity Percentage & Progress Bar
    const pct = Math.min(100, Math.max(0, ctx.consumptionPct || 0));
    contextPctValue.textContent = `${pct.toFixed(1)}%`;

    let color = 'var(--tm-ok)'; // Green (< 50%)
    let healthLabel = 'Optimal Status';

    if (pct >= 80) {
      color = 'var(--tm-crit)'; // Red (> 80%)
      healthLabel = 'Critical Status (>80%)';
    } else if (pct >= 50) {
      color = 'var(--tm-warn)'; // Amber (50% - 80%)
      healthLabel = 'Moderate Status (50-80%)';
    }

    healthBadge.textContent = healthLabel;
    healthBadge.style.color = color;

    contextProgressBar.style.width = `${pct}%`;
    contextProgressBar.style.backgroundColor = color;

    // Active vs Remaining Tokens
    activeTokensVal.textContent = `${formatNum(ctx.activeTokens)} active`;
    activeTokensVal.title = `Active Context: ${formatNum(ctx.activeTokens)} / ${formatNum(ctx.maxLimit)} tokens`;
    remainingTokensVal.textContent = `${formatNum(ctx.remainingTokens)} remaining`;
    remainingTokensVal.title = `${ctx.remainingPct || 0}% remaining capacity`;
    if (windowUtilCompactVal) windowUtilCompactVal.textContent = `${pct.toFixed(1)}% used`;

    // Compaction Alert
    if (ctx.compactionCount > 0) {
      compactionAlert.style.display = 'block';
      compactionTitle.textContent = `Context Compaction Active (${ctx.compactionCount} Checkpoints)`;
      const lastC = ctx.compactions[ctx.compactions.length - 1];
      compactionDesc.textContent = `Compacted at Turn #${lastC.turnIndex}, saving ${formatNum(lastC.tokensSaved)} tokens from earlier history.`;
    } else {
      compactionAlert.style.display = 'none';
    }

    // Active Turn Breakdown
    cacheHitBadge.textContent = `${latest.cacheEfficiencyPct || 0}% Cached`;
    turnPromptTotalVal.textContent = formatNum(latest.promptTokens);
    turnCacheReadVal.textContent = formatNum(latest.cacheReadTokens);
    turnNewInputVal.textContent = formatNum(latest.inputTokens);
    if (activeTurnCompactVal) activeTurnCompactVal.textContent = formatCompactNum(latest.promptTokens);

    turnOutputTotalBadge.textContent = formatNum(latest.outputTokens);
    turnThinkingVal.textContent = formatNum(latest.thinkingTokens);
    turnResponseVal.textContent = formatNum(latest.responseTokens);

    // Cumulative Session Statistics
    totalTurnsBadge.textContent = `${cum.totalTurns || 0} Turns`;
    sessionProcessedVal.textContent = formatNum(cum.totalProcessedTokens);
    sessionCacheSavingsVal.textContent = `${cum.overallCacheSavingsPct || 0}% Re-use Rate`;
    if (sessionCompactVal) sessionCompactVal.textContent = formatCompactNum(cum.totalProcessedTokens);

    sessionInputTotal.textContent = formatCompactNum(cum.inputTokens);
    sessionInputTotal.title = `${formatNum(cum.inputTokens)} total input tokens`;
    sessionOutputTotal.textContent = formatCompactNum(cum.outputTokens);
    sessionOutputTotal.title = `${formatNum(cum.outputTokens)} total output tokens`;
    sessionThinkingTotal.textContent = formatCompactNum(cum.thinkingTokens);
    sessionThinkingTotal.title = `${formatNum(cum.thinkingTokens)} total thinking tokens`;

    // Render Telemetry List
    updateToggleButtons();
    renderTelemetryList();
  }

  function updateToggleButtons() {
    if (viewPromptBtn && viewStepBtn) {
      if (activeView === 'prompt') {
        viewPromptBtn.classList.add('active');
        viewStepBtn.classList.remove('active');
      } else {
        viewStepBtn.classList.add('active');
        viewPromptBtn.classList.remove('active');
      }
    }
  }

  function renderTelemetryList() {
    if (!currentTelemetry || !telemetryList) return;

    if (activeView === 'prompt') {
      const prompts = currentTelemetry.recentPrompts || currentTelemetry.prompts || [];
      if (telemetryCompactVal) telemetryCompactVal.textContent = `· ${prompts.length} prompt${prompts.length === 1 ? '' : 's'}`;
      renderPromptList(prompts);
    } else {
      const turns = currentTelemetry.recentTurns || currentTelemetry.turns || [];
      if (telemetryCompactVal) telemetryCompactVal.textContent = `· ${turns.length} step${turns.length === 1 ? '' : 's'}`;
      renderStepList(turns);
    }
  }

  function formatStepRange(stepIndices) {
    if (!stepIndices || !stepIndices.length) return { label: '-', title: 'No steps' };
    if (stepIndices.length === 1) return { label: String(stepIndices[0]), title: `Step ${stepIndices[0]}` };
    const first = stepIndices[0];
    const last = stepIndices[stepIndices.length - 1];
    return {
      label: `${first}–${last}`,
      title: `Steps ${stepIndices.join(', ')}`
    };
  }

  function renderLedgerRows(rows) {
    return `<div class="item-ledger">${rows.map(r => `
      <div class="item-ledger-row">
        <span class="item-ledger-key"><span class="item-ledger-dot ${r.dot}"></span>${escapeHtml(r.label)}</span>
        <span class="item-ledger-val ${r.valClass || ''}">${escapeHtml(r.value)}</span>
      </div>
    `).join('')}</div>`;
  }

  function renderPromptList(prompts) {
    if (!prompts || prompts.length === 0) {
      telemetryList.innerHTML = `<div class="empty-state font-mono">No prompt records yet</div>`;
      return;
    }

    const latestPromptNum = prompts[0]?.promptNumber;

    telemetryList.innerHTML = prompts.map(p => {
      const isLatest = p.promptNumber === latestPromptNum;
      const previewText = p.userPromptPreview ? truncate(p.userPromptPreview, 26) : '';
      const cacheClass = getCacheBadgeClass(p.cacheEfficiencyPct);
      const key = itemKey('prompt', p.promptNumber);
      const isCompact = isItemCompact(key);

      let routingHtml = '';
      if (telemetryFields.model && p.modelsUsedShort && p.modelsUsedShort.length > 0) {
        routingHtml = p.modelsUsedShort.map(m =>
          `<span class="routing-pill ${getModelPillClass(m)}" title="${escapeHtml(m)}">${escapeHtml(m)}</span>`
        ).join('<span class="routing-arrow">→</span>');
      }

      // Dynamic priority for single-line top row: Chat -> Model -> Call counts -> Cache
      const showChatPrimary = telemetryFields.chat && Boolean(previewText);
      const promoteModelToTop = !showChatPrimary && Boolean(routingHtml);
      const hasLeadingItem = showChatPrimary || promoteModelToTop;
      const callsText = `${p.llmCallsCount} call${p.llmCallsCount === 1 ? '' : 's'}`;
      const showAnyField = showChatPrimary || Boolean(routingHtml) || telemetryFields.calls || telemetryFields.cache;

      const ledgerHtml = renderLedgerRows([
        { dot: 'dot-input', label: 'New Input', value: formatNum(p.newInput) },
        { dot: 'dot-cache', label: 'Cache Read', value: formatNum(p.cacheRead), valClass: 'val-cache' },
        { dot: 'dot-think', label: 'Thinking', value: formatNum(p.thinking), valClass: 'val-think' },
        { dot: 'dot-output', label: 'Output', value: formatNum(p.output) },
        { dot: 'dot-total', label: 'Ending Context', value: `${formatCompactNum(p.endingContext)} (${p.endingContextPct}%)`, valClass: 'val-strong' }
      ]);

      return `
        <div class="telemetry-item${isCompact ? ' compact' : ''}" data-key="${escapeHtml(key)}" role="button" tabindex="0" aria-expanded="${!isCompact}" title="Click to ${isCompact ? 'expand' : 'compact'}">
          <div class="item-top-row">
            <div class="item-title">
              <span class="num-capsule${isLatest ? ' current' : ''}" title="${isLatest ? 'Current prompt' : `Prompt ${p.promptNumber}`}">${p.promptNumber}</span>
              ${showChatPrimary ? `<span class="prompt-preview" title="${escapeHtml(p.userPromptPreview)}">${escapeHtml(previewText)}</span>` : ''}
              ${promoteModelToTop ? `<span class="item-inline-routing">${routingHtml}</span>` : ''}
              ${telemetryFields.calls ? `<span class="calls-count">${hasLeadingItem ? '· ' : ''}${callsText}</span>` : ''}
            </div>
            ${telemetryFields.cache
              ? `<span class="item-cache-badge ${cacheClass}">${p.cacheEfficiencyPct}% cache</span>`
              : (!showAnyField ? `<span class="item-context">${p.endingContextPct}% ctx</span>` : '')}
          </div>
          ${!promoteModelToTop && routingHtml ? `<div class="item-routing-row">${routingHtml}</div>` : ''}
          ${ledgerHtml}
        </div>
      `;
    }).join('');
  }

  function renderStepList(turns) {
    if (!turns || turns.length === 0) {
      telemetryList.innerHTML = `<div class="empty-state font-mono">No step records yet</div>`;
      return;
    }

    telemetryList.innerHTML = turns.map(t => {
      const stepRange = formatStepRange(t.stepIndices);
      const modelLabel = t.modelShortName || t.modelDisplayName || 'Flash';
      const modelFullName = t.modelDisplayName || t.modelId || 'Unknown Model';
      const cacheClass = getCacheBadgeClass(t.cacheEfficiencyPct);
      const key = itemKey('step', t.turnNumber);
      const isCompact = isItemCompact(key);
      const showAnyField = telemetryFields.chat || telemetryFields.model || telemetryFields.cache;

      const ledgerHtml = renderLedgerRows([
        { dot: 'dot-input', label: 'New Input', value: formatNum(t.inputTokens) },
        { dot: 'dot-cache', label: 'Cache Read', value: formatNum(t.cacheReadTokens), valClass: 'val-cache' },
        { dot: 'dot-think', label: 'Thinking', value: formatNum(t.thinkingTokens), valClass: 'val-think' },
        { dot: 'dot-output', label: 'Output', value: formatNum(t.outputTokens) },
        { dot: 'dot-total', label: 'Total Turn', value: formatNum(t.totalTurnTokens), valClass: 'val-strong' }
      ]);

      return `
        <div class="telemetry-item${isCompact ? ' compact' : ''}" data-key="${escapeHtml(key)}" role="button" tabindex="0" aria-expanded="${!isCompact}" title="Click to ${isCompact ? 'expand' : 'compact'}">
          <div class="item-top-row">
            <div class="item-title">
              <span class="num-capsule" title="Turn ${t.turnNumber}">${t.turnNumber}</span>
              ${telemetryFields.chat ? `<span class="step-indices" title="${escapeHtml(stepRange.title)}">Step ${escapeHtml(stepRange.label)}</span>` : ''}
              ${telemetryFields.model ? `<span class="routing-pill ${getModelPillClass(modelLabel)}" title="${escapeHtml(modelFullName)}">${escapeHtml(modelLabel)}</span>` : ''}
            </div>
            ${telemetryFields.cache
              ? `<span class="item-cache-badge ${cacheClass}">${t.cacheEfficiencyPct}% cache</span>`
              : (!showAnyField ? `<span class="item-context">${formatCompactNum(t.totalTurnTokens)}</span>` : '')}
          </div>
          ${ledgerHtml}
        </div>
      `;
    }).join('');
  }

  // Apply persisted section visibility, section compact states & checkbox states
  function applySectionStates() {
    document.querySelectorAll('[data-section]').forEach((sec) => {
      const key = sec.dataset.section;
      const visible = sectionVisibility[key] !== false;
      const compact = Boolean(sectionCompact[key]);
      sec.classList.toggle('hidden', !visible);
      sec.classList.toggle('compact', compact);
      if (sec.classList.contains('compactable-section')) {
        sec.setAttribute('aria-expanded', String(!compact));
        sec.title = `Click to ${compact ? 'expand' : 'compact'}`;
      }
    });
    if (telemetryHeaderToggle) {
      const compact = Boolean(sectionCompact.telemetry);
      telemetryHeaderToggle.setAttribute('aria-expanded', String(!compact));
      telemetryHeaderToggle.title = `Click to ${compact ? 'expand' : 'compact'} Telemetry`;
    }
    document.querySelectorAll('[data-section-toggle]').forEach((cb) => {
      cb.checked = sectionVisibility[cb.dataset.sectionToggle] !== false;
    });
    document.querySelectorAll('[data-field-toggle]').forEach((cb) => {
      cb.checked = telemetryFields[cb.dataset.fieldToggle] !== false;
    });
  }

  function toggleSectionCompact(key) {
    if (!key) return;
    sectionCompact[key] = !sectionCompact[key];
    saveJsonPref('token_meter_section_compact', sectionCompact);
    applySectionStates();
  }

  // Click / keyboard to compact Window Util, Active Turn, Gen Output, Session Totals
  document.querySelectorAll('.compactable-section').forEach((sec) => {
    sec.addEventListener('click', (e) => {
      if (window.getSelection && String(window.getSelection()).length) return;
      if (e.target.closest('button, input, label, .popover-menu')) return;
      toggleSectionCompact(sec.dataset.section);
    });
    sec.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target !== sec) return;
      e.preventDefault();
      toggleSectionCompact(sec.dataset.section);
    });
  });

  if (telemetryHeaderToggle) {
    telemetryHeaderToggle.addEventListener('click', () => {
      toggleSectionCompact('telemetry');
    });
  }

  // Popover menus (⋮) in header and telemetry
  function closeAllMenus() {
    if (headerMenu) headerMenu.classList.remove('open');
    if (headerMenuBtn) headerMenuBtn.setAttribute('aria-expanded', 'false');
    if (telemetryMenu) telemetryMenu.classList.remove('open');
    if (telemetryMenuBtn) telemetryMenuBtn.setAttribute('aria-expanded', 'false');
  }

  function bindPopoverMenu(btn, menu) {
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains('open');
      closeAllMenus();
      if (willOpen) {
        menu.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
  }

  bindPopoverMenu(headerMenuBtn, headerMenu);
  bindPopoverMenu(telemetryMenuBtn, telemetryMenu);

  document.addEventListener('click', closeAllMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllMenus();
  });

  document.querySelectorAll('[data-section-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      sectionVisibility[cb.dataset.sectionToggle] = cb.checked;
      saveJsonPref('token_meter_sections', sectionVisibility);
      applySectionStates();
    });
  });

  document.querySelectorAll('[data-field-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      telemetryFields[cb.dataset.fieldToggle] = cb.checked;
      saveJsonPref('token_meter_telemetry_fields', telemetryFields);
      renderTelemetryList();
    });
  });

  function updateCompactAllBtn() {
    if (!compactAllBtn) return;
    compactAllBtn.classList.toggle('active', defaultItemsCompact);
    compactAllBtn.setAttribute('aria-pressed', String(defaultItemsCompact));
    compactAllBtn.title = defaultItemsCompact
      ? 'Expand all telemetry items (new items auto-compact is ON)'
      : 'Compact all telemetry items (also auto-compacts new items)';
  }

  if (compactAllBtn) {
    compactAllBtn.addEventListener('click', () => {
      defaultItemsCompact = !defaultItemsCompact;
      itemCompactOverrides.clear();
      saveCompacted();
      updateCompactAllBtn();
      renderTelemetryList();
    });
  }

  updateCompactAllBtn();
  applySectionStates();

  // Click / keyboard toggle to compact individual telemetry items
  function toggleItem(el) {
    const key = el?.dataset?.key;
    if (!key) return;
    if (itemCompactOverrides.has(key)) itemCompactOverrides.delete(key);
    else itemCompactOverrides.add(key);
    saveCompacted();
    const isCompact = isItemCompact(key);
    el.classList.toggle('compact', isCompact);
    el.setAttribute('aria-expanded', String(!isCompact));
    el.title = `Click to ${isCompact ? 'expand' : 'compact'}`;
  }

  if (telemetryList) {
    telemetryList.addEventListener('click', (e) => {
      if (window.getSelection && String(window.getSelection()).length) return;
      toggleItem(e.target.closest('.telemetry-item'));
    });
    telemetryList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('.telemetry-item');
      if (!item) return;
      e.preventDefault();
      toggleItem(item);
    });
  }

  // View toggle button listeners
  if (viewPromptBtn) {
    viewPromptBtn.addEventListener('click', () => {
      activeView = 'prompt';
      localStorage.setItem('token_meter_view', 'prompt');
      updateToggleButtons();
      renderTelemetryList();
    });
  }

  if (viewStepBtn) {
    viewStepBtn.addEventListener('click', () => {
      activeView = 'step';
      localStorage.setItem('token_meter_view', 'step');
      updateToggleButtons();
      renderTelemetryList();
    });
  }

  // Copy Markdown Summary matching /context CLI output
  if (copyMarkdownBtn) {
    copyMarkdownBtn.addEventListener('click', () => {
      if (!currentTelemetry) return;
      const t = currentTelemetry;
      const ctx = t.liveContext || {};
      const lat = t.latestTurn || {};
      const cum = t.cumulative || {};

      const md = [
        `### 📊 Active Chat Context & Token Meter`,
        `- **Active Model:** ${lat.modelDisplayName || t.activeModel?.displayName || 'Unknown'}${t.isMultiModel ? ` (Multi-model session: ${t.sessionModels.join(', ')})` : ''}`,
        `- **Live Context Window:** ${formatNum(ctx.activeTokens)} / ${formatNum(ctx.maxLimit)} tokens (${ctx.consumptionPct}% used, ${formatNum(ctx.remainingTokens)} free)`,
        `- **Latest Turn (#${lat.turnNumber}):**`,
        `  - Model: ${lat.modelDisplayName || 'Unknown'}`,
        `  - Input: ${formatNum(lat.inputTokens)} tokens`,
        `  - Cache Read: ${formatNum(lat.cacheReadTokens)} tokens (${lat.cacheEfficiencyPct}% cache reuse)`,
        `  - Output: ${formatNum(lat.outputTokens)} tokens (Reasoning/Thinking: ${formatNum(lat.thinkingTokens)}, Output: ${formatNum(lat.responseTokens)})`,
        `- **Session Cumulative (${cum.totalTurns} turns):**`,
        `  - Total Processed: ${formatNum(cum.totalProcessedTokens)} tokens`,
        `  - Cache Efficiency: ${cum.overallCacheSavingsPct}% overall reuse rate`,
        ctx.compactionCount > 0 ? `- **Compaction Events:** ${ctx.compactionCount} history compaction checkpoints` : null
      ].filter(Boolean).join('\n');

      navigator.clipboard.writeText(md).then(() => {
        const origText = copyMarkdownBtn.textContent.trim();
        copyMarkdownBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyMarkdownBtn.textContent = origText;
        }, 1800);
      }).catch(err => {
        console.error('Clipboard copy failed:', err);
      });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchTelemetry();
    });
  }

  // Initial load & Start polling
  fetchTelemetry();
  pollInterval = setInterval(fetchTelemetry, POLL_MS);
})();
