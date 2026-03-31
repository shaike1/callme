const express = require('express');
const path = require('path');
const fs = require('fs');
const Srf = require('drachtio-srf');
const Mrf = require('drachtio-fsmrf');
const CallHandler = require('./call-handler');
const SessionManager = require('./session-manager');
const SttTtsManager = require('./stt-tts-manager');
const MetricsCollector = require('./metrics');
const MultiRegistrar = require('./multi-registrar');
const AudioForkServer = require('./audio-fork-server');
const logger = require('./logger');
const config = require('./config');

const WS_PORT = parseInt(process.env.WS_PORT || '3001');
const AUDIO_DIR = process.env.AUDIO_DIR || '/tmp/voice-worker-audio';

// Ensure audio directory exists
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const app = express();
const srf = new Srf();
const mrf = new Mrf(srf);

// Start shared audio fork server immediately
const audioForkServer = new AudioForkServer({ port: WS_PORT });
audioForkServer.start();

// Initialize managers
const sessionManager = new SessionManager();
const sttTtsManager = new SttTtsManager();
const metrics = new MetricsCollector();
const callHandler = new CallHandler(srf, sessionManager, sttTtsManager, metrics, audioForkServer, {
  audioDir: AUDIO_DIR,
  audioPort: config.healthPort,
});

// Serve audio files so FreeSWITCH can fetch them via HTTP
app.use('/audio', express.static(AUDIO_DIR));

// ── Basic auth for dashboard & API ───────────────────────────────────────
// Credentials resolved at request time so dashboard changes take effect immediately
function getAdminCreds() {
  // botSettings overrides env vars (so dashboard-set password wins)
  const user = (botSettings && botSettings.adminUser) || process.env.ADMIN_USER || 'admin';
  const pass = (botSettings && botSettings.adminPass) || process.env.ADMIN_PASS || 'callme2024';
  return { user, pass };
}

function requireAuth(req, res, next) {
  // Skip auth for health/ready/metrics (used by infra) and audio (FreeSWITCH)
  if (['/health', '/ready', '/metrics'].includes(req.path) || req.path.startsWith('/audio/')) {
    return next();
  }
  const { user: ADMIN_USER, pass: ADMIN_PASS } = getAdminCreds();
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="CallMe Bot Dashboard"');
  res.status(401).send('Authentication required');
}
app.use(requireAuth);

// Serve dashboard
app.use('/', express.static(path.join(__dirname, 'public')));

// In-memory log ring buffer for dashboard /api/logs
const LOG_RING = [];
const LOG_RING_MAX = 500;
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const line = typeof chunk === 'string' ? chunk.trim() : chunk.toString().trim();
  if (line) {
    LOG_RING.push({ _ts: Date.now(), line });
    if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
  }
  return origWrite(chunk, ...args);
};

// Health endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/ready', (req, res) => {
  const ready = srf.isConnected;
  res.status(ready ? 200 : 503).json({
    ready,
    timestamp: new Date().toISOString(),
    drachtioConnected: ready
  });
});

app.get('/metrics', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    stats: metrics.getStats()
  });
});

app.get('/api/logs', (req, res) => {
  const since = parseInt(req.query.since || '0');
  const lines = LOG_RING.filter(e => e._ts > since);
  res.setHeader('Content-Type', 'text/plain');
  res.send(lines.map(e => {
    try {
      const obj = JSON.parse(e.line);
      return JSON.stringify({ ...obj, _ts: e._ts });
    } catch (_) {
      return JSON.stringify({ message: e.line, _ts: e._ts });
    }
  }).join('\n'));
});

app.use(express.json());

// ── Bot Settings (persisted to settings.json) ────────────────────────────
const SETTINGS_FILE = path.join(AUDIO_DIR, '..', 'bot-settings.json');

