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
  const user = (botSettings && botSettings.adminUser) || process.env.SUPER_ADMIN_USER || process.env.ADMIN_USER || 'admin';
  const pass = (botSettings && botSettings.adminPass) || process.env.SUPER_ADMIN_PASS || process.env.ADMIN_PASS || 'callme2024';
  return { user, pass };
}

// Role permissions:
//   admin    — full access
//   operator — calls + contacts + recordings + IVR; no settings/users/integrations write
//   viewer   — GET only; no POST/PUT/DELETE, no settings write
const ROLE_PERMISSIONS = {
  admin:    { allowAll: true },
  operator: { allowPaths: ['/api/calls', '/api/call', '/api/contacts', '/api/recordings', '/api/voicemails', '/api/ivr', '/api/logs', '/api/status'], allowGet: true },
  viewer:   { allowGet: true, allowPaths: [] },
};

function getRequestRole(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return null;
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const colonIdx = decoded.indexOf(':');
  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);
  const { user: ADMIN_USER, pass: ADMIN_PASS } = getAdminCreds();
  if (user === ADMIN_USER && pass === ADMIN_PASS) return { role: 'admin', username: user };
  const found = (botSettings.users || []).find(u => u.username === user && u.password === pass);
  if (found) return { role: found.role || 'viewer', username: user };
  return null;
}

function requireAuth(req, res, next) {
  // Skip auth for health/ready/metrics (used by infra) and audio (FreeSWITCH)
  if (['/health', '/ready', '/metrics'].includes(req.path) || req.path.startsWith('/audio/')) {
    return next();
  }
  // /admin and /t/:tenantId routes handle their own auth
  if (req.path.startsWith('/admin') || req.path.startsWith('/t/')) {
    return next();
  }
  const identity = getRequestRole(req);
  if (!identity) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CallMe Bot Dashboard"');
    return res.status(401).send('Authentication required');
  }
  const perms = ROLE_PERMISSIONS[identity.role] || ROLE_PERMISSIONS.viewer;
  if (perms.allowAll) { req.userRole = identity.role; return next(); }
  // Viewer: GET requests only (static files + read APIs)
  if (perms.allowGet && req.method === 'GET') { req.userRole = identity.role; return next(); }
  // Operator: also allow mutating calls/contacts/IVR paths
  if (perms.allowPaths && perms.allowPaths.some(p => req.path.startsWith(p))) { req.userRole = identity.role; return next(); }
  return res.status(403).json({ error: 'Forbidden — insufficient permissions for your role (' + identity.role + ')' });
}
app.use(requireAuth);

// Serve dashboard
app.use('/', express.static(path.join(__dirname, 'public')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));

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
  extension: process.env.SIP_EXTENSION || '',
  greeting: 'שלום! ברך את המשתמש בקצרה בעברית.',
  voice: process.env.GEMINI_VOICE || 'Kore',
  // AI engine & API keys
  aiEngine: 'gemini-live',    // 'gemini-live' | 'openai-realtime'
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: '',             // blank = use server default
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  // Bot "soul" — rules, knowledge, escalation
  rules: '',
  knowledge: '',
  escalationTurns: '',
  escalationNumber: '',
  // Tool toggles
  toolFindContact: true,
  toolAddContact: true,
  toolScheduleCall: true,
  toolCalendar: true,
  toolHomeAssistant: false,
  // SIP trunk config
  sipProvider: '',             // '3cx' | 'zadarma' | 'twilio' | 'custom'
  sipServer: process.env.SIP_DOMAIN || '',
  sipRegistrar: process.env.SIP_REGISTRAR || '',
  sipExtension: process.env.SIP_EXTENSION || '',
  sipAuthId: process.env.SIP_AUTH_ID || '',
  sipPassword: process.env.SIP_PASSWORD || '',
  sipDid: process.env.DEFAULT_CALLER_ID || '',
  // Admin credentials
  adminUser: process.env.SUPER_ADMIN_USER || '',
  adminPass: process.env.SUPER_ADMIN_PASS || '',
  // Webhook URL for call events (call.started, call.ended, call.failed)
  callWebhookUrl: process.env.CALL_WEBHOOK_URL || '',
  // Telegram notifications
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramThreadId: process.env.TELEGRAM_THREAD_ID || '',
  telegramCallSummary: false,
  // Calendar integration (iCal URL — Google Calendar / Apple / any CalDAV)
  calendarUrl: '',
  calendarName: 'My Calendar',
  // WhatsApp notifications (via CallMeBot — free, no setup)
  whatsappPhone: '',
  whatsappApiKey: '',
  whatsappCallSummary: false,
  // Twilio integration (PSTN DID → Gemini Live via Media Streams)
  twilioAccountSid: '',
  twilioAuthToken: '',
  twilioPhoneNumber: '',
  twilioPublicUrl: '',
  // Vonage integration (PSTN DID → Gemini Live via WebSocket — native 16kHz PCM)
  vonageApiKey: '',
  vonageApiSecret: '',
  vonagePhoneNumber: '',
  vonagePublicUrl: '',
  vonageAppId: '',
};

let botSettings = { ...defaultSettings };
const _settingsFileExisted = fs.existsSync(SETTINGS_FILE);
try {
  if (_settingsFileExisted) {
    botSettings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    logger.info('Loaded bot settings from file');
  }
} catch (_) {}

const saveSettings = () => {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 2)); } catch (_) {}
};

// On first run: seed settings file from environment so dashboard manages everything
if (!_settingsFileExisted) {
  saveSettings();
  logger.info('First-run: created bot-settings.json from environment variables');
}

// Export settings so call-handler can read them
global.botSettings = botSettings;

