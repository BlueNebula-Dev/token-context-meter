/**
 * Global Usage Store & Multi-Conversation Aggregator for Token & Context Meter.
 *
 * - Scans ~/.gemini/antigravity/conversations (*.db / *.pb) with mtime caching
 * - Persists baseline resets and named / auto-dated snapshots to disk at
 *   ~/.gemini/config/plugins/token-context-meter/usage-store.json
 * - Supports JSON export & import of snapshots
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { callLanguageServerRpc } from './telemetry.mjs';

const STORE_PATH = join(homedir(), '.gemini', 'config', 'plugins', 'token-context-meter', 'usage-store.json');
const CONV_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');

function emptyTotals() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalProcessedTokens: 0,
    totalTurns: 0,
    toolCalls: 0
  };
}

function addTotals(target, delta) {
  target.inputTokens += delta.inputTokens || 0;
  target.cacheReadTokens += delta.cacheReadTokens || 0;
  target.outputTokens += delta.outputTokens || 0;
  target.thinkingTokens += delta.thinkingTokens || 0;
  target.responseTokens += delta.responseTokens || 0;
  target.totalProcessedTokens += delta.totalProcessedTokens || 0;
  target.totalTurns += delta.totalTurns || 0;
  target.toolCalls += delta.toolCalls || 0;
}

function subtractTotals(all, base) {
  const res = emptyTotals();
  res.inputTokens = Math.max(0, (all.inputTokens || 0) - (base?.inputTokens || 0));
  res.cacheReadTokens = Math.max(0, (all.cacheReadTokens || 0) - (base?.cacheReadTokens || 0));
  res.outputTokens = Math.max(0, (all.outputTokens || 0) - (base?.outputTokens || 0));
  res.thinkingTokens = Math.max(0, (all.thinkingTokens || 0) - (base?.thinkingTokens || 0));
  res.responseTokens = Math.max(0, (all.responseTokens || 0) - (base?.responseTokens || 0));
  res.totalProcessedTokens = res.inputTokens + res.cacheReadTokens + res.outputTokens;
  res.totalTurns = Math.max(0, (all.totalTurns || 0) - (base?.totalTurns || 0));
  res.toolCalls = Math.max(0, (all.toolCalls || 0) - (base?.toolCalls || 0));
  const denom = res.inputTokens + res.cacheReadTokens;
  res.cacheEfficiencyPct = denom > 0 ? ((res.cacheReadTokens / denom) * 100).toFixed(1) : '0.0';
  return res;
}

function loadStore() {
  try {
    if (existsSync(STORE_PATH)) {
      const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      return {
        version: 1,
        baselineAt: parsed.baselineAt || null,
        baseline: parsed.baseline || { totals: emptyTotals(), byModel: {} },
        convCache: parsed.convCache || {},
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : []
      };
    }
  } catch {}
  return {
    version: 1,
    baselineAt: null,
    baseline: { totals: emptyTotals(), byModel: {} },
    convCache: {},
    snapshots: []
  };
}

function saveStore(store) {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[GlobalStore] Failed to write usage store:', err.message);
  }
}

async function fetchConversationSummary(cascadeId) {
  const resp = await callLanguageServerRpc('GetCascadeTrajectory', { cascade_id: cascadeId });
  const traj = resp.trajectory || {};
  const rawTurns = traj.generatorMetadata || [];
  const steps = traj.steps || [];

  const totals = emptyTotals();
  const byModel = {};

  for (const turn of rawTurns) {
    const cm = turn.chatModel || {};
    const u = cm.usage || {};
    const input = parseInt(u.inputTokens || '0', 10);
    const cache = parseInt(u.cacheReadTokens || '0', 10);
    const output = parseInt(u.outputTokens || '0', 10);
    const thinking = parseInt(u.thinkingOutputTokens || '0', 10);
    const response = parseInt(u.responseOutputTokens || '0', 10) || Math.max(0, output - thinking);
    const modelName = cm.modelDisplayName || 'Default Model';

    const delta = {
      inputTokens: input,
      cacheReadTokens: cache,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens: response,
      totalProcessedTokens: input + cache + output,
      totalTurns: 1,
      toolCalls: 0
    };
    addTotals(totals, delta);
    if (!byModel[modelName]) byModel[modelName] = emptyTotals();
    addTotals(byModel[modelName], delta);
  }

  let toolCallsCount = 0;
  for (const s of steps) {
    const tcs = s.plannerResponse?.toolCalls;
    if (Array.isArray(tcs)) toolCallsCount += tcs.length;
  }
  totals.toolCalls = toolCallsCount;

  return { totals, byModel };
}

function formatAutoDateName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Scans all Antigravity conversations (cached by file mtime) and returns
 * global usage since the last reset baseline, per-model breakdown, and snapshots.
 */