const defaultSettings = {
  name: 'CallMe Bot',
  persona: process.env.GEMINI_SYSTEM_PROMPT ||
    'You are a helpful voice assistant named CallMe Bot. The caller speaks Hebrew. Always respond in Hebrew.',
  language: process.env.CALL_LANGUAGE || 'he',
  extension: process.env.SIP_EXTENSION || '12611',
  greeting: 'שלום! ברך את המשתמש בקצרה בעברית.',
  voice: 'Kore',
  // SIP trunk config (optional — overrides env vars when set)
  sipProvider: '',       // '3cx' | 'zadarma' | 'twilio' | 'custom'
  sipServer: process.env.SIP_DOMAIN || '',
  sipRegistrar: process.env.SIP_REGISTRAR || '',
  sipExtension: process.env.SIP_EXTENSION || '',
  sipAuthId: process.env.SIP_AUTH_ID || '',
  sipPassword: '',       // never stored in plaintext after first load
  sipDid: '',            // DID phone number (e.g. +972XXXXXXXXX)
  // Admin credentials (override ADMIN_USER / ADMIN_PASS env vars when set)
  adminUser: '',
  adminPass: '',
};

let botSettings = { ...defaultSettings };
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    botSettings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    logger.info('Loaded bot settings from file');
  }
} catch (_) {}

const saveSettings = () => {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 2)); } catch (_) {}
};

// Export settings so call-handler can read them
global.botSettings = botSettings;

app.get('/api/settings', (req, res) => {
  const { user: adminUser } = getAdminCreds();
  res.json({
    ...botSettings,
    sipPassword: botSettings.sipPassword ? '✓ set' : '',
    adminPass: botSettings.adminPass ? '✓ set' : '',
    adminUser: botSettings.adminUser || adminUser,
  });
});

app.post('/api/settings', (req, res) => {
  const { name, persona, language, extension, greeting, voice,
          sipProvider, sipServer, sipRegistrar, sipExtension, sipAuthId, sipPassword, sipDid,
          adminUser, adminPass } = req.body || {};
  if (name !== undefined) botSettings.name = name;
  if (persona !== undefined) botSettings.persona = persona;
  if (language !== undefined) botSettings.language = language;
  if (extension !== undefined) botSettings.extension = extension;
  if (greeting !== undefined) botSettings.greeting = greeting;
  if (voice !== undefined) botSettings.voice = voice;
  if (sipProvider !== undefined) botSettings.sipProvider = sipProvider;
  if (sipServer !== undefined) botSettings.sipServer = sipServer;
  if (sipRegistrar !== undefined) botSettings.sipRegistrar = sipRegistrar;
  if (sipExtension !== undefined) botSettings.sipExtension = sipExtension;
  if (sipAuthId !== undefined) botSettings.sipAuthId = sipAuthId;
  if (sipPassword !== undefined && sipPassword !== '') botSettings.sipPassword = sipPassword;
  if (sipDid !== undefined) botSettings.sipDid = sipDid;
  if (adminUser !== undefined && adminUser !== '') botSettings.adminUser = adminUser;
  if (adminPass !== undefined && adminPass !== '') botSettings.adminPass = adminPass;
  saveSettings();
  logger.info('Bot settings updated', { ...botSettings, sipPassword: '***', adminPass: '***' });
  // Return settings without exposing passwords
  res.json({ success: true, settings: {
    ...botSettings,
    sipPassword: botSettings.sipPassword ? '✓ set' : '',
    adminPass: botSettings.adminPass ? '✓ set' : '',
  }});
});

// ── Integrations (teamy, openclaw, home assistant) ───────────────────────
const INTEGRATIONS_FILE = path.join(AUDIO_DIR, '..', 'integrations.json');

const defaultIntegrations = {
  teamy: { enabled: false, url: '', token: '' },
  openclaw: { enabled: false, url: '', token: '' },
  ha: { enabled: false, url: '', token: '', webhookId: '' },
};

let integrations = { ...defaultIntegrations };
try {
  if (fs.existsSync(INTEGRATIONS_FILE)) {
    integrations = { ...defaultIntegrations, ...JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf8')) };
    logger.info('Loaded integrations from file');
  }
} catch (_) {}

const saveIntegrations = () => {
  try { fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(integrations, null, 2)); } catch (_) {}
};

global.integrations = integrations;

