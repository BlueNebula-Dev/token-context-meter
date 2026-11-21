/**
 * Token & Context Meter - Sidecar Backend.
 *
 * Runs as a native Antigravity sidecar docked inside the auxiliary panel.
 * Serves the interactive telemetry dashboard and provides live token metrics.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConversationTokenTelemetry, getModelLimits } from './telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript']
};

let SidecarApp = null;
let SidecarResponse = null;

try {
  const sdk = await import('sidecar_sdk');
  SidecarApp = sdk.SidecarApp;
  SidecarResponse = sdk.Response;
} catch {
  // If bare specifier didn't resolve directly, try direct path to central SDK
  try {
    const directSdk = await import('file:///C:/Users/Gian/.gemini/config/node_modules/sidecar_sdk/index.mjs');
    SidecarApp = directSdk.SidecarApp;
    SidecarResponse = directSdk.Response;
  } catch (err) {
    console.warn('Sidecar SDK not found, using standalone HTTP server fallback.');
  }
}

// Check if running inside Antigravity sidecar environment
const hasSidecarEnv = Boolean(
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
);

if (SidecarApp && hasSidecarEnv) {
  // --- RUN VIA OFFICIAL SIDECAR SDK ---
  const app = new SidecarApp();

  app.page('/', () => {
    return readFileSync(join(__dirname, 'index.html'), 'utf-8');
  });

  for (const [route, [file, mimeType]] of Object.entries(STATIC_FILES)) {
    app.api(route, () => {
      const content = readFileSync(join(__dirname, file), 'utf-8');
      return new SidecarResponse(content, { contentType: mimeType });
    }, 'GET');
  }

  app.api('/api/tokens', async (data) => {
    try {
      const convId = data?.conversationId || null;
      return await getConversationTokenTelemetry(convId);
    } catch (err) {
      return { error: err.message };
    }
  }, 'GET');

  app.api('/api/models', async () => {
    try {
      return await getModelLimits();
    } catch (err) {
      return { error: err.message };
    }
  }, 'GET');

  app.run();
  console.log(`[TokenContextMeter] Sidecar initialized on port ${process.env.ANTIGRAVITY_SIDECAR_WEB_PORT}`);
} else {
  // --- RUN VIA STANDALONE HTTP SERVER FALLBACK ---
  const port = parseInt(process.env.PORT || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '51337', 10);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
      return;
    }

    if (STATIC_FILES[url.pathname]) {
      const [file, mime] = STATIC_FILES[url.pathname];
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      res.end(readFileSync(join(__dirname, file), 'utf-8'));
      return;
    }

    if (url.pathname === '/api/tokens') {
      try {
        const convId = url.searchParams.get('conversationId') || null;
        const telemetry = await getConversationTokenTelemetry(convId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(telemetry));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/models') {
      try {
        const models = await getModelLimits();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[TokenContextMeter] Standalone server running at http://127.0.0.1:${port}`);
  });
}
