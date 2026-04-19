'use strict';
/**
 * Callme HTTP API Server
 * - REST API for call management + health
 * - Integrates with 3CX, Whisper, TTS, BrainMode
 * - Serves dashboard UI
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
const { ThreeCXClient } = require('./lib/threecx');
const { AudioServer } = require('./audio/ws-server');
const { AudioInjector } = require('./audio/audio-injector');
const { PersonaManager } = require('./personas/persona-manager');
const { CallHandler } = require('./call/call-handler');
const { BrainMode } = require('./ocplatform/brain-mode');

const env = loadEnv();
const threecx = new ThreeCXClient(env);
const personas = new PersonaManager();
const brain = new BrainMode();

const HOST = env.HOST || '0.0.0.0';
const PORT = parseInt(env.PORT || '3101', 10);
const AUDIO_WS_PORT = parseInt(env.AUDIO_WS_PORT || '3001', 10);
const AUDIO_HTTP_PORT = parseInt(env.AUDIO_HTTP_PORT || '3002', 10);
const PUBLIC_DIR = path.join(__dirname, '../public');

// Runtime token override
let runtimeToken = env.THREECX_API_TOKEN || '';
if (runtimeToken) threecx._token = runtimeToken;

// Active call handlers: callId → CallHandler
const callHandlers = new Map();

// Audio injector for TTS playback
const audioInjector = new AudioInjector({
  port: AUDIO_HTTP_PORT,
  publicUrl: env.CALLME_PUBLIC_URL || `http://${env.PUBLIC_IP || 'localhost'}:${AUDIO_HTTP_PORT}`,
});
audioInjector.start();

function getOrCreateHandler(callId) {
  if (!callHandlers.has(callId)) {
    const extension = env.THREECX_EXTENSION || '9000';
    const persona = personas.getByExtension(extension) || personas.getAll()[0];
    const handler = new CallHandler({ persona, threecx, brain, audioInjector });

    handler.on('transcript', ({ callId, text }) => {
      console.log(`[Server] [${callId}] transcript: ${text}`);
    });
    handler.on('spoke', ({ callId, text, audioUrl }) => {
      console.log(`[Server] [${callId}] spoke: ${text.slice(0, 60)} [${audioUrl || 'no URL'}]`);
    });
    handler.on('summary', ({ callId, summary }) => {
      console.log(`[Server] [${callId}] summary: ${summary}`);
    });

    callHandlers.set(callId, handler);
  }
  return callHandlers.get(callId);
}

// Start WebSocket audio server
const audioServer = new AudioServer({ port: AUDIO_WS_PORT });
audioServer.on('transcript', ({ callId, text }) => {
  getOrCreateHandler(callId).onTranscript({ callId, text });
});
audioServer.on('call:end', ({ callId }) => {
  const handler = callHandlers.get(callId);
  if (handler) {
    handler.onCallEnd(callId).then(() => callHandlers.delete(callId));
  }
});
audioServer.start();

// Helpers
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- Static files ---
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(indexPath));
    } else {
      sendJSON(res, 200, { name: 'callme', version: '1.0.0', status: 'running' });
    }
    return;
  }

  // --- Health ---
  if (pathname === '/health') {
    let activeCalls = 0;
    try {
      const calls = await threecx.getActiveCalls();
      activeCalls = calls?.value?.length || 0;
    } catch {}
    sendJSON(res, 200, {
      ok: true,
      service: 'callme',
      uptime: Math.floor(process.uptime()),
      host: env.THREECX_HOST,
      extension: env.THREECX_EXTENSION,
      activeCalls,
      activeHandlers: callHandlers.size,
      audioWs: `ws://0.0.0.0:${AUDIO_WS_PORT}`,
      brain: brain.isAvailable(),
    });
    return;
  }

  // --- Auth: set token ---
  if (pathname === '/api/token' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (body.token) {
        runtimeToken = body.token;
        threecx._token = body.token;
        sendJSON(res, 200, { ok: true });
      } else {
        sendJSON(res, 400, { error: 'Missing token' });
      }
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  // --- Auth: login ---
  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (body.username) threecx.user = body.username;
      if (body.password) threecx.password = body.password;
      const token = await threecx._getToken();
      if (token) {
        runtimeToken = token;
        sendJSON(res, 200, { ok: true, authMode: 'oauth' });
      } else {
        sendJSON(res, 401, { error: 'Login failed' });
      }
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // --- Calls: list ---
  if (pathname === '/calls' && req.method === 'GET') {
    sendJSON(res, 200, await threecx.getActiveCalls());
    return;
  }

  // --- Calls: make ---
  if (pathname === '/calls' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      sendJSON(res, 200, await threecx.makeCall(body.destination, body.audioUrl));
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  // --- Calls: hangup ---
  const hangupMatch = pathname.match(/^\/calls\/([^/]+)$/);
  if (hangupMatch && req.method === 'DELETE') {
    sendJSON(res, 200, await threecx.hangupCall(hangupMatch[1]));
    return;
  }

  // --- Personas ---
  if (pathname === '/api/personas' && req.method === 'GET') {
    sendJSON(res, 200, personas.getAll());
    return;
  }

  if (pathname === '/api/personas' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      personas.save(body);
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  // --- Active handlers ---
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const sessions = [];
    for (const [callId, handler] of callHandlers) {
      sessions.push({
        callId,
        activeCalls: handler.getActiveCalls(),
        transcriptCount: handler.getTranscript(callId).length,
      });
    }
    sendJSON(res, 200, sessions);
    return;
  }

  // --- Transcript for a call ---
  const transcriptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch && req.method === 'GET') {
    const handler = callHandlers.get(transcriptMatch[1]);
    sendJSON(res, handler ? 200 : 404, handler
      ? handler.getTranscript(transcriptMatch[1])
      : { error: 'Not found' }
    );
    return;
  }

  // --- Chat test endpoint ---
  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { callId = 'test', text, persona: p } = body;
      const persona = p || personas.getAll()[0] || {};
      const response = await brain.think(callId, text, persona);
      sendJSON(res, 200, { response, callId });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`\n🎙️  Callme server running`);
  console.log(`   HTTP API:  http://${HOST}:${PORT}`);
  console.log(`   Audio WS:  ws://${HOST}:${AUDIO_WS_PORT}`);
  console.log(`   Brain:     ${brain.gatewayUrl}`);
  console.log(`   Audio HTTP: http://${HOST}:${AUDIO_HTTP_PORT}`);
  console.log(`   3CX host:  ${env.THREECX_HOST}`);
  console.log('');
});