app.get('/api/integrations', (req, res) => {
  // Mask tokens in response
  const masked = JSON.parse(JSON.stringify(integrations));
  if (masked.teamy?.token) masked.teamy.token = '✓ set';
  if (masked.openclaw?.token) masked.openclaw.token = '✓ set';
  if (masked.ha?.token) masked.ha.token = '✓ set';
  res.json(masked);
});

app.post('/api/integrations', (req, res) => {
  const { teamy, openclaw, ha } = req.body || {};
  if (teamy) {
    integrations.teamy = { ...integrations.teamy, ...teamy };
    if (!teamy.token) delete integrations.teamy.token;
  }
  if (openclaw) {
    integrations.openclaw = { ...integrations.openclaw, ...openclaw };
    if (!openclaw.token) delete integrations.openclaw.token;
  }
  if (ha) {
    integrations.ha = { ...integrations.ha, ...ha };
    if (!ha.token) delete integrations.ha.token;
  }
  saveIntegrations();
  global.integrations = integrations;
  logger.info('Integrations updated');
  res.json({ success: true });
});

app.post('/api/integrations/test/:name', async (req, res) => {
  const name = req.params.name;
  const cfg = integrations[name === 'ha' ? 'ha' : name];
  if (!cfg?.url) return res.json({ ok: false, error: 'URL לא מוגדר' });
  try {
    const testUrl = name === 'teamy' ? cfg.url + '/api/bots' :
                    name === 'openclaw' ? cfg.url + '/health' :
                    cfg.url + '/api/config'; // HA
    const resp = await new Promise((resolve, reject) => {
      const urlObj = new URL(testUrl);
      const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
      const options = { hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80), path: urlObj.pathname, method: 'GET', timeout: 5000 };
      if (cfg.token && cfg.token !== '✓ set') options.headers = { Authorization: `Bearer ${cfg.token}` };
      const req2 = mod.request(options, r => resolve({ status: r.statusCode }));
      req2.on('error', reject);
      req2.on('timeout', () => reject(new Error('timeout')));
      req2.end();
    });
    if (resp.status < 500) res.json({ ok: true, status: resp.status });
    else res.json({ ok: false, error: `HTTP ${resp.status}` });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Home Assistant helper ─────────────────────────────────────────────────
async function callHaService(domain, service, serviceData) {
  const cfg = integrations.ha;
  if (!cfg?.enabled || !cfg?.url || !cfg?.token) return { ok: false, error: 'HA not configured' };
  const payload = JSON.stringify(serviceData || {});
  const urlStr = `${cfg.url.replace(/\/$/, '')}/api/services/${domain}/${service}`;
  const urlObj = new URL(urlStr);
  const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve) => {
    const opts = {
      hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname, method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000
    };
    const req2 = mod.request(opts, r => { r.resume(); resolve({ ok: r.statusCode < 300 }); });
    req2.on('error', e => resolve({ ok: false, error: e.message }));
    req2.on('timeout', () => resolve({ ok: false, error: 'timeout' }));
    req2.write(payload); req2.end();
  });
}
global.callHaService = callHaService;

// POST /api/ha/action — proxy to HA service call (used by external integrations or tests)
app.post('/api/ha/action', async (req, res) => {
  const { domain, service, serviceData } = req.body || {};
  if (!domain || !service) return res.status(400).json({ error: 'domain and service required' });
  const result = await callHaService(domain, service, serviceData);
  res.json(result);
});

