#!/usr/bin/env node
/**
 * callme-mcp/server.js — MCP server exposing CallMe Bot as tools for Claude Code.
 *
 * Tools:
 *   callme_dial(target, from?)       — make an outbound call
 *   callme_hangup(callId)            — hang up a call
 *   callme_calls()                   — list active calls
 *   callme_speak(text, voice?, lang?) — TTS: speak text via Gemini Live voice
 *   callme_notify(text)              — convenience: TTS notification (no call needed)
 *   callme_status()                  — get CallMe Bot connection status
 *
 * Configuration (env vars or .env):
 *   CALLME_URL        — base URL of CallMe Bot (e.g. http://10.0.0.4:3101)
 *   CALLME_USER       — admin username (default: admin)
 *   CALLME_PASS       — admin password
 *
 * Usage in .mcp.json:
 *   { "command": "node", "args": ["/path/to/callme-mcp/server.js"] }
 */

const http = require('http');
const https = require('https');
const readline = require('readline');

const CALLME_URL = (process.env.CALLME_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const CALLME_USER = process.env.CALLME_USER || process.env.ADMIN_USER || 'admin';
const CALLME_PASS = process.env.CALLME_PASS || process.env.ADMIN_PASS || '';

function authHeader() {
  if (!CALLME_PASS) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${CALLME_USER}:${CALLME_PASS}`).toString('base64') };
}

function callmeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(CALLME_URL + path);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...authHeader(),
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 15000,
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── MCP protocol helpers ─────────────────────────────────────────────────

function mcpResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function mcpError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Tool definitions ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'callme_dial',
    description: 'Make an outbound phone/SIP call via CallMe Bot. Returns a callId you can use to hang up.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Phone number (05XXXXXXXX) or SIP URI (sip:ext@domain)' },
        from: { type: 'string', description: 'Caller ID / SIP extension (optional, uses default if omitted)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'callme_hangup',
    description: 'Hang up an active call by callId.',
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string', description: 'Call ID returned by callme_dial' },
      },
      required: ['callId'],
    },
  },
  {
    name: 'callme_calls',
    description: 'List all currently active calls.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'callme_speak',
    description: 'Convert text to speech using CallMe Bot (Gemini Live voice). Returns audio played on server — useful for testing TTS or sending voice notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        voice: { type: 'string', description: 'Voice name (e.g. Kore, Puck, Aoede) — default: Kore' },
        language: { type: 'string', description: 'Language code (e.g. he, en) — default: he' },
      },
      required: ['text'],
    },
  },
  {
    name: 'callme_notify',
    description: 'Send a voice notification via CallMe Bot TTS. Convenience wrapper for callme_speak with Hebrew defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Notification text (Hebrew or English)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'callme_status',
    description: 'Get CallMe Bot connection status (drachtio, SIP registration, integrations).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case 'callme_dial': {
      const r = await callmeRequest('POST', '/call', { to: args.target, ...(args.from ? { callerId: args.from } : {}) });
      if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
      return `Call initiated. callId: ${r.data.callId}`;
    }
    case 'callme_hangup': {
      const r = await callmeRequest('DELETE', `/call/${encodeURIComponent(args.callId)}`, null);
      if (r.status === 404) throw new Error('Call not found — it may have already ended');
      if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
      return 'Call ended.';
    }
    case 'callme_calls': {
      const r = await callmeRequest('GET', '/api/calls', null);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const calls = r.data.calls || [];
      if (!calls.length) return 'No active calls.';
      return calls.map(c => `• ${c.callId}: ${c.to} (${c.durationS}s)`).join('\n');
    }
    case 'callme_speak':
    case 'callme_notify': {
      const text = args.text;
      const voice = args.voice || 'Kore';
      const language = args.language || 'he';
      const r = await callmeRequest('POST', '/api/tts', { text, voice, language });
      if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
      return `TTS generated: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`;
    }
    case 'callme_status': {
      const r = await callmeRequest('GET', '/api/status', null);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const s = r.data;
      const sipRegs = Object.keys(s.sip || {}).join(', ') || 'none';
      const ints = Object.entries(s.integrations || {})
        .map(([k, v]) => `${k}: ${v.ok === null ? 'not configured' : v.ok ? 'OK' : 'FAIL'}`)
        .join(', ');
      return `drachtio: ${s.drachtio}\nSIP registrations: ${sipRegs}\nProvider: ${s.sipProvider}\n${ints ? 'Integrations: ' + ints : ''}`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP stdin/stdout loop ─────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      process.stdout.write(mcpResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'callme-mcp', version: '1.0.0' },
      }) + '\n');
    } else if (method === 'tools/list') {
      process.stdout.write(mcpResponse(id, { tools: TOOLS }) + '\n');
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      try {
        const result = await handleTool(name, args || {});
        process.stdout.write(mcpResponse(id, { content: [{ type: 'text', text: result }] }) + '\n');
      } catch (err) {
        process.stdout.write(mcpResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        }) + '\n');
      }
    } else if (method === 'notifications/initialized') {
      // no-op
    } else {
      process.stdout.write(mcpError(id, -32601, `Method not found: ${method}`) + '\n');
    }
  } catch (err) {
    process.stdout.write(mcpError(id, -32603, err.message) + '\n');
  }
});

process.stderr.write(`CallMe MCP server started. CALLME_URL=${CALLME_URL}\n`);