export async function getGlobalUsage() {
  const store = loadStore();
  let cacheDirty = false;
  const activeIds = new Set();

  if (existsSync(CONV_DIR)) {
    const files = readdirSync(CONV_DIR)
      .filter(f => f.endsWith('.db') || f.endsWith('.pb'))
      .map(f => {
        try {
          return { id: f.replace(/\.(db|pb)$/, ''), mtime: statSync(join(CONV_DIR, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    // Fetch up to 24 uncached/changed conversations per call so /api/global stays fast
    const toFetch = [];
    for (const f of files) {
      activeIds.add(f.id);
      const cached = store.convCache[f.id];
      if (!cached || cached.mtime !== f.mtime) {
        toFetch.push(f);
      }
    }

    const MAX_PER_CALL = 24;
    const workSlice = toFetch.slice(0, MAX_PER_CALL);
    const pendingCount = Math.max(0, toFetch.length - workSlice.length);

    const batchSize = 8;
    for (let i = 0; i < workSlice.length; i += batchSize) {
      const batch = workSlice.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (f) => {
        try {
          const summary = await fetchConversationSummary(f.id);
          return { id: f.id, mtime: f.mtime, ...summary };
        } catch {
          return { id: f.id, mtime: f.mtime, totals: emptyTotals(), byModel: {} };
        }
      }));
      for (const r of results) {
        store.convCache[r.id] = { mtime: r.mtime, totals: r.totals, byModel: r.byModel };
        cacheDirty = true;
      }
    }

    var remainingToScan = pendingCount;
  }

  const allTimeTotals = emptyTotals();
  const allTimeByModel = {};

  for (const [id, entry] of Object.entries(store.convCache)) {
    if (!entry?.totals) continue;
    addTotals(allTimeTotals, entry.totals);
    for (const [mName, mTot] of Object.entries(entry.byModel || {})) {
      if (!allTimeByModel[mName]) allTimeByModel[mName] = emptyTotals();
      addTotals(allTimeByModel[mName], mTot);
    }
  }

  const currentTotals = subtractTotals(allTimeTotals, store.baseline?.totals);
  const currentByModel = {};
  const allModelNames = new Set([
    ...Object.keys(allTimeByModel),
    ...Object.keys(store.baseline?.byModel || {})
  ]);
  for (const mName of allModelNames) {
    const diff = subtractTotals(allTimeByModel[mName] || emptyTotals(), store.baseline?.byModel?.[mName]);
    if (diff.totalProcessedTokens > 0 || diff.totalTurns > 0) {
      currentByModel[mName] = diff;
    }
  }

  if (cacheDirty) saveStore(store);

  return {
    updatedAt: new Date().toISOString(),
    conversationCount: activeIds.size || Object.keys(store.convCache).length,
    pendingCount: remainingToScan || 0,
    baselineAt: store.baselineAt,
    current: currentTotals,
    allTime: subtractTotals(allTimeTotals, null),
    byModel: currentByModel,
    snapshots: store.snapshots
  };
}

export async function saveGlobalSnapshot(customName = '') {
  const usage = await getGlobalUsage();
  const store = loadStore();
  const cleanName = typeof customName === 'string' && customName.trim()
    ? customName.trim().slice(0, 64)
    : formatAutoDateName();

  const snap = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: cleanName,
    createdAt: new Date().toISOString(),
    conversationCount: usage.conversationCount,
    totals: usage.current,
    byModel: usage.byModel
  };

  store.snapshots.unshift(snap);
  if (store.snapshots.length > 100) store.snapshots = store.snapshots.slice(0, 100);
  saveStore(store);

  return { snapshot: snap, snapshots: store.snapshots };
}

export async function resetGlobalUsage() {
  await getGlobalUsage(); // Ensure convCache is up to date
  const store = loadStore();

  const allTimeTotals = emptyTotals();
  const allTimeByModel = {};
  for (const entry of Object.values(store.convCache)) {
    if (!entry?.totals) continue;
    addTotals(allTimeTotals, entry.totals);
    for (const [mName, mTot] of Object.entries(entry.byModel || {})) {
      if (!allTimeByModel[mName]) allTimeByModel[mName] = emptyTotals();
      addTotals(allTimeByModel[mName], mTot);
    }
  }

  store.baseline = { totals: allTimeTotals, byModel: allTimeByModel };
  store.baselineAt = new Date().toISOString();
  saveStore(store);

  return await getGlobalUsage();
}

export function deleteGlobalSnapshot(id) {
  const store = loadStore();
  store.snapshots = store.snapshots.filter(s => s.id !== id);
  saveStore(store);
  return { snapshots: store.snapshots };
}

export async function importGlobalData(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid JSON payload');
  }
  const store = loadStore();
  const incoming = Array.isArray(payload.snapshots)
    ? payload.snapshots
    : (payload.totals ? [{
        id: `snap_imp_${Date.now()}`,
        name: payload.name || `Imported ${formatAutoDateName()}`,
        createdAt: payload.createdAt || new Date().toISOString(),
        conversationCount: payload.conversationCount || 0,
        totals: payload.totals,
        byModel: payload.byModel || {}
      }] : []);

  const existingIds = new Set(store.snapshots.map(s => s.id));
  let added = 0;
  for (const s of incoming) {
    if (!s || typeof s !== 'object' || !s.totals) continue;
    const id = s.id && !existingIds.has(s.id) ? s.id : `snap_imp_${Date.now()}_${added}`;
    existingIds.add(id);
    store.snapshots.unshift({
      id,
      name: String(s.name || formatAutoDateName()).slice(0, 64),
      createdAt: s.createdAt || new Date().toISOString(),
      conversationCount: Number(s.conversationCount) || 0,
      totals: s.totals,
      byModel: s.byModel || {}
    });
    added += 1;
  }

  if (store.snapshots.length > 100) store.snapshots = store.snapshots.slice(0, 100);
  saveStore(store);
  return { importedCount: added, snapshots: store.snapshots };
}
