/**
 * Exact Local Telemetry Engine for Token & Context Meter.
 *
 * Connects directly to Antigravity Desktop's language_server RPC endpoint.
 * Zero client-side token estimation; queries server-side generator metadata
 * and live model configurations.
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Cache for model definitions
let cachedModels = null;
let modelsCacheExpiry = 0;

/**
 * Discovers the active language_server address and CSRF token.
 * Checks environment variables first; falls back to scanning running process flags.
 */
export function getLanguageServerCredentials() {
  let addr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  let csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';

  if (addr && csrf) {
    return { address: addr, csrfToken: csrf };
  }

  // Fallback: Discover from running process command line flags
  try {
    const isWindows = process.platform === 'win32';
    let output = '';

    if (isWindows) {
      const psScript = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*language_server*" } | Select-Object -ExpandProperty CommandLine';
      output = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf-8',
        timeout: 4000
      });
    } else {
      output = execFileSync('ps', ['aux'], {
        encoding: 'utf-8',
        timeout: 3000
      });
    }

    if (!csrf) {
      const csrfMatch = output.match(/--(?:csrf_token|csrf-token)[=\s]([a-f0-9-]+)/i);
      if (csrfMatch) csrf = csrfMatch[1];
    }

    if (!addr) {
      const portMatch = output.match(/--(?:port|https_server_port)[=\s](\d+)/i) ||
                        output.match(/host_bridge_url=https?:\/\/[^:]+:(\d+)/i);
      if (portMatch) {
        addr = `127.0.0.1:${portMatch[1]}`;
      }
    }
  } catch (err) {
    // Process inspection failed, fallback to standard defaults
  }

  // Safe defaults if still unresolved
  if (!addr) addr = '127.0.0.1:51267';
  if (!csrf) csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';

  return { address: addr, csrfToken: csrf };
}

/**
 * Discovers the active conversation ID / cascadeId.
 * Checks override -> environment -> conversations directory (*.db / *.pb).
 */
export function getActiveCascadeId(preferredId = null) {
  if (preferredId && typeof preferredId === 'string' && preferredId.trim()) {
    return preferredId.trim();
  }

  if (process.env.ANTIGRAVITY_CONVERSATION_ID) {
    return process.env.ANTIGRAVITY_CONVERSATION_ID.trim();
  }

  try {
    const convDir = join(homedir(), '.gemini', 'antigravity', 'conversations');
    if (existsSync(convDir)) {
      const files = readdirSync(convDir)
        .filter(f => f.endsWith('.db') || f.endsWith('.pb'))
        .map(f => {
          try {
            return { name: f, mtime: statSync(join(convDir, f)).mtimeMs };
          } catch {
            return { name: f, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        return files[0].name.replace(/\.(db|pb)$/, '');
      }
    }
  } catch (err) {
    console.error('Failed to resolve active cascadeId from conversations dir:', err);
  }

  return null;
}

/**
 * Performs an RPC call to LanguageServerService using Connect protocol over HTTP.
 */
export function callLanguageServerRpc(method, body = {}) {
  const { address, csrfToken } = getLanguageServerCredentials();
  let [host, portStr] = address.split(':');
  const port = parseInt(portStr || '51267', 10);
  if (!host || host === 'localhost') {
    host = '127.0.0.1';
  }
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`RPC ${method} returned HTTP ${res.statusCode}: ${json.message || data}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`RPC unmarshal failed: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`RPC ${method} connection error to ${host}:${port}: ${err.message}`));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`RPC ${method} timed out (10s)`));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Fetches available models and their token limits with caching.
 */
export async function getModelLimits() {
  const now = Date.now();
  if (cachedModels && now < modelsCacheExpiry) {
    return cachedModels;
  }

  try {
    const resp = await callLanguageServerRpc('GetAvailableModels', {});
    const models = resp.response?.models || {};
    cachedModels = models;
    modelsCacheExpiry = now + 60000; // Cache for 60 seconds
    return models;
  } catch (err) {
    if (cachedModels) return cachedModels;
    return {};
  }
}

