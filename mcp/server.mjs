#!/usr/bin/env node
/**
 * MCP Server for Token & Context Meter.
 *
 * Exposes MCP tools over stdio (JSON-RPC 2.0) to allow inspecting
 * exact server-side token usage and live context window consumption in chat.
 */

import readline from 'node:readline';
import { getConversationTokenTelemetry, getModelLimits } from '../sidecars/meter/telemetry.mjs';

function formatNumber(num) {
  return (num || 0).toLocaleString();
}

function sendResponse(id, result) {
  const response = {
    jsonrpc: '2.0',
    id,
    result
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendError(id, code, message) {
  const response = {
    jsonrpc: '2.0',
    id,
    error: { code, message }
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

const TOOLS = [
  {
    name: 'get_token_context',
    description: 'Get exact server-side token usage and live context window consumption matching Antigravity CLI /context. Shows active context tokens vs model limit, remaining capacity, latest turn input/cache/thinking/output breakdown, and cumulative session totals.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Optional conversation ID or cascadeId. Defaults to the active conversation.'
        }
      }
    }
  },
  {
    name: 'get_turn_history',
    description: 'Get a detailed breakdown of token consumption and model routing. Supports both "prompt" view (grouped by user prompt boundary) and "step" view (granular per-call breakdown).',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['prompt', 'step'],
          description: 'Aggregation mode: "prompt" (default, grouped by user message) or "step" (granular individual LLM calls).'
        },
        limit: {
          type: 'number',
          description: 'Number of recent prompts or turns to retrieve (default: 10).'
        },
        conversation_id: {
          type: 'string',
          description: 'Optional conversation ID or cascadeId.'
        }
      }
    }
  }
];

async function handleToolCall(name, args) {
  const telemetry = await getConversationTokenTelemetry(args?.conversation_id);
  const ctx = telemetry.liveContext;
  const latest = telemetry.latestTurn;
  const cum = telemetry.cumulative;
  const model = telemetry.activeModel;

  if (name === 'get_token_context') {
    let output = [
      `### 📊 Live Context Window & Token Meter`,
      `- **Active Model:** ${latest?.modelDisplayName || model.displayName}${telemetry.isMultiModel ? ` (${telemetry.sessionModelsSummary})` : ''}`,
      `- **Live Context Window:** ${formatNumber(ctx.activeTokens)} / ${formatNumber(ctx.maxLimit)} tokens (**${ctx.consumptionPct}%** used)`,
      `- **Remaining Capacity:** ${formatNumber(ctx.remainingTokens)} tokens (${ctx.remainingPct}% free)`,
      `- **Health Status:** ${telemetry.healthStatus.toUpperCase()}`
    ];

    if (ctx.compactionCount > 0) {
      output.push(`- **Compaction Events:** ${ctx.compactionCount} history checkpoints executed to reclaim context`);
    }

    if (latest) {
      output.push(
        ``,
        `#### Latest AI Turn (#${latest.turnNumber}):`,
        `- **New Input Tokens:** ${formatNumber(latest.inputTokens)}`,
        `- **Cache Read Tokens:** ${formatNumber(latest.cacheReadTokens)} (${latest.cacheEfficiencyPct}% cache reuse)`,
        `- **Total Turn Prompt:** ${formatNumber(latest.promptTokens)}`,
        `- **Turn Output Tokens:** ${formatNumber(latest.outputTokens)}`,
        `  - **Thinking / Reasoning:** ${formatNumber(latest.thinkingTokens)} tokens`,
        `  - **Response & Tools:** ${formatNumber(latest.responseTokens)} tokens`
      );
    }

    output.push(
      ``,
      `#### Session Cumulative (${cum.totalTurns} turns):`,
      `- **Total Ingested:** ${formatNumber(cum.inputTokens)} new inputs + ${formatNumber(cum.cacheReadTokens)} cache reads`,
      `- **Total Generated:** ${formatNumber(cum.outputTokens)} (${formatNumber(cum.thinkingTokens)} thinking + ${formatNumber(cum.responseTokens)} response)`,
      `- **Total Processed:** ${formatNumber(cum.totalProcessedTokens)} tokens`,
      `- **Overall Cache Savings:** ${cum.overallCacheSavingsPct}% cache hit rate`
    );

    return {
      content: [
        {
          type: 'text',
          text: output.join('\n')
        }
      ]
    };
  }

  if (name === 'get_turn_history') {
    const limit = Math.max(1, Math.min(50, parseInt(args?.limit || 10, 10)));
    const viewMode = args?.view === 'step' ? 'step' : 'prompt';

    if (viewMode === 'prompt') {
      const recentPrompts = (telemetry.recentPrompts || telemetry.prompts || []).slice(0, limit);
      let rows = [
        `| Prompt | Calls | Model Routing | New Input | Cache Read | Thinking | Output | Ending Context | Cache % |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`
      ];

      recentPrompts.forEach(p => {
        const modelsRouting = p.modelsRoutingPath || p.modelsUsedShort?.join(' → ') || 'Flash';
        rows.push(
          `| #${p.promptNumber} | ${p.llmCallsCount} call${p.llmCallsCount === 1 ? '' : 's'} | ${modelsRouting} | ${formatNumber(p.newInput)} | ${formatNumber(p.cacheRead)} | ${formatNumber(p.thinking)} | ${formatNumber(p.output)} | ${formatNumber(p.endingContext)} (${p.endingContextPct}%) | ${p.cacheEfficiencyPct}% |`
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `### 📜 Prompt-Grouped Telemetry Log (Last ${recentPrompts.length} Prompts)\n\n` + rows.join('\n')
          }
        ]
      };
    } else {
      const recent = (telemetry.recentTurns || []).slice(0, limit);
      let rows = [
        `| Turn | Steps | Model | New Input | Cache Read | Thinking | Output | Total Turn | Cache % |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`
      ];

      recent.forEach(t => {
        const steps = t.stepIndices?.length ? t.stepIndices.join('→') : '-';
        const modelLabel = t.modelShortName || t.modelDisplayName || 'Flash';
        rows.push(
          `| #${t.turnNumber} | ${steps} | ${modelLabel} | ${formatNumber(t.inputTokens)} | ${formatNumber(t.cacheReadTokens)} | ${formatNumber(t.thinkingTokens)} | ${formatNumber(t.outputTokens)} | ${formatNumber(t.totalTurnTokens)} | ${t.cacheEfficiencyPct}% |`
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `### 📜 Per-Step Telemetry Log (Last ${recent.length} Steps)\n\n` + rows.join('\n')
          }
        ]
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let reqId = null;
  try {
    const req = JSON.parse(trimmed);
    reqId = req.id !== undefined ? req.id : null;

    if (req.method === 'initialize') {
      sendResponse(reqId, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'token-context-meter',
          version: '1.0.0'
        }
      });
      return;
    }

    if (req.method === 'notifications/initialized') {
      // Notification, no reply needed
      return;
    }

    if (req.method === 'tools/list') {
      sendResponse(reqId, { tools: TOOLS });
      return;
    }

    if (req.method === 'tools/call') {
      const { name, arguments: toolArgs } = req.params || {};
      try {
        const result = await handleToolCall(name, toolArgs);
        sendResponse(reqId, result);
      } catch (toolErr) {
        sendError(reqId, -32603, `Tool execution error: ${toolErr.message}`);
      }
      return;
    }

    if (req.id !== undefined) {
      sendError(reqId, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    console.error('MCP Server error:', err);
    try {
      sendError(reqId, -32700, `Parse error: ${err.message}`);
    } catch {}
  }
});
