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
  name: 'Luky',
  persona: process.env.GEMINI_SYSTEM_PROMPT ||
    'You are a helpful voice assistant named Luky. The caller speaks Hebrew. Always respond in Hebrew.',
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
  res.json({ ...botSettings, sipPassword: botSettings.sipPassword ? '✓ set' : '' });
});

app.post('/api/settings', (req, res) => {
  const { name, persona, language, extension, greeting, voice,
          sipProvider, sipServer, sipRegistrar, sipExtension, sipAuthId, sipPassword, sipDid } = req.body || {};
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
  saveSettings();
  logger.info('Bot settings updated', { ...botSettings, sipPassword: botSettings.sipPassword ? '***' : '' });
  // Return settings without exposing password
  res.json({ success: true, settings: { ...botSettings, sipPassword: botSettings.sipPassword ? '✓ set' : '' } });
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

// POST /api/ha/webhook — HA calls this to trigger Luky to make an outbound call
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

// Outbound call endpoint — triggers bot to call a SIP extension
app.post('/call', async (req, res) => {
  const { to, callerId } = req.body || {};
  if (!to) return res.status(400).json({ error: 'missing "to" field' });

  const from = callerId || process.env.SIP_EXTENSION || '12611';
  const target = `sip:${to}@${process.env.SIP_DOMAIN || '127.0.0.1'}`;

  logger.info('Outbound call requested', { to, target, from });
  try {
    const { endpoint, dialog } = await callHandler.makeOutboundCall(target, from);
    res.json({ success: true, callId: dialog.id });
  } catch (err) {
    logger.error('Outbound call failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

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
    return;
  }
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