/**
 * Returns a compact, readable model label suitable for narrow table columns.
 */
export function getCompactModelName(displayName, responseModel, modelKey) {
  if (displayName) {
    let name = displayName.trim();
    if (name.startsWith('Gemini ')) name = name.replace(/^Gemini\s+/, '');
    if (name.startsWith('Claude ')) name = name.replace(/^Claude\s+/, '');
    return name;
  }
  if (responseModel) return responseModel;
  if (modelKey) return modelKey.replace('MODEL_PLACEHOLDER_', '');
  return 'Unknown';
}

/**
 * Main telemetry aggregator: Fetches exact server-side token usage
 * and live context window consumption for the active conversation.
 */
export async function getConversationTokenTelemetry(requestedCascadeId = null) {
  const cascadeId = getActiveCascadeId(requestedCascadeId);
  if (!cascadeId) {
    throw new Error('No active conversation or cascadeId found.');
  }

  // Fetch complete trajectory and models in parallel
  const [trajResp, modelsResp] = await Promise.all([
    callLanguageServerRpc('GetCascadeTrajectory', { cascade_id: cascadeId }),
    getModelLimits().catch(() => ({}))
  ]);

  const traj = trajResp.trajectory || {};
  const steps = traj.steps || [];
  const rawTurns = traj.generatorMetadata || [];
  const models = modelsResp.response?.models || {};

  // 1. Identify user input boundaries from trajectory steps
  const userPrompts = [];
  steps.forEach((s, idx) => {
    if (s.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const text = s.userInput?.userResponse || '';
      userPrompts.push({
        promptNumber: userPrompts.length + 1,
        stepIndex: idx,
        userPromptPreview: text.trim().replace(/\s+/g, ' ').slice(0, 90)
      });
    }
  });

  // Fallback if no user input found
  if (userPrompts.length === 0) {
    userPrompts.push({
      promptNumber: 1,
      stepIndex: 0,
      userPromptPreview: 'Conversation Root'
    });
  }

  const promptGroups = userPrompts.map(p => ({
    promptNumber: p.promptNumber,
    userStepIndex: p.stepIndex,
    userPromptPreview: p.userPromptPreview,
    turns: []
  }));

  let cumulativeInputTokens = 0;
  let cumulativeCacheReadTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeThinkingTokens = 0;
  let cumulativeResponseTokens = 0;

  const turns = [];
  const compactions = [];
  const sessionModelsSet = new Set();
  let prevPromptTokens = 0;

  rawTurns.forEach((turn, idx) => {
    const chatModel = turn.chatModel || {};
    const usage = chatModel.usage || {};

    const inputTokens = parseInt(usage.inputTokens || '0', 10);
    const cacheReadTokens = parseInt(usage.cacheReadTokens || '0', 10);
    const outputTokens = parseInt(usage.outputTokens || '0', 10);
    const thinkingTokens = parseInt(usage.thinkingOutputTokens || '0', 10);
    const responseTokens = parseInt(usage.responseOutputTokens || '0', 10);

    const promptTokens = inputTokens + cacheReadTokens;
    const totalTurnTokens = promptTokens + outputTokens;

    const modelDisplayName = chatModel.modelDisplayName || 'Default Model';
    const responseModel = chatModel.responseModel || '';
    const modelKey = usage.model || '';
    const modelId = responseModel || modelKey || modelDisplayName;
    const modelShortName = getCompactModelName(modelDisplayName, responseModel, modelKey);

    if (modelDisplayName && modelDisplayName !== 'Default Model') {
      sessionModelsSet.add(modelDisplayName);
    }

    // Detect context compaction
    if (prevPromptTokens > 8000 && promptTokens < prevPromptTokens * 0.7) {
      compactions.push({
        turnIndex: idx + 1,
        stepIndices: turn.stepIndices || [],
        tokensBefore: prevPromptTokens,
        tokensAfter: promptTokens,
        tokensSaved: prevPromptTokens - promptTokens
      });
    }
    prevPromptTokens = promptTokens;

    cumulativeInputTokens += inputTokens;
    cumulativeCacheReadTokens += cacheReadTokens;
    cumulativeOutputTokens += outputTokens;
    cumulativeThinkingTokens += thinkingTokens;
    cumulativeResponseTokens += responseTokens;

    const turnItem = {
      turnNumber: idx + 1,
      stepIndices: turn.stepIndices || [],
      modelId,
      modelDisplayName,
      modelShortName,
      responseModel,
      modelKey,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      promptTokens,
      totalTurnTokens,
      cacheEfficiencyPct: promptTokens > 0 ? ((cacheReadTokens / promptTokens) * 100).toFixed(1) : '0.0'
    };
    turns.push(turnItem);

    // Assign turn to corresponding user prompt group
    const firstStep = turn.stepIndices && turn.stepIndices.length ? turn.stepIndices[0] : 0;
    let targetPromptIdx = 0;
    for (let i = 0; i < userPrompts.length; i++) {
      if (firstStep >= userPrompts[i].stepIndex) {
        targetPromptIdx = i;
      } else {
        break;
      }
    }
    promptGroups[targetPromptIdx].turns.push(turnItem);
  });

  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const sessionModels = Array.from(sessionModelsSet);
  const isMultiModel = sessionModels.length > 1;

  // Resolve active model and context limits
  let activeModelDisplayName = latestTurn?.modelDisplayName || 'Gemini 3.8 Flash (High)';
  let maxContextTokens = 1048576; // 1M tokens default
  let maxOutputTokens = 65536;

  for (const [key, modelDef] of Object.entries(models)) {
    if (modelDef.displayName === activeModelDisplayName ||
        (latestTurn?.responseModel && key.includes(latestTurn.responseModel))) {
      maxContextTokens = modelDef.maxTokens || maxContextTokens;
      maxOutputTokens = modelDef.maxOutputTokens || maxOutputTokens;
      activeModelDisplayName = modelDef.displayName || activeModelDisplayName;
      break;
    }
  }

  // 2. Build grouped prompts array for "By Prompt" view
  const prompts = promptGroups.map((pg) => {
    const pTurns = pg.turns;
    let sumInput = 0, sumCache = 0, sumThinking = 0, sumOutput = 0;
    const modelsUsedSet = [];
    const modelShortSet = [];

    pTurns.forEach(t => {
      sumInput += t.inputTokens;
      sumCache += t.cacheReadTokens;
      sumThinking += t.thinkingTokens;
      sumOutput += t.outputTokens;
      if (t.modelDisplayName && !modelsUsedSet.includes(t.modelDisplayName)) {
        modelsUsedSet.push(t.modelDisplayName);
      }
      if (t.modelShortName && !modelShortSet.includes(t.modelShortName)) {
        modelShortSet.push(t.modelShortName);
      }
    });

    const lastTurn = pTurns[pTurns.length - 1];
    const endingContext = lastTurn ? lastTurn.totalTurnTokens : (latestTurn ? latestTurn.totalTurnTokens : 0);
    const endingContextPct = maxContextTokens > 0 ? ((endingContext / maxContextTokens) * 100).toFixed(2) : '0.0';
    const totalPromptTokens = sumInput + sumCache;

    const minStep = pTurns.length && pTurns[0].stepIndices?.length ? pTurns[0].stepIndices[0] : pg.userStepIndex;
    const maxStep = pTurns.length && lastTurn?.stepIndices?.length ? lastTurn.stepIndices[lastTurn.stepIndices.length - 1] : minStep;

    return {
      promptNumber: pg.promptNumber,
      userPromptPreview: pg.userPromptPreview,
      llmCallsCount: pTurns.length,
      modelsUsed: modelsUsedSet.length ? modelsUsedSet : ['Unknown'],
      modelsUsedShort: modelShortSet.length ? modelShortSet : ['Unknown'],
      modelsRoutingPath: modelShortSet.length ? modelShortSet.join(' → ') : 'Unknown',
      newInput: sumInput,
      cacheRead: sumCache,
      thinking: sumThinking,
      output: sumOutput,
      totalTokens: sumInput + sumCache + sumOutput,
      cacheEfficiencyPct: totalPromptTokens > 0 ? ((sumCache / totalPromptTokens) * 100).toFixed(1) : '0.0',
      endingContext,
      endingContextPct,
      stepRange: pTurns.length ? `${minStep} → ${maxStep}` : `Step ${pg.userStepIndex}`
    };
  });

  // Active Context calculation
  const activeContextTokens = latestTurn ? latestTurn.totalTurnTokens : 0;
  const contextConsumptionPct = maxContextTokens > 0 ? ((activeContextTokens / maxContextTokens) * 100) : 0;
  const remainingTokens = Math.max(0, maxContextTokens - activeContextTokens);
  const remainingPct = Math.max(0, 100 - contextConsumptionPct);

  // Health threshold status
  let healthStatus = 'optimal';
  if (contextConsumptionPct >= 80) {
    healthStatus = 'critical';
  } else if (contextConsumptionPct >= 50) {
    healthStatus = 'moderate';
  }

  return {
    cascadeId,
    timestamp: new Date().toISOString(),
    healthStatus,
    sessionModels,
    isMultiModel,
    sessionModelsSummary: isMultiModel
      ? `${sessionModels.length} models used: ${sessionModels.join(', ')}`
      : `Single model (${sessionModels[0] || activeModelDisplayName})`,
    activeModel: {
      displayName: activeModelDisplayName,
      shortName: getCompactModelName(activeModelDisplayName, latestTurn?.responseModel, latestTurn?.modelKey),
      maxContextTokens,
      maxOutputTokens
    },
    liveContext: {
      activeTokens: activeContextTokens,
      maxLimit: maxContextTokens,
      consumptionPct: parseFloat(contextConsumptionPct.toFixed(2)),
      remainingTokens,
      remainingPct: parseFloat(remainingPct.toFixed(2)),
      compactionCount: compactions.length,
      compactions
    },
    latestTurn: latestTurn ? {
      turnNumber: latestTurn.turnNumber,
      stepIndices: latestTurn.stepIndices,
      modelId: latestTurn.modelId,
      modelDisplayName: latestTurn.modelDisplayName,
      modelShortName: latestTurn.modelShortName,
      inputTokens: latestTurn.inputTokens,
      cacheReadTokens: latestTurn.cacheReadTokens,
      outputTokens: latestTurn.outputTokens,
      thinkingTokens: latestTurn.thinkingTokens,
      responseTokens: latestTurn.responseTokens,
      promptTokens: latestTurn.promptTokens,
      cacheEfficiencyPct: latestTurn.cacheEfficiencyPct
    } : null,
    cumulative: {
      totalTurns: turns.length,
      totalPrompts: prompts.length,
      inputTokens: cumulativeInputTokens,
      cacheReadTokens: cumulativeCacheReadTokens,
      outputTokens: cumulativeOutputTokens,
      thinkingTokens: cumulativeThinkingTokens,
      responseTokens: cumulativeResponseTokens,
      totalProcessedTokens: cumulativeInputTokens + cumulativeCacheReadTokens + cumulativeOutputTokens,
      overallCacheSavingsPct: (cumulativeInputTokens + cumulativeCacheReadTokens) > 0 ?
        (((cumulativeCacheReadTokens) / (cumulativeInputTokens + cumulativeCacheReadTokens)) * 100).toFixed(1) : '0.0'
    },
    prompts,
    recentPrompts: prompts.slice(-15).reverse(),
    turns,
    recentTurns: turns.slice(-15).reverse()
  };
}