app.get('/api/settings', (req, res) => {
  const { user: adminUser } = getAdminCreds();
  res.json({
    ...botSettings,
    sipPassword: botSettings.sipPassword ? '✓ set' : '',
    adminPass: botSettings.adminPass ? '✓ set' : '',
    adminUser: botSettings.adminUser || adminUser,
    telegramBotToken: botSettings.telegramBotToken ? '✓ set' : '',
    whatsappApiKey: botSettings.whatsappApiKey ? '✓ set' : '',
    geminiApiKey: botSettings.geminiApiKey ? '✓ set' : '',
    openaiApiKey: botSettings.openaiApiKey ? '✓ set' : '',
    elevenlabsApiKey: botSettings.elevenlabsApiKey ? '✓ set' : '',
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
  const { callWebhookUrl, telegramBotToken, telegramChatId, telegramThreadId, telegramCallSummary,
          calendarUrl, calendarName } = req.body || {};
  if (callWebhookUrl !== undefined) botSettings.callWebhookUrl = callWebhookUrl;
  if (telegramBotToken) botSettings.telegramBotToken = telegramBotToken;
  if (telegramChatId !== undefined) botSettings.telegramChatId = telegramChatId;
  if (telegramThreadId !== undefined) botSettings.telegramThreadId = telegramThreadId;
  if (telegramCallSummary !== undefined) botSettings.telegramCallSummary = telegramCallSummary;
  if (calendarUrl !== undefined) botSettings.calendarUrl = calendarUrl;
  if (calendarName !== undefined) botSettings.calendarName = calendarName;
  const { whatsappPhone, whatsappApiKey, whatsappCallSummary } = req.body || {};
  if (whatsappPhone !== undefined) botSettings.whatsappPhone = whatsappPhone;
  if (whatsappApiKey !== undefined && whatsappApiKey !== '') botSettings.whatsappApiKey = whatsappApiKey;
  if (whatsappCallSummary !== undefined) botSettings.whatsappCallSummary = whatsappCallSummary;
  const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber, twilioPublicUrl } = req.body || {};
  if (twilioAccountSid !== undefined) botSettings.twilioAccountSid = twilioAccountSid;
  if (twilioAuthToken !== undefined && twilioAuthToken !== '') botSettings.twilioAuthToken = twilioAuthToken;
  if (twilioPhoneNumber !== undefined) botSettings.twilioPhoneNumber = twilioPhoneNumber;
  if (twilioPublicUrl !== undefined) botSettings.twilioPublicUrl = twilioPublicUrl;
  const { vonageApiKey, vonageApiSecret, vonagePhoneNumber, vonagePublicUrl, vonageAppId } = req.body || {};
  if (vonageApiKey !== undefined) botSettings.vonageApiKey = vonageApiKey;
  if (vonageApiSecret !== undefined && vonageApiSecret !== '') botSettings.vonageApiSecret = vonageApiSecret;
  if (vonagePhoneNumber !== undefined) botSettings.vonagePhoneNumber = vonagePhoneNumber;
  if (vonagePublicUrl !== undefined) botSettings.vonagePublicUrl = vonagePublicUrl;
  if (vonageAppId !== undefined) botSettings.vonageAppId = vonageAppId;
  // AI engine, API keys, soul fields
  const { aiEngine, geminiApiKey, geminiModel, openaiApiKey, elevenlabsApiKey,
          rules, knowledge, escalationTurns, escalationNumber,
          toolFindContact, toolAddContact, toolScheduleCall, toolCalendar, toolHomeAssistant } = req.body || {};
  if (aiEngine !== undefined) botSettings.aiEngine = aiEngine;
  if (geminiApiKey !== undefined && geminiApiKey !== '' && geminiApiKey !== '✓ set') botSettings.geminiApiKey = geminiApiKey;
  if (geminiModel !== undefined) botSettings.geminiModel = geminiModel;
  if (openaiApiKey !== undefined && openaiApiKey !== '' && openaiApiKey !== '✓ set') botSettings.openaiApiKey = openaiApiKey;
  if (elevenlabsApiKey !== undefined && elevenlabsApiKey !== '' && elevenlabsApiKey !== '✓ set') botSettings.elevenlabsApiKey = elevenlabsApiKey;
  if (rules !== undefined) botSettings.rules = rules;
  if (knowledge !== undefined) botSettings.knowledge = knowledge;
  if (escalationTurns !== undefined) botSettings.escalationTurns = escalationTurns;
  if (escalationNumber !== undefined) botSettings.escalationNumber = escalationNumber;
  if (toolFindContact !== undefined) botSettings.toolFindContact = toolFindContact;
  if (toolAddContact !== undefined) botSettings.toolAddContact = toolAddContact;
  if (toolScheduleCall !== undefined) botSettings.toolScheduleCall = toolScheduleCall;
  if (toolCalendar !== undefined) botSettings.toolCalendar = toolCalendar;
  if (toolHomeAssistant !== undefined) botSettings.toolHomeAssistant = toolHomeAssistant;
  saveSettings();
  logger.info('Bot settings updated', { ...botSettings, sipPassword: '***', adminPass: '***' });
  // Return settings without exposing passwords
  res.json({ success: true, settings: {
    ...botSettings,
    sipPassword: botSettings.sipPassword ? '✓ set' : '',
    adminPass: botSettings.adminPass ? '✓ set' : '',
    geminiApiKey: botSettings.geminiApiKey ? '✓ set' : '',
    openaiApiKey: botSettings.openaiApiKey ? '✓ set' : '',
    elevenlabsApiKey: botSettings.elevenlabsApiKey ? '✓ set' : '',
  }});
});

// ── Teamy proxy ──────────────────────────────────────────────────────────────
app.get('/api/teamy/status', async (req, res) => {
  const cfg = integrations.teamy;
  if (!cfg?.enabled || !cfg.url) return res.status(503).json({ error: 'Teamy not configured' });
  try {
    const headers = cfg.token && cfg.token !== '✓ set' ? { Authorization: `Bearer ${cfg.token}` } : {};
    const [statusRes, botsRes] = await Promise.all([
      fetch(cfg.url + '/status', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(cfg.url + '/bots', { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    res.json({ ...(statusRes || {}), bots: botsRes });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ── Users management ────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const users = (botSettings.users || []).map(({ username, role }) => ({ username, role: role || 'viewer' }));
  const { user: adminUser } = getAdminCreds();
  res.json({ users: [{ username: adminUser, role: 'admin' }, ...users] });
});

app.post('/api/users', (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!botSettings.users) botSettings.users = [];
  if (botSettings.users.find(u => u.username === username)) return res.status(409).json({ error: 'user already exists' });
  botSettings.users.push({ username, password, role: role || 'viewer' });
  saveSettings();
  res.json({ success: true });
});

app.put('/api/users/:username', (req, res) => {
  const { password } = req.body || {};
  if (!botSettings.users) botSettings.users = [];
  const u = botSettings.users.find(u => u.username === req.params.username);
  if (!u) return res.status(404).json({ error: 'user not found' });
  if (password) u.password = password;
  saveSettings();
  res.json({ success: true });
});

app.delete('/api/users/:username', (req, res) => {
  if (!botSettings.users) return res.json({ success: true });
  botSettings.users = botSettings.users.filter(u => u.username !== req.params.username);
  saveSettings();
  res.json({ success: true });
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
    const testUrl = name === 'teamy' ? cfg.url + '/bots' :
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

// ── Webhook helpers ───────────────────────────────────────────────────────
function fireWebhook(event, payload) {
  const url = botSettings.callWebhookUrl || process.env.CALL_WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload });
  try {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
    const req2 = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, () => {});
    req2.on('error', (e) => logger.warn('Webhook delivery failed', { url, error: e.message }));
    req2.write(body);
    req2.end();
    logger.debug('Webhook fired', { event, url });
  } catch (e) {
    logger.warn('Webhook error', { error: e.message });
  }
}
// Make fireWebhook available to call-handler via global
global.fireWebhook = fireWebhook;

function sendTelegramMessage(text) {
  const token = botSettings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = botSettings.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(botSettings.telegramThreadId ? { message_thread_id: parseInt(botSettings.telegramThreadId) } : {}),
  });

  try {
    const req2 = require('https').request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, () => {});
    req2.on('error', (e) => logger.warn('Telegram notification failed', { error: e.message }));
    req2.write(body);
    req2.end();
  } catch(e) {
    logger.warn('Telegram send error', { error: e.message });
  }
}
global.sendTelegramMessage = sendTelegramMessage;

function sendWhatsappMessage(text) {
  const phone = botSettings.whatsappPhone || process.env.WHATSAPP_PHONE;
  const apiKey = botSettings.whatsappApiKey || process.env.WHATSAPP_APIKEY;
  if (!phone || !apiKey) return;
  // Strip HTML tags for WhatsApp plain text
  const plain = text.replace(/<[^>]+>/g, '').replace(/\n/g, '%0A').replace(/ /g, '%20');
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${plain}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    require('https').get(url, (res) => { res.resume(); }).on('error', (e) => logger.warn('WhatsApp send failed', { error: e.message }));
    logger.debug('WhatsApp notification sent', { phone });
  } catch(e) { logger.warn('WhatsApp send error', { error: e.message }); }
}
global.sendWhatsappMessage = sendWhatsappMessage;

app.post('/api/whatsapp/test', (req, res) => {
  const phone = botSettings.whatsappPhone;
  const apiKey = botSettings.whatsappApiKey;
  if (!phone || !apiKey) return res.json({ ok: false, error: 'WhatsApp לא מוגדר — הגדר מספר ו-API key' });
  sendWhatsappMessage('✅ CallMe Bot — הודעת בדיקה מהדשבורד');
  res.json({ ok: true });
});

// Active call registry — for Dialer panel and /api/calls
const activeCalls = new Map(); // callId → { callId, to, from, startedAt, dialog }

// Outbound call endpoint — triggers bot to call a SIP extension
app.post('/call', async (req, res) => {
  const { to, callerId, webhookUrl } = req.body || {};
  if (!to) return res.status(400).json({ error: 'missing "to" field' });

  const from = callerId || process.env.SIP_EXTENSION || '12611';
  const target = to.startsWith('sip:') ? to : `sip:${to}@${process.env.SIP_DOMAIN || '127.0.0.1'}`;
  const callId = `out-${Date.now()}`;
  const startedAt = Date.now();

  logger.info('Outbound call requested', { to, target, from, callId });

  // Return immediately so the browser doesn't time out waiting for SIP setup
  activeCalls.set(callId, { callId, to, from, target, startedAt, status: 'calling', dialog: null });
  res.json({ success: true, callId, status: 'calling' });

  // Establish SIP call in the background
  callHandler.makeOutboundCall(target, from).then(({ dialog }) => {
    const existing = activeCalls.get(callId);
    if (existing) activeCalls.set(callId, { ...existing, dialog, status: 'connected' });
    fireWebhook('call.started', { callId, direction: 'outbound', to, from, startedAt });
    dialog.once('destroy', () => {
      const durationS = Math.round((Date.now() - startedAt) / 1000);
      activeCalls.delete(callId);
      fireWebhook('call.ended', { callId, direction: 'outbound', to, from, startedAt, durationS });
      if (global.sendTelegramMessage && botSettings.telegramCallSummary) {
        const msg = `📞 <b>שיחה יוצאת הסתיימה</b>\n📱 יעד: ${to}\n⏱ משך: ${durationS}ש\n🆔 ${callId.slice(0,12)}`;
        global.sendTelegramMessage(msg);
      }
      if (global.sendWhatsappMessage && botSettings.whatsappCallSummary) {
        global.sendWhatsappMessage(`📞 שיחה יוצאת הסתיימה\n📱 יעד: ${to}\n⏱ משך: ${durationS}ש`);
      }
      if (webhookUrl) {
        const orig = botSettings.callWebhookUrl;
        botSettings.callWebhookUrl = webhookUrl;
        fireWebhook('call.ended', { callId, direction: 'outbound', to, from, startedAt, durationS });
        botSettings.callWebhookUrl = orig;
      }
    });
  }).catch(err => {
    logger.error('Outbound call failed', { callId, error: err.message });
    activeCalls.delete(callId);
    fireWebhook('call.failed', { callId, direction: 'outbound', to, from, error: err.message });
  });
});

// List active calls
app.get('/api/calls', (req, res) => {
  const calls = [...activeCalls.values()].map(({ callId, to, from, startedAt, status }) => ({
    callId, to, from, startedAt, status: status || 'connected', durationS: Math.round((Date.now() - startedAt) / 1000)
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

// ── Contacts ──────────────────────────────────────────────────────────────
const CONTACTS_FILE = path.join(AUDIO_DIR, '..', 'contacts.json');
let contacts = [];
try {
  if (fs.existsSync(CONTACTS_FILE)) contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
} catch (_) {}
const saveContacts = () => { try { fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2)); } catch (_) {} };

app.get('/api/contacts', (req, res) => res.json({ contacts }));

app.post('/api/contacts', (req, res) => {
  const { name, phone, notes } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  const id = `c-${Date.now()}`;
  const contact = { id, name, phone: phone.trim(), notes: notes || '', createdAt: Date.now() };
  contacts.push(contact);
  saveContacts();
  res.json({ success: true, contact });
});

app.put('/api/contacts/:id', (req, res) => {
  const idx = contacts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { name, phone, notes } = req.body || {};
  if (name) contacts[idx].name = name;
  if (phone) contacts[idx].phone = phone.trim();
  if (notes !== undefined) contacts[idx].notes = notes;
  saveContacts();
  res.json({ success: true, contact: contacts[idx] });
});

app.delete('/api/contacts/:id', (req, res) => {
  const idx = contacts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  contacts.splice(idx, 1);
  saveContacts();
  res.json({ success: true });
});

// ── Scheduler ─────────────────────────────────────────────────────────────
// Each job: { id, name, target (phone/sip), message (spoken on pickup), at (ISO or cron-like HH:MM), repeat ('once'|'daily'|'weekdays'), nextAt (ms timestamp), lastRan, enabled }
const SCHEDULER_FILE = path.join(AUDIO_DIR, '..', 'scheduler.json');
let scheduledJobs = [];
try {
  if (fs.existsSync(SCHEDULER_FILE)) scheduledJobs = JSON.parse(fs.readFileSync(SCHEDULER_FILE, 'utf8'));
} catch (_) {}
const saveScheduler = () => { try { fs.writeFileSync(SCHEDULER_FILE, JSON.stringify(scheduledJobs, null, 2)); } catch (_) {} };

// Expose globals for tool calling in call-handler
global.contacts = contacts;
global.scheduledJobs = scheduledJobs;
global.activeCalls = activeCalls;
global.saveContacts = saveContacts;
global.saveScheduler = saveScheduler;
global.metrics = metrics;

function computeNextAt(job) {
  const now = new Date();
  if (!job.time) return null; // HH:MM in local time
  const [hh, mm] = job.time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // if already passed today, next day
  // For weekdays only, skip to Monday if landing on weekend
  if (job.repeat === 'weekdays') {
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

app.get('/api/scheduler', (req, res) => res.json({ jobs: scheduledJobs }));

app.post('/api/scheduler', (req, res) => {
  const { name, target, message, time, repeat } = req.body || {};
  if (!target || !time) return res.status(400).json({ error: 'target and time required' });
  const id = `j-${Date.now()}`;
  const job = { id, name: name || target, target, message: message || '', time, repeat: repeat || 'once', enabled: true, createdAt: Date.now(), lastRan: null };
  job.nextAt = computeNextAt(job);
  scheduledJobs.push(job);
  saveScheduler();
  logger.info('Scheduled job created', { id, name: job.name, time, repeat });
  res.json({ success: true, job });
});

app.put('/api/scheduler/:id', (req, res) => {
  const job = scheduledJobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { name, target, message, time, repeat, enabled } = req.body || {};
  if (name !== undefined) job.name = name;
  if (target !== undefined) job.target = target;
  if (message !== undefined) job.message = message;
  if (time !== undefined) { job.time = time; job.nextAt = computeNextAt(job); }
  if (repeat !== undefined) job.repeat = repeat;
  if (enabled !== undefined) job.enabled = enabled;
  saveScheduler();
  res.json({ success: true, job });
});

app.delete('/api/scheduler/:id', (req, res) => {
  const idx = scheduledJobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  scheduledJobs.splice(idx, 1);
  saveScheduler();
  res.json({ success: true });
});

// Scheduler tick — check every 30s for due jobs
setInterval(async () => {
  const now = Date.now();
  for (const job of scheduledJobs) {
    if (!job.enabled || !job.nextAt || job.nextAt > now) continue;
    logger.info('Scheduler firing job', { id: job.id, name: job.name, target: job.target });
    job.lastRan = now;

    // Inject the job's message as the greeting for this call
    const prevGreeting = (global.botSettings || {}).greeting;
    if (job.message && global.botSettings) global.botSettings.greeting = job.message;

    try {
      const from = process.env.SIP_EXTENSION || '12611';
      const target = job.target.startsWith('sip:') ? job.target : `sip:${job.target}@${process.env.SIP_DOMAIN || '127.0.0.1'}`;
      const { dialog } = await callHandler.makeOutboundCall(target, from);
      const callId = dialog.id || `sched-${Date.now()}`;
      activeCalls.set(callId, { callId, to: job.target, from, target, startedAt: now, dialog });
      dialog.once('destroy', () => {
        activeCalls.delete(callId);
        if (global.botSettings && job.message) global.botSettings.greeting = prevGreeting;
      });
      logger.info('Scheduler call initiated', { job: job.id, callId });
    } catch (err) {
      logger.error('Scheduler call failed', { job: job.id, error: err.message });
      if (global.botSettings && job.message) global.botSettings.greeting = prevGreeting;
    }

    // Compute next run
    if (job.repeat === 'once') {
      job.enabled = false;
      job.nextAt = null;
    } else {
      job.nextAt = computeNextAt(job);
    }
    saveScheduler();
  }
}, 30000);

// ── Twilio integration — PSTN DID → Gemini Live via Media Streams ─────────

// μ-law codec helpers (G.711 8kHz ↔ PCM 16-bit)
function mulawDecode(u) {
  u = ~u & 0xFF;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  let v = ((mantissa << 1) | 1) << (exp + 2);
  return sign ? -v : v;
}
function mulawEncode(s) {
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > 8191) s = 8191;
  s += 33;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
  const mantissa = (s >> (exp + 3)) & 0x0F;
  return (~(sign | (exp << 4) | mantissa)) & 0xFF;
}

function upsample8to16(pcm8) {
  const out = new Int16Array(pcm8.length * 2);
  for (let i = 0; i < pcm8.length; i++) {
    out[i * 2] = pcm8[i];
    out[i * 2 + 1] = i + 1 < pcm8.length ? Math.round((pcm8[i] + pcm8[i + 1]) / 2) : pcm8[i];
  }
  return out;
}
function downsample24to8(pcm16) {
  const ratio = 3; // 24000/8000
  const out = new Int16Array(Math.floor(pcm16.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = pcm16[i * ratio];
  return out;
}

// Twilio API helper
function twilioRequest(method, path, formData) {
  const sid = botSettings.twilioAccountSid;
  const token = botSettings.twilioAuthToken;
  if (!sid || !token) return Promise.reject(new Error('Twilio not configured'));
  return new Promise((resolve, reject) => {
    const body = formData ? new URLSearchParams(formData).toString() : null;
    const opts = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${sid}${path}`,
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: 10000,
    };
    const req2 = require('https').request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }); }
      });
    });
    req2.on('error', reject);
    req2.on('timeout', () => { req2.destroy(); reject(new Error('Twilio timeout')); });
    if (body) req2.write(body);
    req2.end();
  });
}

// TwiML webhook — Twilio calls this when a call arrives on the DID
app.post('/api/twilio/voice', express.urlencoded({ extended: false }), (req, res) => {
  const publicUrl = botSettings.twilioPublicUrl || `https://${req.headers.host}`;
  const streamUrl = publicUrl.replace(/^https?/, 'wss') + '/api/twilio/stream';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}"/>
  </Connect>
</Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
  logger.info('Twilio voice webhook — streaming to', { streamUrl });
});

// List Twilio phone numbers
app.get('/api/twilio/numbers', async (req, res) => {
  try {
    const r = await twilioRequest('GET', '/IncomingPhoneNumbers.json');
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.message || 'Twilio error' });
    const numbers = (r.data.incoming_phone_numbers || []).map(n => ({
      sid: n.sid, phoneNumber: n.phone_number, friendlyName: n.friendly_name, voiceUrl: n.voice_url
    }));
    res.json({ numbers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configure a Twilio number to route to our webhook
app.post('/api/twilio/configure/:sid', async (req, res) => {
  const publicUrl = botSettings.twilioPublicUrl || `https://${req.headers.host}`;
  const voiceUrl = publicUrl.replace(/\/+$/, '') + '/api/twilio/voice';
  try {
    const r = await twilioRequest('POST', `/IncomingPhoneNumbers/${req.params.sid}.json`, { VoiceUrl: voiceUrl, VoiceMethod: 'POST' });
    if (r.status < 300) res.json({ ok: true, voiceUrl });
    else res.status(r.status).json({ error: r.data?.message || 'Twilio error' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search available Twilio numbers
app.get('/api/twilio/search', async (req, res) => {
  const country = req.query.country || 'US';
  const areaCode = req.query.areaCode || '';
  try {
    const qs = areaCode ? `?AreaCode=${areaCode}&SmsEnabled=false` : '?SmsEnabled=false';
    const r = await twilioRequest('GET', `/AvailablePhoneNumbers/${country}/Local.json${qs}`);
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.message || 'Twilio error' });
    const numbers = (r.data.available_phone_numbers || []).slice(0, 10).map(n => ({
      phoneNumber: n.phone_number, friendlyName: n.friendly_name, region: n.region
    }));
    res.json({ numbers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Buy a Twilio number
app.post('/api/twilio/buy', async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });
  const publicUrl = botSettings.twilioPublicUrl || `https://${req.headers.host}`;
  const voiceUrl = publicUrl.replace(/\/+$/, '') + '/api/twilio/voice';
  try {
    const r = await twilioRequest('POST', '/IncomingPhoneNumbers.json', { PhoneNumber: phoneNumber, VoiceUrl: voiceUrl, VoiceMethod: 'POST' });
    if (r.status < 300) {
      botSettings.twilioPhoneNumber = r.data.phone_number;
      saveSettings();
      res.json({ ok: true, phoneNumber: r.data.phone_number, sid: r.data.sid });
    } else {
      res.status(r.status).json({ error: r.data?.message || 'Twilio error' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Calendar integration (iCal URL reader) ───────────────────────────────
function parseIcal(text) {
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const events = [];
  let inEvent = false, current = {};
  for (const line of unfolded.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') { inEvent = true; current = {}; continue; }
    if (trimmed === 'END:VEVENT') { inEvent = false; events.push(current); continue; }
    if (!inEvent) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const keyFull = trimmed.slice(0, colon).toUpperCase();
    const key = keyFull.split(';')[0];
    const val = trimmed.slice(colon + 1);
    current[key] = val;
  }
  return events;
}

function parseIcalDate(str) {
  if (!str) return null;
  const s = str.replace(/Z$/, '');
  if (s.length === 8) return new Date(parseInt(s.slice(0,4)), parseInt(s.slice(4,6))-1, parseInt(s.slice(6,8)));
  if (s.length >= 15) return new Date(parseInt(s.slice(0,4)), parseInt(s.slice(4,6))-1, parseInt(s.slice(6,8)), parseInt(s.slice(9,11)), parseInt(s.slice(11,13)), parseInt(s.slice(13,15)));
  return null;
}

async function fetchCalendarEvents(daysAhead = 7) {
  const url = (botSettings.calendarUrl || '').trim();
  if (!url) return [];
  const text = await new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
    const req2 = mod.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req2.on('error', reject);
    req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
  });
  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 86400000);
  return parseIcal(text)
    .map(e => ({ title: e.SUMMARY || 'אירוע', location: e.LOCATION || '', start: parseIcalDate(e.DTSTART), end: parseIcalDate(e.DTEND) }))
    .filter(e => e.start && e.start >= now && e.start <= end)
    .sort((a, b) => a.start - b.start);
}
global.fetchCalendarEvents = fetchCalendarEvents;

app.get('/api/calendar/events', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const events = await fetchCalendarEvents(days);
    res.json({ events: events.map(e => ({ title: e.title, location: e.location, start: e.start?.toISOString(), end: e.end?.toISOString() })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/test', async (req, res) => {
  try {
    const events = await fetchCalendarEvents(30);
    res.json({ ok: true, count: events.length, next: events[0] ? { title: events[0].title, start: events[0].start?.toISOString() } : null });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── IVR Builder ───────────────────────────────────────────────────────────
const IVR_FILE = path.join(AUDIO_DIR, '..', 'ivr.json');

const defaultIvr = {
  enabled: false,
  greeting: 'ברוכים הבאים. לחצו 1 לשיחה עם הבוט. לחצו 2 להשארת הודעה.',
  timeout: 5,
  timeoutAction: 'ai',
  nodes: [
    { digit: '1', label: 'שיחה עם הבוט', action: 'ai', value: '' },
    { digit: '2', label: 'השאר הודעה', action: 'voicemail', value: '' }
  ]
};

let ivrConfig = { ...defaultIvr };
try {
  if (fs.existsSync(IVR_FILE)) ivrConfig = { ...defaultIvr, ...JSON.parse(fs.readFileSync(IVR_FILE, 'utf8')) };
} catch (_) {}
global.ivrConfig = ivrConfig;

function saveIvr() {
  try { fs.writeFileSync(IVR_FILE, JSON.stringify(ivrConfig, null, 2)); } catch (_) {}
}

app.get('/api/ivr', (req, res) => res.json(ivrConfig));

app.post('/api/ivr', (req, res) => {
  const { enabled, greeting, timeout, timeoutAction, nodes } = req.body || {};
  if (enabled !== undefined) ivrConfig.enabled = !!enabled;
  if (greeting !== undefined) ivrConfig.greeting = greeting;
  if (timeout !== undefined) ivrConfig.timeout = Number(timeout);
  if (timeoutAction !== undefined) ivrConfig.timeoutAction = timeoutAction;
  if (nodes !== undefined) ivrConfig.nodes = nodes;
  global.ivrConfig = ivrConfig;
  saveIvr();
  res.json({ success: true, ivr: ivrConfig });
});

// ── Multi-tenant SaaS ─────────────────────────────────────────────────────
const TENANTS_FILE = path.join(AUDIO_DIR, '..', 'tenants.json');
let tenants = [];
try { if (fs.existsSync(TENANTS_FILE)) tenants = JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8')); } catch (_) {}

function saveTenants() {
  try { fs.writeFileSync(TENANTS_FILE, JSON.stringify(tenants, null, 2)); } catch (_) {}
}

function getTenantDir(id) {
  const dir = path.join(AUDIO_DIR, 'tenants', id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ['recordings', 'voicemails'].forEach(sub => {
    const s = path.join(dir, sub);
    if (!fs.existsSync(s)) fs.mkdirSync(s, { recursive: true });
  });
  return dir;
}

function loadTenantData(id, file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(getTenantDir(id), file), 'utf8')); } catch (_) { return fallback; }
}
function saveTenantData(id, file, data) {
  fs.writeFileSync(path.join(getTenantDir(id), file), JSON.stringify(data, null, 2));
}

// Resolve tenant from a called DID or SIP extension
global.resolveTenantForCall = function(calledNumber, calledExtension) {
  for (const t of tenants) {
    const s = loadTenantData(t.id, 'settings.json', {});
    if (calledNumber) {
      const norm = n => (n || '').replace(/[^0-9+]/g, '');
      if (s.twilioPhoneNumber && norm(s.twilioPhoneNumber) === norm(calledNumber)) return { tenant: t, settings: s };
      if (s.vonagePhoneNumber && norm(s.vonagePhoneNumber) === norm(calledNumber)) return { tenant: t, settings: s };
      if (s.sipDid && norm(s.sipDid) === norm(calledNumber)) return { tenant: t, settings: s };
    }
    if (calledExtension && s.extension && String(s.extension) === String(calledExtension)) {
      return { tenant: t, settings: s };
    }
  }
  return null;
};

// Super-admin auth
function requireSuperAdmin(req, res, next) {
  const user = process.env.SUPER_ADMIN_USER || 'superadmin';
  const pass = process.env.SUPER_ADMIN_PASS || 'superadmin2024';
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const idx = decoded.indexOf(':');
    if (decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="CallMe Super Admin"');
  res.status(401).send('Super Admin authentication required');
}

// Tenant-level auth
function requireTenantAuth(req, res, next) {
  const s = req.tenantSettings || {};
  const user = s.adminUser || 'admin';
  const pass = s.adminPass || 'callme2024';
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const idx = decoded.indexOf(':');
    if (decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Tenant Dashboard"');
  res.status(401).send('Authentication required');
}

// Tenant middleware — load tenant context
app.param('tenantId', (req, res, next, tenantId) => {
  const tenant = tenants.find(t => t.id === tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  req.tenantId = tenantId;
  req.tenant = tenant;
  req.tenantDir = getTenantDir(tenantId);
  req.tenantSettings = loadTenantData(tenantId, 'settings.json', {});
  next();
});

// Super-admin panel
app.get('/admin', requireSuperAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/tenants', requireSuperAdmin, (req, res) => {
  res.json(tenants.map(t => {
    const s = loadTenantData(t.id, 'settings.json', {});
    return { ...t, dashboardUrl: `/t/${t.id}/`, botName: s.name || 'CallMe Bot', extension: s.extension || '' };
  }));
});

app.post('/admin/tenants', requireSuperAdmin, (req, res) => {
  const { name, id: rawId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = (rawId || name).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 32);
  if (tenants.find(t => t.id === id)) return res.status(409).json({ error: 'Tenant ID already exists' });
  const tenant = { id, name, createdAt: new Date().toISOString() };
  tenants.push(tenant);
  saveTenants();
  getTenantDir(id);
  saveTenantData(id, 'settings.json', { ...defaultSettings, name, adminUser: 'admin', adminPass: 'callme2024' });
  logger.info('Tenant created', { id, name });
  res.json({ success: true, tenant, dashboardUrl: `/t/${id}/` });
});

app.delete('/admin/tenants/:tenantId', requireSuperAdmin, (req, res) => {
  const { tenantId } = req.params;
  tenants = tenants.filter(t => t.id !== tenantId);
  saveTenants();
  res.json({ success: true });
});

// Tenant dashboard — serve index.html with injected API prefix
app.get('/t/:tenantId', requireTenantAuth, (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  html = html.replace("const API = '';", `const API = '/t/${req.tenantId}';`);
  res.send(html);
});
app.get('/t/:tenantId/', requireTenantAuth, (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  html = html.replace("const API = '';", `const API = '/t/${req.tenantId}';`);
  res.send(html);
});

// Tenant API — settings
app.get('/t/:tenantId/api/settings', requireTenantAuth, (req, res) => {
  const s = req.tenantSettings;
  res.json({ ...s, sipPassword: s.sipPassword ? '✓ set' : '', adminPass: s.adminPass ? '✓ set' : '' });
});

app.post('/t/:tenantId/api/settings', requireTenantAuth, (req, res) => {
  const merged = { ...req.tenantSettings };
  const skip = ['sipPassword', 'adminPass', 'twilioAuthToken', 'vonageApiSecret', 'whatsappApiKey'];
  Object.entries(req.body || {}).forEach(([k, v]) => {
    if (skip.includes(k) && !v) return; // keep existing if empty
    merged[k] = v;
  });
  saveTenantData(req.tenantId, 'settings.json', merged);
  res.json({ success: true });
});

// Tenant API — IVR
app.get('/t/:tenantId/api/ivr', requireTenantAuth, (req, res) => {
  res.json(loadTenantData(req.tenantId, 'ivr.json', defaultIvr));
});
app.post('/t/:tenantId/api/ivr', requireTenantAuth, (req, res) => {
  saveTenantData(req.tenantId, 'ivr.json', req.body);
  res.json({ success: true, ivr: req.body });
});

// Tenant API — contacts
app.get('/t/:tenantId/api/contacts', requireTenantAuth, (req, res) => {
  res.json(loadTenantData(req.tenantId, 'contacts.json', []));
});
app.post('/t/:tenantId/api/contacts', requireTenantAuth, (req, res) => {
  const contacts = loadTenantData(req.tenantId, 'contacts.json', []);
  contacts.push({ ...req.body, id: Date.now().toString() });
  saveTenantData(req.tenantId, 'contacts.json', contacts);
  res.json({ success: true });
});
app.delete('/t/:tenantId/api/contacts/:contactId', requireTenantAuth, (req, res) => {
  let contacts = loadTenantData(req.tenantId, 'contacts.json', []);
  contacts = contacts.filter(c => c.id !== req.params.contactId);
  saveTenantData(req.tenantId, 'contacts.json', contacts);
  res.json({ success: true });
});

// Tenant API — recordings
app.get('/t/:tenantId/api/recordings', requireTenantAuth, (req, res) => {
  try {
    const dir = path.join(req.tenantDir, 'recordings');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    res.json(files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } }).filter(Boolean));
  } catch (_) { res.json([]); }
});

// Tenant API — voicemails
app.get('/t/:tenantId/api/voicemails', requireTenantAuth, (req, res) => {
  try {
    const dir = path.join(req.tenantDir, 'voicemails');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    res.json(files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } }).filter(Boolean));
  } catch (_) { res.json([]); }
});

// Tenant API — live token (for browser web call auth)
app.get('/t/:tenantId/api/live-token', requireTenantAuth, (req, res) => {
  const s = req.tenantSettings;
  const user = s.adminUser || 'admin';
  const pass = s.adminPass || 'callme2024';
  res.json({ token: Buffer.from(`${user}:${pass}`).toString('base64') });
});

// ── Recordings (call transcripts) ────────────────────────────────────────
const RECORDINGS_DIR = path.join(AUDIO_DIR, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

app.get('/api/recordings', (req, res) => {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('.json'));
    const recordings = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, f), 'utf8'));
        return { file: f, callId: data.callId, callerName: data.callerName, durationS: data.durationS, savedAt: data.savedAt, lines: data.transcript?.length || 0 };
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.json({ recordings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recordings/:file', (req, res) => {
  const filePath = path.join(RECORDINGS_DIR, path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/recordings/:file', (req, res) => {
  const filePath = path.join(RECORDINGS_DIR, path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

// ── Voicemails ────────────────────────────────────────────────────────────
const VOICEMAILS_DIR = path.join(AUDIO_DIR, 'voicemails');
if (!fs.existsSync(VOICEMAILS_DIR)) fs.mkdirSync(VOICEMAILS_DIR, { recursive: true });

// Serve voicemail audio files
app.use('/voicemail-audio', express.static(VOICEMAILS_DIR));

app.get('/api/voicemails', (req, res) => {
  try {
    const files = fs.readdirSync(VOICEMAILS_DIR).filter(f => f.endsWith('.json'));
    const vms = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(VOICEMAILS_DIR, f), 'utf8'));
        return { file: f, ...data };
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.json({ voicemails: vms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/voicemails/:file', (req, res) => {
  const base = path.basename(req.params.file).replace('.json', '');
  const jsonPath = path.join(VOICEMAILS_DIR, base + '.json');
  const wavPath = path.join(VOICEMAILS_DIR, base + '.wav');
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(jsonPath);
  if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  res.json({ success: true });
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
        const testUrl = name === 'teamy' ? cfg.url + '/bots' :
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

// Live token endpoint — browser fetches this to auth the WS browser-call
app.get('/api/live-token', (req, res) => {
  const { user, pass } = getAdminCreds();
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  // WS_PUBLIC_URL allows overriding the WS host when behind Cloudflare (no HTTP/2 WS support)
  // e.g. WS_PUBLIC_URL=ws://10.0.0.4:3101 or wss://callme.right-api.com
  const wsBase = process.env.WS_PUBLIC_URL || null;
  res.json({ token, wsBase });
});

// Start health server — keep reference so we can attach WS
const httpServer = app.listen(config.healthPort, '0.0.0.0', () => {
  logger.info(`Health server listening on port ${config.healthPort}`);
});

// ── Browser WebCall WS bridge (same port as dashboard — works with Traefik WSS) ──
{
  const { Server: WsServer } = require('ws');
  const GeminiLiveSession = require('./gemini-live/session');

  // noServer: true + manual upgrade handling avoids ws v8 perMessageDeflate conflict.
  // ALL WS servers must use noServer:true so their internal handlers never call
  // abortHandshake() on sockets belonging to other paths (which injects raw HTTP
  // bytes into an already-upgraded WS stream, setting RSV1=1 and killing the conn).
  const browserWss = new WsServer({ noServer: true, perMessageDeflate: false });

  // Shared WS route registry — other blocks register here before server.listen()
  if (!global._wsRoutes) global._wsRoutes = {};

  global._wsRoutes['/api/browser-call'] = (req, socket, head) => {
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      browserWss.emit('connection', ws, req);
    });
  };

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = req.url.split('?')[0];
    const handler = global._wsRoutes[pathname];
    if (handler) {
      handler(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  browserWss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const { user, pass } = getAdminCreds();
    const expectedToken = Buffer.from(`${user}:${pass}`).toString('base64');
    if (token !== expectedToken) {
      logger.warn('BrowserCall auth failed', { receivedToken: token && token.slice(0,8), expectedToken: expectedToken.slice(0,8) });
      ws.close(4401, 'Unauthorized'); return;
    }

    const sessionId = `browser-${Date.now()}`;
    logger.info('Browser WebCall connected', { sessionId });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { logger.error('BrowserCall: GEMINI_API_KEY missing'); ws.close(4500, 'GEMINI_API_KEY not configured'); return; }

    let session = null;
    let configured = false;
    let audioChunks = [];
    let scheduledTime = 0;

    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;
    const MIN_SPEECH_FRAMES = 15;
    let speaking = false, silenceCount = 0, speechCount = 0;
    let waitingForGemini = false, waitingTimer = null;

    const calcRms = (buf) => {
      let sum = 0;
      for (let i = 0; i + 1 < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
      return Math.sqrt(sum / (buf.length / 2));
    };
    const sendStatus = (state) => { try { ws.send(JSON.stringify({ type: 'status', state })); } catch(_) {} };
    const sendTranscript = (role, text) => { try { ws.send(JSON.stringify({ type: 'transcript', role, text })); } catch(_) {} };

    ws.on('message', async (data, isBinary) => {
      if (!configured) {
        // If binary arrives before JSON config (race on reconnect), auto-configure with defaults
        let cfg = {};
        if (!isBinary) {
          try { cfg = JSON.parse(data.toString()); }
          catch (err) {
            logger.warn('BrowserCall: invalid JSON config, using defaults', { sessionId });
          }
        }
        try {
          const settings = global.botSettings || {};
          session = new GeminiLiveSession({
            callId: sessionId, apiKey,
            systemPrompt: cfg.systemPrompt || settings.persona || 'You are a helpful voice assistant named CallMe Bot. Respond in Hebrew.',
            language: cfg.language || settings.language || 'he',
            voiceConfig: { voice_config: { prebuilt_voice_config: { voice_name: cfg.voice || settings.voice || 'Kore' } } },
          });
          // If this was a binary message, process it as audio after configuration

          session.on('audio', (chunk) => {
            audioChunks.push(chunk);
            const total = audioChunks.reduce((s, c) => s + c.length, 0);
            if (total >= 48000) {
              const pcm = Buffer.concat(audioChunks); audioChunks = [];
              if (ws.readyState === ws.OPEN) ws.send(pcm);
            }
          });
          session.on('turn_complete', () => {
            waitingForGemini = false;
            if (audioChunks.length) { const pcm = Buffer.concat(audioChunks); audioChunks = []; if (ws.readyState === ws.OPEN) ws.send(pcm); }
            sendStatus('listening');
          });
          session.on('interrupted', () => { audioChunks = []; waitingForGemini = false; sendStatus('listening'); });
          session.on('input_transcript', (text) => sendTranscript('user', text));
          session.on('output_transcript', (text) => sendTranscript('bot', text));
          session.on('error', (err) => logger.error('BrowserCall session error', { sessionId, error: err.message }));

          await session.connect();
          configured = true;
          sendStatus('ready');
          const greeting = (global.botSettings || {}).greeting || 'שלום! ברך את המשתמש בקצרה בעברית.';
          session.sendText(greeting);
          sendStatus('thinking');
        } catch (err) {
          logger.error('BrowserCall setup error', { sessionId, error: err.message });
          ws.close(4500, err.message);
        }
        return;
      }

      if (!isBinary || !session || waitingForGemini) return;
      const rms = calcRms(data);
      if (rms > SPEECH_RMS_THRESHOLD) {
        silenceCount = 0; speechCount++;
        if (!speaking && speechCount >= 2) { speaking = true; session.sendActivityStart(); sendStatus('listening'); }
        if (speaking) session.sendAudio(data);
      } else if (speaking) {
        silenceCount++; session.sendAudio(data);
        if (silenceCount >= SILENCE_FRAMES_NEEDED) {
          if (speechCount >= MIN_SPEECH_FRAMES) {
            session.sendActivityEnd(); waitingForGemini = true; sendStatus('thinking');
            if (waitingTimer) clearTimeout(waitingTimer);
            waitingTimer = setTimeout(() => { waitingForGemini = false; }, 10000);
          } else { session.sendActivityEnd(); }
          speaking = false; silenceCount = 0; speechCount = 0;
        }
      } else { speechCount = 0; }
    });

    ws.on('close', (code, reason) => {
      logger.info('BrowserCall disconnected', { sessionId, code, reason: reason && reason.toString() });
      if (waitingTimer) clearTimeout(waitingTimer);
      if (session) { try { if (speaking) session.sendActivityEnd(); session.close(); } catch(_) {} }
    });
    ws.on('error', (err) => logger.error('BrowserCall WS error', { sessionId, error: err.message }));
  });

  logger.info('Browser WebCall WS attached to port', { port: config.healthPort });
}

// ── Vonage Voice integration — PSTN DID → Gemini Live via WebSocket ─────────

// Downsample 24kHz → 16kHz (linear interpolation, 3:2 ratio)
function downsample24to16(pcm24) {
  const outLen = Math.floor(pcm24.length * 2 / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * 1.5;
    const lo = Math.floor(src), hi = Math.min(lo + 1, pcm24.length - 1);
    out[i] = Math.round(pcm24[lo] * (1 - (src - lo)) + pcm24[hi] * (src - lo));
  }
  return out;
}

// Vonage REST helper
function vonageRequest(method, path, body) {
  const key = botSettings.vonageApiKey;
  const secret = botSettings.vonageApiSecret;
  if (!key || !secret) return Promise.reject(new Error('Vonage not configured'));
  return new Promise((resolve, reject) => {
    const qs = `api_key=${encodeURIComponent(key)}&api_secret=${encodeURIComponent(secret)}`;
    const fullPath = path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`;
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'rest.nexmo.com',
      path: fullPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 10000,
    };
    const req2 = require('https').request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }); }
      });
    });
    req2.on('error', reject);
    req2.on('timeout', () => { req2.destroy(); reject(new Error('Vonage timeout')); });
    if (bodyStr) req2.write(bodyStr);
    req2.end();
  });
}

// NCCO webhook — Vonage calls this when a call arrives on the DID
app.get('/api/vonage/voice', (req, res) => {
  const publicUrl = botSettings.vonagePublicUrl || `https://${req.headers.host}`;
  const streamUrl = publicUrl.replace(/^https?/, 'wss') + '/api/vonage/stream';
  res.json([{
    action: 'connect',
    endpoint: [{
      type: 'websocket',
      uri: streamUrl,
      'content-type': 'audio/l16;rate=16000',
      headers: { callId: req.query.uuid || '' },
    }],
  }]);
  logger.info('Vonage NCCO webhook', { streamUrl, uuid: req.query.uuid });
});

app.post('/api/vonage/voice', (req, res) => {
  // Same as GET — Vonage may POST depending on config
  const publicUrl = botSettings.vonagePublicUrl || `https://${req.headers.host}`;
  const streamUrl = publicUrl.replace(/^https?/, 'wss') + '/api/vonage/stream';
  res.json([{
    action: 'connect',
    endpoint: [{
      type: 'websocket',
      uri: streamUrl,
      'content-type': 'audio/l16;rate=16000',
      headers: { callId: req.body?.uuid || req.query.uuid || '' },
    }],
  }]);
});

// Vonage event webhook (required by Vonage)
app.post('/api/vonage/event', (req, res) => {
  logger.info('Vonage call event', { event: req.body?.status, uuid: req.body?.uuid });
  res.status(200).end();
});

// List owned Vonage numbers
app.get('/api/vonage/numbers', async (req, res) => {
  try {
    const r = await vonageRequest('GET', '/account/numbers');
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.error_title || 'Vonage error' });
    const numbers = (r.data.numbers || []).map(n => ({
      msisdn: n.msisdn, country: n.country, type: n.type, voiceCallbackValue: n.voiceCallbackValue
    }));
    res.json({ numbers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Configure a Vonage number to route to our NCCO webhook
app.post('/api/vonage/configure/:msisdn', async (req, res) => {
  const publicUrl = botSettings.vonagePublicUrl || `https://${req.headers.host}`;
  const voiceUrl = publicUrl.replace(/\/+$/, '') + '/api/vonage/voice';
  try {
    const r = await vonageRequest('POST', '/number/update', {
      country: req.body?.country || 'IL',
      msisdn: req.params.msisdn,
      'voiceCallbackType': 'app',
      'voiceCallbackValue': voiceUrl,
    });
    if (r.status < 300) res.json({ ok: true, voiceUrl });
    else res.status(r.status).json({ error: r.data?.error_title || 'Vonage error' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Search available Vonage numbers
app.get('/api/vonage/search', async (req, res) => {
  const country = req.query.country || 'IL';
  const pattern = req.query.pattern || '';
  try {
    const path = `/number/search?country=${country}${pattern ? '&pattern=' + encodeURIComponent(pattern) : ''}&features=VOICE&size=10`;
    const r = await vonageRequest('GET', path);
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.error_title || 'Vonage error' });
    const numbers = (r.data.numbers || []).slice(0, 10).map(n => ({
      msisdn: n.msisdn, country: n.country, cost: n.cost, type: n.type
    }));
    res.json({ numbers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Buy a Vonage number
app.post('/api/vonage/buy', async (req, res) => {
  const { msisdn, country } = req.body || {};
  if (!msisdn) return res.status(400).json({ error: 'msisdn required' });
  const publicUrl = botSettings.vonagePublicUrl || `https://${req.headers.host}`;
  const voiceUrl = publicUrl.replace(/\/+$/, '') + '/api/vonage/voice';
  try {
    const buyR = await vonageRequest('POST', '/number/buy', { country: country || 'IL', msisdn });
    if (buyR.status >= 300) return res.status(buyR.status).json({ error: buyR.data?.error_title || 'Buy failed' });
    // Configure webhook
    await vonageRequest('POST', '/number/update', { country: country || 'IL', msisdn, voiceCallbackType: 'app', voiceCallbackValue: voiceUrl });
    botSettings.vonagePhoneNumber = msisdn;
    saveSettings();
    res.json({ ok: true, msisdn });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Twilio Media Streams WebSocket handler ─────────────────────────────────
{
  const { Server: WsServer } = require('ws');
  const GeminiLiveSession = require('./gemini-live/session');

  const twilioWss = new WsServer({ noServer: true, perMessageDeflate: false });

  if (!global._wsRoutes) global._wsRoutes = {};
  global._wsRoutes['/api/twilio/stream'] = (req, socket, head) => {
    twilioWss.handleUpgrade(req, socket, head, (ws) => twilioWss.emit('connection', ws, req));
  };

  twilioWss.on('connection', (ws) => {
    const callId = `twilio-${Date.now()}`;
    logger.info('Twilio Media Stream connected', { callId });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { ws.close(1011, 'GEMINI_API_KEY not configured'); return; }

    let streamSid = null;
    let session = null;
    let audioChunks24k = [];

    const flushToTwilio = () => {
      if (!audioChunks24k.length || !streamSid) return;
      const pcm24 = Buffer.concat(audioChunks24k); audioChunks24k = [];
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, Math.floor(pcm24.length / 2));
      const samples8 = downsample24to8(samples24);
      const mulaw = Buffer.alloc(samples8.length);
      for (let i = 0; i < samples8.length; i++) mulaw[i] = mulawEncode(samples8[i]);
      const payload = mulaw.toString('base64');
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    };

    let waitingForGemini = false;

    const startSession = async () => {
      const settings = global.botSettings || {};
      session = new GeminiLiveSession({
        callId, apiKey,
        systemPrompt: settings.persona || 'You are a helpful voice assistant named CallMe Bot. Respond in Hebrew.',
        language: settings.language || 'he',
        voiceConfig: { voice_config: { prebuilt_voice_config: { voice_name: settings.voice || 'Kore' } } },
      });
      session.on('audio', (chunk) => {
        audioChunks24k.push(chunk);
        if (audioChunks24k.reduce((s, c) => s + c.length, 0) >= 24000) flushToTwilio();
      });
      session.on('turn_complete', () => { flushToTwilio(); waitingForGemini = false; });
      session.on('interrupted', () => { audioChunks24k = []; waitingForGemini = false; });
      session.on('input_transcript', (t) => logger.info('Twilio caller said', { callId, t }));
      session.on('output_transcript', (t) => logger.info('Twilio bot said', { callId, t }));
      session.on('error', (err) => logger.error('Twilio Gemini error', { callId, error: err.message }));
      await session.connect();
      const greeting = settings.greeting || 'שלום! איך אני יכול לעזור?';
      session.sendText(greeting);
      logger.info('Twilio Gemini session ready', { callId });
    };

    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;
    const MIN_SPEECH_FRAMES = 15;
    let speaking = false, silenceCount = 0, speechCount = 0;
    let waitingTimer = null;

    const calcRmsI16 = (buf) => {
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length);
    };

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.event === 'start') {
          streamSid = msg.start.streamSid;
          logger.info('Twilio stream started', { callId, streamSid });
          try { await startSession(); } catch(err) { logger.error('Twilio session start failed', { callId, error: err.message }); }
        } else if (msg.event === 'media' && session) {
          const mulaw = Buffer.from(msg.media.payload, 'base64');
          const pcm8 = new Int16Array(mulaw.length);
          for (let i = 0; i < mulaw.length; i++) pcm8[i] = mulawDecode(mulaw[i]);
          const pcm16 = upsample8to16(pcm8);
          const buf16 = Buffer.from(pcm16.buffer);
          if (waitingForGemini) return;
          const rms = calcRmsI16(pcm16);
          if (rms > SPEECH_RMS_THRESHOLD) {
            silenceCount = 0; speechCount++;
            if (!speaking && speechCount >= 2) { speaking = true; session.sendActivityStart(); }
            if (speaking) session.sendAudio(buf16);
          } else if (speaking) {
            silenceCount++; session.sendAudio(buf16);
            if (silenceCount >= SILENCE_FRAMES_NEEDED) {
              if (speechCount >= MIN_SPEECH_FRAMES) {
                session.sendActivityEnd(); waitingForGemini = true;
                if (waitingTimer) clearTimeout(waitingTimer);
                waitingTimer = setTimeout(() => { waitingForGemini = false; }, 10000);
              } else { session.sendActivityEnd(); }
              speaking = false; silenceCount = 0; speechCount = 0;
            }
          } else { speechCount = 0; }
        } else if (msg.event === 'stop') {
          logger.info('Twilio stream stopped', { callId });
        }
      } catch(e) { logger.error('Twilio WS message error', { callId, error: e.message }); }
    });

    ws.on('close', () => {
      logger.info('Twilio Media Stream closed', { callId });
      if (waitingTimer) clearTimeout(waitingTimer);
      if (session) { try { if (speaking) session.sendActivityEnd(); session.close(); } catch(_) {} }
    });
    ws.on('error', (err) => logger.error('Twilio WS error', { callId, error: err.message }));
  });

  logger.info('Twilio Media Streams WS attached to port', { port: config.healthPort });
}

// ── Vonage WebSocket Audio handler ─────────────────────────────────────────
{
  const { Server: WsServer } = require('ws');
  const GeminiLiveSession = require('./gemini-live/session');

  const vonageWss = new WsServer({ noServer: true, perMessageDeflate: false });

  if (!global._wsRoutes) global._wsRoutes = {};
  global._wsRoutes['/api/vonage/stream'] = (req, socket, head) => {
    vonageWss.handleUpgrade(req, socket, head, (ws) => vonageWss.emit('connection', ws, req));
  };

  vonageWss.on('connection', (ws) => {
    const callId = `vonage-${Date.now()}`;
    logger.info('Vonage WS stream connected', { callId });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { ws.close(1011, 'GEMINI_API_KEY not configured'); return; }

    let session = null;
    let configured = false;
    let audioChunks = [];

    const flushToVonage = () => {
      if (!audioChunks.length) return;
      const pcm24 = Buffer.concat(audioChunks); audioChunks = [];
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, Math.floor(pcm24.length / 2));
      const samples16 = downsample24to16(samples24);
      ws.send(Buffer.from(samples16.buffer));
    };

    let waitingForGemini = false;
    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;
    const MIN_SPEECH_FRAMES = 15;
    let speaking = false, silenceCount = 0, speechCount = 0, waitingTimer = null;

    const calcRms = (buf) => {
      const s = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i] * s[i];
      return Math.sqrt(sum / s.length);
    };

    const startSession = async () => {
      const settings = global.botSettings || {};
      session = new GeminiLiveSession({
        callId, apiKey,
        systemPrompt: settings.persona || 'You are a helpful voice assistant named CallMe Bot. Respond in Hebrew.',
        language: settings.language || 'he',
        voiceConfig: { voice_config: { prebuilt_voice_config: { voice_name: settings.voice || 'Kore' } } },
      });
      session.on('audio', (chunk) => {
        audioChunks.push(chunk);
        if (audioChunks.reduce((s, c) => s + c.length, 0) >= 32000) flushToVonage();
      });
      session.on('turn_complete', () => { flushToVonage(); waitingForGemini = false; });
      session.on('interrupted', () => { audioChunks = []; waitingForGemini = false; });
      session.on('input_transcript', (t) => logger.info('Vonage caller said', { callId, t }));
      session.on('output_transcript', (t) => logger.info('Vonage bot said', { callId, t }));
      session.on('error', (err) => logger.error('Vonage Gemini error', { callId, error: err.message }));
      await session.connect();
      session.sendText((global.botSettings || {}).greeting || 'שלום! איך אני יכול לעזור?');
      logger.info('Vonage Gemini session ready', { callId });
    };

    ws.on('message', async (data, isBinary) => {
      if (!configured) {
        // First message may be JSON metadata from Vonage
        if (!isBinary) {
          try {
            const meta = JSON.parse(data.toString());
            logger.info('Vonage WS metadata', { callId, meta });
          } catch(_) {}
          try { await startSession(); } catch(err) { logger.error('Vonage session start failed', { callId, error: err.message }); }
          configured = true;
          return;
        }
        // If first message is binary (some Vonage versions), start immediately
        try { await startSession(); } catch(err) { logger.error('Vonage session start failed', { callId, error: err.message }); }
        configured = true;
      }

      if (!isBinary || !session || waitingForGemini) return;

      // Vonage sends 16kHz linear16 PCM directly — no conversion needed for Gemini input
      const rms = calcRms(data);
      if (rms > SPEECH_RMS_THRESHOLD) {
        silenceCount = 0; speechCount++;
        if (!speaking && speechCount >= 2) { speaking = true; session.sendActivityStart(); }
        if (speaking) session.sendAudio(data);
      } else if (speaking) {
        silenceCount++; session.sendAudio(data);
        if (silenceCount >= SILENCE_FRAMES_NEEDED) {
          if (speechCount >= MIN_SPEECH_FRAMES) {
            session.sendActivityEnd(); waitingForGemini = true;
            if (waitingTimer) clearTimeout(waitingTimer);
            waitingTimer = setTimeout(() => { waitingForGemini = false; }, 10000);
          } else { session.sendActivityEnd(); }
          speaking = false; silenceCount = 0; speechCount = 0;
        }
      } else { speechCount = 0; }
    });

    ws.on('close', () => {
      logger.info('Vonage WS closed', { callId });
      if (waitingTimer) clearTimeout(waitingTimer);
      if (session) { try { if (speaking) session.sendActivityEnd(); session.close(); } catch(_) {} }
    });
    ws.on('error', (err) => logger.error('Vonage WS error', { callId, error: err.message }));
  });

  logger.info('Vonage WebSocket handler attached to port', { port: config.healthPort });
}

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
