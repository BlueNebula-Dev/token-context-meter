---
name: context
description: Tracks exact server-side token usage per AI turn and live context window consumption for the active chat, matching the accuracy of Antigravity CLI's /context command. Use when the user asks about context usage, token count, context window limits, prompt caching, or triggers /context.
---

# /context: Token & Context Window Meter

This skill inspects exact, server-side telemetry from the active conversation without client-side approximation or token estimation. It matches the accuracy of the Antigravity CLI `/context` command.

## How to Check Token Usage & Context

When the user asks for `/context` or inquires about current token usage, follow these steps:

1. **Query Telemetry**:
   Call the `token-context-meter` MCP tool `get_token_context`:
   - If available via MCP: call `get_token_context`.
   - If MCP is lazy-loaded or not yet initialized in the current turn, you can run the quick Node one-liner:
     ```bash
     node -e "const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),url=require('node:url');const p=[path.resolve('sidecars/meter/telemetry.mjs'),path.join(os.homedir(),'.gemini','config','plugins','token-context-meter','sidecars','meter','telemetry.mjs')].find(fs.existsSync);import(url.pathToFileURL(p).href).then(m=>m.getConversationTokenTelemetry()).then(t=>console.log(JSON.stringify(t,null,2)))"
     ```

2. **Present Metrics to the User**:
   Structure your response with:
   - **Active Model & Limits**: Active model name (e.g. Gemini 3.8 Flash High) and max context window (e.g. 1,048,576 tokens).
   - **Live Context Window**: Exact tokens currently occupying the context window (`activeTokens / maxLimit`) and consumption percentage (`consumptionPct%`), plus remaining headroom.
   - **Latest AI Turn**:
     - **New Input Tokens**: Fresh un-cached prompt tokens ingested.
     - **Cache Read Tokens**: Prompt tokens served from cache, along with the Cache Reuse Percentage (`cacheEfficiencyPct%`).
     - **Output Tokens Breakdown**: Total generated tokens, broken down into internal reasoning/thinking tokens (`thinkingTokens`) and visible response/tool tokens (`responseTokens`).
   - **Cumulative Session Totals**: Total processed tokens, total turns, and overall cache savings across the entire conversation.
   - **Compaction Status**: Note whether conversation history has undergone compaction/checkpointing.

3. **Sidecar Visual Dashboard**:
   Inform the user that they can also view real-time live graphs, gauges, and historical telemetry logs in the **Context Meter** sidecar panel docked in the desktop application's auxiliary sidebar.
   The dashboard includes a view toggle (`By Prompt` | `By Step`):
   - **By Prompt**: Aggregates internal loops between user message boundaries, showing the user message index, call count, model routing path (e.g. `Argon → Flash`), cumulative prompt tokens, and ending context window size.
   - **By Step**: Granular per-step breakdown showing the exact model badge, new inputs, cache reads, thinking tokens, and total turn tokens for each LLM invocation.