// POST /api/ha/webhook — HA calls this to trigger CallMe Bot to make an outbound call
app.post('/api/ha/webhook', async (req, res) => {
  const cfg = integrations.ha;
  const { to, callerId, webhookId } = req.body || {};
  if (cfg?.webhookId && webhookId !== cfg.webhookId) {
    return res.status(403).json({ error: 'invalid webhook id' });
  }
  if (!to) return res.status(400).json({ error: 'missing "to"' });
  const from = callerId || process.env.SIP_EXTENSION || '12611';
  const target = `sip:${to}@${process.env.SIP_DOMAIN || '127.0.0.1'}`;
  logger.info('HA webhook: outbound call', { to, target });
  try {
    const { dialog } = await callHandler.makeOutboundCall(target, from);
    res.json({ success: true, callId: dialog.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TTS endpoint — text → WAV audio (for teamy / external integrations) ─
app.post('/api/tts', async (req, res) => {
  const { text, voice, language } = req.body || {};
  if (!text) return res.status(400).json({ error: 'missing "text"' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const GeminiLiveSession = require('./gemini-live/session');
  const session = new GeminiLiveSession({
    callId: `tts-${Date.now()}`,
    apiKey,
    systemPrompt: 'You are a text-to-speech engine. Speak exactly and only what the user sends, verbatim. Do not add anything.',
    language: language || botSettings.language || 'he',
    voiceConfig: {
      voice_config: {
        prebuilt_voice_config: { voice_name: voice || botSettings.voice || 'Kore' }
      }
    }
  });

  try {
    await session.connect();
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('TTS timeout')), 15000);
      session.on('audio', c => chunks.push(c));
      session.on('turn_complete', () => { clearTimeout(timeout); resolve(); });
      session.on('error', err => { clearTimeout(timeout); reject(err); });
      session.sendText(text);
    });
    session.close();

    const { WaveFile } = require('wavefile');
    const pcm = Buffer.concat(chunks);
    const wav = new WaveFile();
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    wav.fromScratch(1, 24000, '16', samples);
    const wavBuf = Buffer.from(wav.toBuffer());
    res.set('Content-Type', 'audio/wav');
    res.send(wavBuf);
  } catch (err) {
    try { session.close(); } catch (_) {}
    logger.error('TTS endpoint error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook: text chat with the bot ──────────────────────────────────────
const https = require('https');

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'missing "message" field' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  let systemPrompt = botSettings.persona;
  // Inject HA tool instructions if enabled
  if (integrations.ha?.enabled && integrations.ha?.url) {
    systemPrompt += '\n\nYou can control smart home devices. When the user asks to turn on/off lights, change temperature, etc., respond with a JSON action block:\n<ha_action>{"domain":"light","service":"turn_on","entity_id":"light.living_room"}</ha_action>\nThen also respond verbally confirming the action in Hebrew.';
  }
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: message }] }]
  });

  try {
    const response = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      };
      const req2 = https.request(opts, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req2.on('error', reject);
      req2.write(payload);
      req2.end();
    });

    const result = JSON.parse(response.body);
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    logger.info('API chat response', { sessionId, message: message.slice(0, 50), responseLength: text.length });
    res.json({ success: true, response: text, sessionId });
  } catch (err) {
    logger.error('API chat error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Active call registry — for Dialer panel and /api/calls
const activeCalls = new Map(); // callId → { callId, to, from, startedAt, dialog }

// Outbound call endpoint — triggers bot to call a SIP extension
app.post('/call', async (req, res) => {
  const { to, callerId } = req.body || {};
  if (!to) return res.status(400).json({ error: 'missing "to" field' });

  const from = callerId || process.env.SIP_EXTENSION || '12611';
  const target = to.startsWith('sip:') ? to : `sip:${to}@${process.env.SIP_DOMAIN || '127.0.0.1'}`;

  logger.info('Outbound call requested', { to, target, from });
  try {
    const { endpoint, dialog } = await callHandler.makeOutboundCall(target, from);
    const callId = dialog.id || `out-${Date.now()}`;
    activeCalls.set(callId, { callId, to, from, target, startedAt: Date.now(), dialog });
    dialog.once('destroy', () => activeCalls.delete(callId));
    res.json({ success: true, callId });
  } catch (err) {
    logger.error('Outbound call failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// List active calls
app.get('/api/calls', (req, res) => {
  const calls = [...activeCalls.values()].map(({ callId, to, from, startedAt }) => ({
    callId, to, from, startedAt, durationS: Math.round((Date.now() - startedAt) / 1000)
  }));
  res.json({ calls });
});

// Hangup a specific call
app.delete('/call/:callId', (req, res) => {
  const entry = activeCalls.get(req.params.callId);
  if (!entry) return res.status(404).json({ error: 'call not found' });
  try {
    entry.dialog.destroy();
    activeCalls.delete(req.params.callId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connection status ─────────────────────────────────────────────────────
// Tracks SIP registration + integration test results for the dashboard
let sipRegistrar = null;
const integrationStatus = {}; // { teamy: {ok, ts, error}, openclaw: {...}, ha: {...} }

app.get('/api/status', async (req, res) => {
  // SIP registration
  const sipRegs = {};
  if (sipRegistrar) {
    for (const [ext, reg] of sipRegistrar.registrations.entries()) {
      sipRegs[ext] = { registered: true, age: Math.round((Date.now() - reg.registeredAt) / 1000) };
    }
  }
  // Integration ping (cached, updated every 30s)
  const now = Date.now();
  const intResults = {};
  for (const name of ['teamy', 'openclaw', 'ha']) {
    const cached = integrationStatus[name];
    if (cached && (now - cached.ts) < 30000) {
      intResults[name] = cached;
    } else {
      const cfg = integrations[name];
      if (!cfg?.url || !cfg?.enabled) {
        intResults[name] = integrationStatus[name] = { ok: null, ts: now, error: 'not configured' };
      } else {
        const testUrl = name === 'teamy' ? cfg.url + '/api/bots' :
                        name === 'openclaw' ? cfg.url + '/health' :
                        cfg.url + '/api/config';
        const result = await new Promise((resolve) => {
          try {
            const urlObj = new URL(testUrl);
            const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
            const opts = { hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80), path: urlObj.pathname, method: 'GET', timeout: 4000 };
            if (cfg.token && cfg.token !== '✓ set') opts.headers = { Authorization: `Bearer ${cfg.token}` };
            const req2 = mod.request(opts, r => resolve({ ok: r.statusCode < 500, status: r.statusCode }));
            req2.on('error', e => resolve({ ok: false, error: e.message }));
            req2.on('timeout', () => resolve({ ok: false, error: 'timeout' }));
            req2.end();
          } catch(e) { resolve({ ok: false, error: e.message }); }
        });
        intResults[name] = integrationStatus[name] = { ...result, ts: now };
      }
    }
  }
  res.json({
    drachtio: global._drachtioConnected ? 'connected' : 'disconnected',
    sip: sipRegs,
    sipProvider: botSettings.sipProvider || '3cx',
    sipDomain: botSettings.sipServer || process.env.SIP_DOMAIN || '',
    sipExtension: botSettings.sipExtension || process.env.SIP_EXTENSION || '',
    integrations: intResults,
  });
});

// ── Gemini Live WebSocket bridge for Teamy ───────────────────────────────
// Teamy connects here to get a full bidirectional Gemini Live voice session.
// Protocol:
//   Client → Server: first message = JSON config {"voice","language","systemPrompt"}
//                    subsequent binary messages = PCM 16-bit LE 16kHz mono frames
//   Server → Client: binary = PCM 16-bit LE 24kHz mono (Gemini output)
//                    text JSON = {"type":"transcript","role":"user"|"bot","text":"..."}
//                             or {"type":"status","state":"ready"|"listening"|"thinking"}
{
  const WebSocketServer = require('ws').Server;
  const GeminiLiveSession = require('./gemini-live/session');
  const http = require('http');

  const liveServer = http.createServer((req, res) => {
    // Basic auth check for HTTP upgrade requests
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Basic ')) {
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      if (u === (process.env.ADMIN_USER || 'admin') && p === (process.env.ADMIN_PASS || 'callme2024')) {
        res.writeHead(200); res.end(); return;
      }
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CallMe Bot"' }); res.end();
  });

  const wss = new WebSocketServer({ server: liveServer, path: '/api/live' });
  const LIVE_PORT = parseInt(process.env.LIVE_PORT || '3102');

  wss.on('connection', (ws, req) => {
    // Basic auth via query token or header
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const expectedToken = Buffer.from(`${process.env.ADMIN_USER || 'admin'}:${process.env.ADMIN_PASS || 'callme2024'}`).toString('base64');
    const auth = req.headers.authorization;
    const authOk = token === expectedToken ||
      (auth && auth.startsWith('Basic ') && Buffer.from(auth.slice(6), 'base64').toString() === `${process.env.ADMIN_USER || 'admin'}:${process.env.ADMIN_PASS || 'callme2024'}`);
    if (!authOk) { ws.close(4401, 'Unauthorized'); return; }

    const sessionId = `live-${Date.now()}`;
    logger.info('Teamy Live connection', { sessionId });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { ws.close(4500, 'GEMINI_API_KEY not configured'); return; }

    let session = null;
    let configured = false;
    let audioChunks = [];
    let isPlaying = false;

    // VAD state (same as call-handler.js)
    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;
    const MIN_SPEECH_FRAMES = 15;
    let speaking = false, silenceCount = 0, speechCount = 0;
    let waitingForGemini = false;
    let waitingTimer = null;

    const calcRms = (buf) => {
      let sum = 0;
      for (let i = 0; i + 1 < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
      return Math.sqrt(sum / (buf.length / 2));
    };

    const sendStatus = (state) => { try { ws.send(JSON.stringify({ type: 'status', state })); } catch(_) {} };
    const sendTranscript = (role, text) => { try { ws.send(JSON.stringify({ type: 'transcript', role, text })); } catch(_) {} };

    ws.on('message', async (data, isBinary) => {
      if (!configured) {
        // First message must be JSON config
        try {
          const cfg = JSON.parse(data.toString());
          const settings = global.botSettings || {};
          const systemPrompt = cfg.systemPrompt || settings.persona ||
            'You are a helpful voice assistant. Speak in the language the user uses.';
          const voiceName = cfg.voice || settings.voice || 'Kore';
          const language = cfg.language || settings.language || 'he';

          session = new GeminiLiveSession({
            callId: sessionId, apiKey,
            systemPrompt,
            language,
            voiceConfig: { voice_config: { prebuilt_voice_config: { voice_name: voiceName } } }
          });

          session.on('audio', (chunk) => {
            audioChunks.push(chunk);
            const total = audioChunks.reduce((s, c) => s + c.length, 0);
            if (total >= 48000) { // flush after 1s
              const pcm = Buffer.concat(audioChunks);
              audioChunks = [];
              if (ws.readyState === ws.OPEN) ws.send(pcm);
            }
          });

          session.on('turn_complete', () => {
            waitingForGemini = false;
            if (audioChunks.length) {
              const pcm = Buffer.concat(audioChunks);
              audioChunks = [];
              if (ws.readyState === ws.OPEN) ws.send(pcm);
            }
            isPlaying = false;
            sendStatus('listening');
          });

          session.on('interrupted', () => {
            audioChunks = [];
            waitingForGemini = false;
            isPlaying = false;
            sendStatus('listening');
          });

          session.on('input_transcript', (text) => sendTranscript('user', text));
          session.on('output_transcript', (text) => {
            sendTranscript('bot', text);
            // Execute HA actions if present
            const haMatch = text.match(/<ha_action>([\s\S]*?)<\/ha_action>/);
            if (haMatch && global.callHaService) {
              try {
                const action = JSON.parse(haMatch[1]);
                global.callHaService(action.domain, action.service, action.serviceData || { entity_id: action.entity_id });
              } catch(_) {}
            }
          });
          session.on('error', (err) => logger.error('Live session error', { sessionId, error: err.message }));

          await session.connect();
          configured = true;
          sendStatus('ready');
          logger.info('Teamy Live session ready', { sessionId, voice: voiceName, language });

          // Send greeting
          const greeting = (global.botSettings || {}).greeting || 'שלום! ברך את המשתמש בקצרה.';
          session.sendText(greeting);
          isPlaying = true;
          sendStatus('thinking');
        } catch (err) {
          logger.error('Live session setup error', { sessionId, error: err.message });
          ws.close(4500, err.message);
        }
        return;
      }

      if (!isBinary || !session) return;
      if (waitingForGemini || isPlaying) return;

      // VAD processing of incoming PCM
      const rms = calcRms(data);
      if (rms > SPEECH_RMS_THRESHOLD) {
        silenceCount = 0; speechCount++;
        if (!speaking && speechCount >= 2) {
          speaking = true;
          session.sendActivityStart();
          sendStatus('listening');
        }
        if (speaking) session.sendAudio(data);
      } else {
        if (speaking) {
          silenceCount++;
          session.sendAudio(data);
          if (silenceCount >= SILENCE_FRAMES_NEEDED) {
            if (speechCount >= MIN_SPEECH_FRAMES) {
              session.sendActivityEnd();
              waitingForGemini = true;
              isPlaying = true;
              sendStatus('thinking');
              if (waitingTimer) clearTimeout(waitingTimer);
              waitingTimer = setTimeout(() => { waitingForGemini = false; isPlaying = false; }, 10000);
            } else {
              session.sendActivityEnd();
            }
            speaking = false; silenceCount = 0; speechCount = 0;
          }
        } else { speechCount = 0; }
      }
    });

    ws.on('close', () => {
      logger.info('Teamy Live disconnected', { sessionId });
      if (waitingTimer) clearTimeout(waitingTimer);
      if (session) { try { if (speaking) session.sendActivityEnd(); session.close(); } catch(_) {} }
    });

    ws.on('error', (err) => logger.error('Live WS error', { sessionId, error: err.message }));
  });

  liveServer.listen(LIVE_PORT, '0.0.0.0', () => {
    logger.info(`Gemini Live WS bridge listening on port ${LIVE_PORT}`);
  });
}

// Start health server
app.listen(config.healthPort, '0.0.0.0', () => {
  logger.info(`Health server listening on port ${config.healthPort}`);
});

// Connect to Drachtio
srf.connect({
  host: config.drachtio.host,
  port: config.drachtio.port,
  secret: config.drachtio.secret
});

srf.on('connect', (err, hostport) => {
  if (err) {
    logger.error('Failed to connect to Drachtio', { error: err.message });
    global._drachtioConnected = false;
    return;
  }
  global._drachtioConnected = true;
  logger.info(`Connected to Drachtio at ${hostport}`);

  // Connect to FreeSWITCH media server
  mrf.connect({
    address: config.freeswitch.host,
    port: config.freeswitch.port,
    secret: config.freeswitch.secret
  }).then((mediaServer) => {
    logger.info('Connected to FreeSWITCH media server');
    callHandler.setMediaServer(mediaServer);
  }).catch((err) => {
    logger.error('Failed to connect to FreeSWITCH', { error: err.message });
  });

  // Register with 3CX if SIP credentials are provided
  if (process.env.SIP_EXTENSION && process.env.SIP_AUTH_PASSWORD) {
    const registrar = new MultiRegistrar(srf, {
      domain: process.env.SIP_DOMAIN,
      registrar: process.env.SIP_REGISTRAR,
      registrar_port: parseInt(process.env.SIP_REGISTRAR_PORT || '5060'),
      expiry: parseInt(process.env.SIP_EXPIRY || '3600'),
      local_address: process.env.SIP_LOCAL_ADDRESS || '127.0.0.1',
      local_port: parseInt(process.env.DRACHTIO_SIP_PORT || '5070'),
    });

    sipRegistrar = registrar;
    registrar.registerAll({
      [process.env.SIP_EXTENSION]: {
        name: `ext-${process.env.SIP_EXTENSION}`,
        extension: process.env.SIP_EXTENSION,
        authId: process.env.SIP_AUTH_ID || process.env.SIP_EXTENSION,
        password: process.env.SIP_AUTH_PASSWORD,
      }
    });
    logger.info('SIP registration started', { extension: process.env.SIP_EXTENSION });
  }
});

srf.on('error', (err) => {
  logger.error('Drachtio error', { error: err.message });
  global._drachtioConnected = false;
});

// Inbound call handler
srf.invite((req, res) => {
  callHandler.handleInvite(req, res);
});

logger.info('Voice worker v2 started', {
  version: '2.0.0',
  drachtioHost: config.drachtio.host,
  drachtioPort: config.drachtio.port,
  healthPort: config.healthPort,
  engine: process.env.CONVERSATION_ENGINE || 'stt-tts',
});
