/**
 * Token & Context Meter - Concept 4: Cardless Editorial Ledger
 * Dynamic Telemetry Controller
 */

(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const conversationId = urlParams.get('conversationId') || '';
  const token = urlParams.get('token') || '';

  let currentTelemetry = null;
  let pollInterval = null;
  let activeView = localStorage.getItem('token_meter_view') || 'prompt';
  const POLL_MS = 2500;

  // DOM Elements
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const refreshBtn = document.getElementById('refreshBtn');
  const copyMarkdownBtn = document.getElementById('copyMarkdownBtn');
  const cascadeIdBadge = document.getElementById('cascadeIdBadge');

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
        statusDot.style.background = '#34d399';
        statusDot.style.boxShadow = '0 0 6px rgba(52, 211, 153, 0.6)';
      }
      if (statusText) statusText.textContent = '2.5s live';
    } catch (err) {
      console.warn('Telemetry sync error:', err.message);
      if (statusDot) {
        statusDot.style.background = '#f87171';
        statusDot.style.boxShadow = '0 0 6px rgba(248, 113, 113, 0.6)';
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

    let color = '#34d399'; // Emerald (< 50%)
    let healthLabel = 'Optimal Status';

    if (pct >= 80) {
      color = '#f87171'; // Red (> 80%)
      healthLabel = 'Critical Status (>80%)';
    } else if (pct >= 50) {
      color = '#fbbf24'; // Amber (50% - 80%)
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

    turnOutputTotalBadge.textContent = formatNum(latest.outputTokens);
    turnThinkingVal.textContent = formatNum(latest.thinkingTokens);
    turnResponseVal.textContent = formatNum(latest.responseTokens);

    // Cumulative Session Statistics
    totalTurnsBadge.textContent = `${cum.totalTurns || 0} Turns`;
    sessionProcessedVal.textContent = formatNum(cum.totalProcessedTokens);
    sessionCacheSavingsVal.textContent = `${cum.overallCacheSavingsPct || 0}% Re-use Rate`;

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
      renderPromptList(prompts);
    } else {
      const turns = currentTelemetry.recentTurns || currentTelemetry.turns || [];
      renderStepList(turns);
    }
  }

  function renderPromptList(prompts) {
    if (!prompts || prompts.length === 0) {
      telemetryList.innerHTML = `<div class="empty-state font-mono">No prompt records yet</div>`;
      return;
    }

    const latestPromptNum = prompts[0]?.promptNumber;

    telemetryList.innerHTML = prompts.map(p => {
      const isLatest = p.promptNumber === latestPromptNum;
      const previewText = p.userPromptPreview ? `(${truncate(p.userPromptPreview, 24)})` : '';
      const cacheClass = getCacheBadgeClass(p.cacheEfficiencyPct);

      let routingHtml = '';
      if (p.modelsUsedShort && p.modelsUsedShort.length > 0) {
        routingHtml = p.modelsUsedShort.map(m =>
          `<span class="routing-pill ${getModelPillClass(m)}" title="${m}">${m}</span>`
        ).join('<span class="routing-arrow">→</span>');
      }

      return `
        <div class="telemetry-item">
          <div class="item-top-row">
            <div class="item-title">
              <span class="prompt-num">#${p.promptNumber}${isLatest ? ' (Current)' : ''}</span>
              ${previewText ? `<span class="prompt-preview" title="${escapeHtml(p.userPromptPreview)}">${escapeHtml(previewText)}</span>` : ''}
              <span class="calls-count">· ${p.llmCallsCount} call${p.llmCallsCount === 1 ? '' : 's'}</span>
            </div>
            <span class="item-cache-badge ${cacheClass}">${p.cacheEfficiencyPct}% cache</span>
          </div>
          ${routingHtml ? `<div class="item-routing-row">${routingHtml}</div>` : ''}
          <div class="item-bottom-row">
            <span class="item-breakdown">In: ${formatCompactNum(p.newInput)} · Think: ${formatCompactNum(p.thinking)} · Out: ${formatCompactNum(p.output)}</span>
            <span class="item-context">Ctx: ${p.endingContextPct}%</span>
          </div>
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
      const stepsStr = t.stepIndices && t.stepIndices.length ? t.stepIndices.join('→') : '-';
      const modelLabel = t.modelShortName || t.modelDisplayName || 'Flash';
      const modelFullName = t.modelDisplayName || t.modelId || 'Unknown Model';
      const cacheClass = getCacheBadgeClass(t.cacheEfficiencyPct);

      return `
        <div class="telemetry-item">
          <div class="item-top-row">
            <div class="item-title">
              <span class="step-turn">#${t.turnNumber}</span>
              <span class="step-indices">· Step ${stepsStr}</span>
              <span class="routing-pill ${getModelPillClass(modelLabel)}" title="${modelFullName}">${modelLabel}</span>
            </div>
            <span class="item-cache-badge ${cacheClass}">${t.cacheEfficiencyPct}% cache</span>
          </div>
          <div class="item-bottom-row">
            <span class="item-breakdown">In: ${formatCompactNum(t.inputTokens)} · Cache: ${formatCompactNum(t.cacheReadTokens)} · Think: ${formatCompactNum(t.thinkingTokens)} · Out: ${formatCompactNum(t.outputTokens)}</span>
            <span class="item-context">${formatCompactNum(t.totalTurnTokens)} total</span>
          </div>
        </div>
      `;
    }).join('');
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
