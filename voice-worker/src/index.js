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
  res.json(botSettings);
});

app.post('/api/settings', (req, res) => {
  const { name, persona, language, extension, greeting, voice } = req.body || {};
  if (name !== undefined) botSettings.name = name;
  if (persona !== undefined) botSettings.persona = persona;
  if (language !== undefined) botSettings.language = language;
  if (extension !== undefined) botSettings.extension = extension;
  if (greeting !== undefined) botSettings.greeting = greeting;
  if (voice !== undefined) botSettings.voice = voice;
  saveSettings();
  logger.info('Bot settings updated', botSettings);
  res.json({ success: true, settings: botSettings });
});

// ── Webhook: text chat with the bot ──────────────────────────────────────
const https = require('https');

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'missing "message" field' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const systemPrompt = botSettings.persona;
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
