# Token & Context Meter

A high-precision telemetry and context window meter plugin for Google Antigravity Desktop.

It connects directly to the local language server RPC endpoint to deliver exact, server-side token accounting and live context window consumption for active conversations without client-side text tokenizer approximations.

---

## Overview

Most token meters approximate token counts by running character heuristics or client-side tokenizers (such as `tiktoken`) against visible chat text. These approximations fail to capture:

- Hidden internal reasoning and thinking tokens
- System prompts and model developer instructions
- Tool invocation schemas, arguments, and return payloads
- Exact prompt cache reuse boundaries and cache hit ratios
- Dynamic context compaction and checkpointing events

Token & Context Meter eliminates guesswork by querying Antigravity Desktop's running local language server directly over Connect RPC, providing ground-truth telemetry identical to the CLI `/context` command.

---

## Key Metrics

### Live Context Window
- **Active Tokens**: Exact token volume currently occupying the context window.
- **Limit & Capacity**: Active model ceiling (for example, 1,048,576 tokens) with percentage consumption.
- **Headroom**: Remaining token headroom before reaching compaction or context window exhaustion.

### Per-Turn Breakdown
- **New Input Tokens**: Fresh prompt tokens ingested during the turn.
- **Cache Read Tokens**: Pre-cached tokens served from prompt cache, alongside the cache efficiency percentage.
- **Generation Output**: Split into internal reasoning/thinking tokens and final response or tool call tokens.

### Model Routing
- **Routed Model Identification**: Displays the exact model assigned per turn (for example, Gemini 3.8 Flash High, Gemini Pro, Argon).
- **Multi-Model Session Tracking**: Flags multi-model conversations and displays routing paths across steps.

### Cumulative Session Totals
- **Processed Volume**: Cumulative sum of all input, cache read, output, and reasoning tokens across the entire session.
- **Overall Re-use Rate**: Aggregate prompt caching efficiency.
- **Compaction Detection**: Tracks checkpointing events when earlier turns are summarized to reclaim context space.

---

## User Interface: Cardless Editorial Ledger

The sidecar user interface follows a cardless editorial ledger layout designed for clarity and information density in desktop side panels:

- **Obsidian Theme**: Minimalist dark background (`#0e0f12`) with hairline dividers (`#1a1d24`) instead of heavy card containers.
- **Tabular Figures**: Set in Plus Jakarta Sans and JetBrains Mono with tabular numbers (`tabular-nums`) to prevent layout shift during live updates.
- **Window Utilization Header**: Large percentage headline with a 4px dynamic capacity bar (optimal, moderate, critical thresholds) and active/remaining token figures.
- **Active Turn Key-Value Ledger**: Clear hierarchical breakdown of prompt inputs and generation outputs.
- **Session Totals**: High-level processed volume and cumulative cache reuse rates.
- **Telemetry Section with Dual Views**:
  - **By Prompt**: Aggregates internal tool loops and model calls between user message boundaries. Shows sequential prompt numbers, preview text, internal call count, model routing chain, token sums, and ending context window consumption.
  - **By Step**: Granular per-step ledger showing individual LLM calls, step indices, routed model badges, input/cache/thinking breakdowns, and turn totals.
- **Actions**:
  - Live pulse indicator reflecting 2.5-second polling intervals.
  - Quick-copy `/context` button that places a clean Markdown summary on the clipboard.
  - Manual telemetry refresh trigger.

---

## Plugin Architecture

The plugin is structured into three integrated components:

```
token-context-meter/
├── plugin.json                 # Antigravity plugin manifest
├── mcp_config.json             # MCP server registration
├── assets/
│   └── logo.svg                # Plugin vector emblem
├── sidecars/
│   └── meter/
│       ├── sidecar.json        # Sidecar auxiliary pane configuration
│       ├── index.html          # Editorial ledger dashboard
│       ├── styles.css          # Cardless styling and typography
│       ├── app.js              # Real-time dashboard controller
│       ├── server.js           # Sidecar bootstrap loader
│       ├── main.mjs            # Sidecar SDK and HTTP fallback router
│       └── telemetry.mjs       # Connect RPC client and credentials resolver
├── mcp/
│   └── server.mjs              # Model Context Protocol stdio server
└── skills/
    └── context/
        └── SKILL.md            # /context slash command definition
```

### 1. Auxiliary Sidecar (`sidecars/meter`)
Runs as a background process and renders in Antigravity Desktop's auxiliary side panel (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`). It exposes endpoints for real-time telemetry (`/api/tokens`) and model specifications (`/api/models`).

### 2. MCP Server (`mcp/server.mjs`)
Implements the Model Context Protocol over stdio (`JSON-RPC 2.0`), exposing two tools:
- `get_token_context`: Returns live context metrics, active turn breakdown, and session totals.
- `get_turn_history`: Returns historical logs supporting both `prompt` and `step` aggregation modes.

### 3. Skill (`skills/context/SKILL.md`)
Defines the `/context` command in chat, enabling interactive queries directly within conversation threads.

---

## Installation & Configuration

### Prerequisites
- Google Antigravity Desktop (version 1.15.0 or later)
- Node.js (version 18 or later)

### Directory Setup
Clone or place the plugin directory into your Antigravity plugins directory:

```bash
git clone https://github.com/BlueNebula-Dev/token-context-meter.git ~/.gemini/config/plugins/token-context-meter
```

### Registration
Enable the plugin and register the sidecar in `~/.gemini/config/config.json`:

```json
{
  "plugins": {
    "token-context-meter": {
      "enabled": true
    }
  },
  "sidecars": {
    "token-context-meter/meter": {
      "enabled": true,
      "schemaVersion": 1,
      "resolvedPermissions": {}
    }
  }
}
```

Restart Antigravity Desktop to load the plugin and sidecar.

---

## Usage

### In the Side Panel
Click the sidecar icon or open `sidecar://token-context-meter/meter/` to display the real-time ledger. Use the `By Prompt` and `By Step` tabs in the Telemetry section to switch between prompt-level summaries and individual call traces.

### In Chat
Type `/context` or ask about token consumption to retrieve an instant report directly in your chat stream.

---

## License

MIT License. See LICENSE for details.
