const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger');
const GeminiLiveManager = require('./gemini-live/manager');
const GroqPipelineManager = require('./groq-pipeline/manager');
const { resolveGoogleTtsKeyPath } = require('./groq-pipeline/tts-config');

const CONVERSATION_ENGINE = process.env.CONVERSATION_ENGINE || 'stt-tts';
const WS_PORT = parseInt(process.env.WS_PORT || '3001');
const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS || '300000');

const geminiManager = new GeminiLiveManager();
const groqManager = new GroqPipelineManager();

function calcRms(buf) {
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / (buf.length / 2));
}

function stripVideoFromSdp(sdp) {
  if (!sdp) return sdp;
  const lines = sdp.split('\n');
  let skipVideo = false;
  return lines.filter(line => {
    if (line.startsWith('m=video')) { skipVideo = true; return false; }
    if (line.startsWith('m=') && !line.startsWith('m=video')) skipVideo = false;
    return !skipVideo;
  }).join('\n');
}

class CallHandler {
  constructor(srf, sessionManager, sttTtsManager, metrics, audioForkServer, audioConfig = {}) {
    this.srf = srf;
    this.sessionManager = sessionManager;
    this.sttTts = sttTtsManager;
    this.metrics = metrics;
    this.audioForkServer = audioForkServer;
    this.audioDir = audioConfig.audioDir || '/tmp/voice-worker-audio';
    this.audioPort = audioConfig.audioPort || 3101;
    this.mediaServer = null;
    this._callContexts = new Map(); // callId → { endpoint, dialog }
  }

  setMediaServer(mediaServer) {
    this.mediaServer = mediaServer;
  }

  async handleInvite(req, res) {
    const callId = req.get('Call-ID');
    logger.info('Inbound call received', { callId, engine: CONVERSATION_ENGINE });
    this.metrics.initCall(callId);

    if (!this.mediaServer) {
      logger.error('Media server not ready', { callId });
      try { res.send(503); } catch (_) {}
      return;
    }

    // Extract caller/called number for tenant resolution + contact lookup
    const fromHeader = req.get('From') || '';
    const toHeader = req.get('To') || '';
    const callerMatch = fromHeader.match(/sip:([^@>]+)@/);
    const calledMatch = toHeader.match(/sip:([^@>]+)@/);
    const callerRaw = callerMatch ? callerMatch[1] : '';
    const calledRaw = calledMatch ? calledMatch[1] : '';

    // Resolve tenant (multi-tenant mode) — falls back to global settings
    let tenantSettings = null;
    let resolvedTenantId = null;
    if (global.resolveTenantForCall) {
      const resolved = global.resolveTenantForCall(calledRaw, calledRaw);
      if (resolved) {
        tenantSettings = resolved.settings;
        resolvedTenantId = resolved.tenant.id;
        this._currentTenantId = resolvedTenantId;
        logger.info('Tenant resolved for call', { callId, tenantId: resolvedTenantId });
      }
    }
    // Use tenant settings if resolved, otherwise fall back to global
    const effectiveSettings = tenantSettings || global.botSettings || {};
    const effectiveContacts = tenantSettings ? (global.tenantContacts && global.tenantContacts[calledRaw]) : global.contacts;

    // Look up in contacts
    const contactList = effectiveContacts || global.contacts || [];
    const callerContact = callerRaw
      ? contactList.find(c => {
          const normalized = (c.phone || '').replace(/[^0-9+]/g, '');
          const rawNorm = callerRaw.replace(/[^0-9+]/g, '');
          return normalized && rawNorm && (normalized.endsWith(rawNorm) || rawNorm.endsWith(normalized));
        })
      : null;

    const callerName = callerContact ? callerContact.name : null;
    if (callerName) {
      logger.info('Caller identified', { callId, callerName, callerRaw });
    }

    // Check blacklist/whitelist before accepting the call
    if (global.checkCallFilter) {
      const filterResult = global.checkCallFilter(callerRaw);
      if (!filterResult.allowed) {
        logger.info('Call rejected by filter', { callId, caller: callerRaw, reason: filterResult.reason });
        if (global.addAuditEntry) global.addAuditEntry('call.filtered', `${callerRaw} — ${filterResult.reason}`, 'system');
        try { res.send(403); } catch (_) {}
        return;
      }
    }

    // Call Queue — if bot is busy and queue is enabled
    const activeSessions = global.activeSessions;
    const maxConcurrent = 1; // single-call bot
    if (global.callQueue && (global.botSettings || {}).callQueueEnabled && activeSessions && activeSessions.size >= maxConcurrent) {
      const queued = global.enqueueCall(callerRaw, callerName);
      if (queued) {
        logger.info('Call queued (bot busy)', { callId, caller: callerRaw, queueSize: global.callQueue.length });
        // Play queue message and hang up — caller will get a callback
        try { res.send(486, { headers: { 'Retry-After': '60' } }); } catch (_) {}
        return;
      }
    }

    try {
      const audioOnlySdp = stripVideoFromSdp(req.body);
      const { endpoint, dialog } = await this.mediaServer.connectCaller(req, res, {
        remoteSdp: audioOnlySdp
      });

      const callStartedAt = Date.now();
      logger.info('Call connected', { callId, uuid: endpoint.uuid });
      this._callContexts.set(callId, { endpoint, dialog });
      if (global.fireWebhook) global.fireWebhook('call.started', { callId, direction: 'inbound', callerName, callerNumber: callerRaw, startedAt: callStartedAt });

      dialog.on('destroy', () => {
        const durationS = Math.round((Date.now() - callStartedAt) / 1000);
        logger.info('Call ended', { callId, durationS });
        this._callContexts.delete(callId);
        if (global.activeSessions) global.activeSessions.delete(callId);
        geminiManager.close(callId);
        groqManager.close(callId);
        this.audioForkServer.unregister(callId);
        endpoint.destroy().catch(() => {});
        this.metrics.record(callId, 'endCall', 'hangup');
        this.metrics.finalize(callId);
        if (global.fireWebhook) global.fireWebhook('call.ended', { callId, direction: 'inbound', callerName, callerNumber: callerRaw, startedAt: callStartedAt, durationS });
        // Track potential spam (very short calls)
        if (global.trackPotentialSpam) global.trackPotentialSpam(callerRaw, durationS);
        // Send call summary with transcript (deferred to allow transcript to be collected)
        setTimeout(() => {
          this._sendCallSummary('inbound', callId, callerName, callerRaw, durationS, transcript);
        }, 500);
      });

      // Use per-tenant IVR config if tenant was resolved, else fall back to global
      const ivrCfg = tenantSettings ? null : global.ivrConfig; // tenant IVR not loaded here yet — use global for now
      const aiEnabled = effectiveSettings.aiEnabled !== false; // default true
      const dailyLimit = parseFloat(effectiveSettings.aiDailyCostLimitUsd) || 0;
      const monthlyLimit = parseFloat(effectiveSettings.aiMonthlyCostLimitUsd) || 0;
      // Use per-tenant recordings dir if tenant resolved, otherwise global
      const costRecDir = resolvedTenantId && global.getTenantRecordingsDir
        ? global.getTenantRecordingsDir(resolvedTenantId)
        : null;
      let costLimitReached = false;
      if (dailyLimit > 0) {
        const todayCost = costRecDir && global.getTodayCostUsdForDir
          ? global.getTodayCostUsdForDir(costRecDir)
          : (global.getTodayCostUsd ? global.getTodayCostUsd() : 0);
        if (todayCost >= dailyLimit) {
          costLimitReached = true;
          logger.warn('Daily cost limit reached — routing to voicemail', { callId, todayCost, dailyLimit, tenantId: resolvedTenantId });
        }
      }
      if (!costLimitReached && monthlyLimit > 0) {
        const monthCost = costRecDir && global.getMonthCostUsdForDir
          ? global.getMonthCostUsdForDir(costRecDir)
          : (global.getMonthCostUsd ? global.getMonthCostUsd() : 0);
        if (monthCost >= monthlyLimit) {
          costLimitReached = true;
          logger.warn('Monthly cost limit reached — routing to voicemail', { callId, monthCost, monthlyLimit, tenantId: resolvedTenantId });
        }
      }
      if (!aiEnabled || costLimitReached) {
        logger.info('AI engine disabled or limit reached — routing to voicemail', { callId });
        await this._handleVoicemail(endpoint, dialog, callId, callerName);
      } else if (CONVERSATION_ENGINE === 'gemini-live' && ivrCfg && ivrCfg.enabled) {
        await this._handleIvrCall(endpoint, dialog, callId, callerName, effectiveSettings);
      } else if (CONVERSATION_ENGINE === 'gemini-live') {
        await this._handleGeminiLiveCall(endpoint, dialog, callId, callerName, effectiveSettings);
      } else {
        await this._handleSttTtsCall(endpoint, dialog, callId);
      }

    } catch (err) {
      logger.error('Call handling error', { callId, error: err.message });
      try { res.send(500); } catch (_) {}
      this.metrics.record(callId, 'endCall', 'error');
    }
  }

  // ── Outbound call ────────────────────────────────────────────────────────

  async makeOutboundCall(target, from, opts = {}) {
    if (!this.mediaServer) throw new Error('Media server not ready');

    const callId = `outbound-${Date.now()}`;
    logger.info('Initiating outbound call', { callId, target, from });

    const endpoint = await this.mediaServer.createEndpoint();
    const settings = global.botSettings || {};
    const sipDomain = process.env.SIP_DOMAIN || settings.sipServer || '127.0.0.1';
    const registrarHost = process.env.SIP_REGISTRAR || settings.sipRegistrar || '127.0.0.1';
    const registrarPort = parseInt(process.env.SIP_REGISTRAR_PORT || '5060', 10);
    const outboundProxy = process.env.SIP_OUTBOUND_PROXY || `sip:${registrarHost}:${registrarPort};transport=udp`;
    const fromExtension = from || settings.sipExtension || settings.extension || process.env.SIP_EXTENSION;
    const authUsername = process.env.SIP_AUTH_ID || process.env.SIP_AUTH_USERNAME || settings.sipAuthId || fromExtension;
    const authPassword = process.env.SIP_AUTH_PASSWORD || process.env.SIP_PASSWORD || settings.sipPassword || '';
    const localSdp = endpoint.local && endpoint.local.sdp;
    const sipUri = target.startsWith('sip:')
      ? (target.includes('transport=') ? target : `${target};transport=udp`)
      : `sip:${target}@${sipDomain};transport=udp`;

    const uacOptions = {
      localSdp,
      proxy: outboundProxy,
      localSipUri: `sip:${fromExtension}@${sipDomain}`,
      headers: {
        'From': `<sip:${fromExtension}@${sipDomain}>`,
        'User-Agent': 'OpenClaw-VoiceServer/1.0',
        'X-Call-ID': callId,
      },
    };

    if (authUsername && authPassword) {
      uacOptions.auth = {
        username: authUsername,
        password: authPassword,
      };
    }

    const sip = await this.srf.createUAC(sipUri, uacOptions, {
      cbRequest: (err) => {
        if (err) logger.error('INVITE send failed', { callId, error: err.message });
      },
      cbProvisional: (res) => {
        logger.info('Outbound provisional response', {
          callId,
          status: res.status,
          reason: res.reason,
        });
      },
    });

    if (sip.remote && sip.remote.sdp) {
      await endpoint.modify(sip.remote.sdp);
      logger.info('Outbound media connection established', { callId });
    }

    sip.on('destroy', () => {
      logger.info('Outbound call ended', { callId });
      geminiManager.close(callId);
      groqManager.close(callId);
      this.audioForkServer.unregister(callId);
      endpoint.destroy().catch(() => {});
    });

    if (CONVERSATION_ENGINE === 'gemini-live') {
      const overrideSettings = opts.systemPrompt
        ? { ...(global.botSettings || {}), persona: opts.systemPrompt }
        : null;
      this._handleGeminiLiveCall(endpoint, sip, callId, null, overrideSettings).catch((err) => {
        logger.error('Outbound Gemini call error', { callId, error: err.message });
      });
    }

    return { endpoint, dialog: sip };
  }

  // ── Gemini Live path ─────────────────────────────────────────────────────

  async _handleGeminiLiveCall(endpoint, dialog, callId, callerName = null, overrideSettings = null) {
    const callStartedAt = Date.now();
    const transcript = [];
    // Store transcript reference for live viewing
    const ctx = this._callContexts.get(callId);
    if (ctx) { ctx.transcript = transcript; ctx.callerName = callerName; ctx.startedAt = callStartedAt; }
    const settings = overrideSettings || global.botSettings || {};
    let systemPrompt = settings.persona || process.env.GEMINI_SYSTEM_PROMPT ||
      'You are a helpful voice assistant named CallMe Bot. The caller speaks Hebrew. Always respond in Hebrew. The audio may have phone quality noise — do your best to understand Hebrew speech.';
    if (callerName) {
      systemPrompt += `\n\nThe caller's name is ${callerName}. Address them by name naturally.`;
    }
    if (settings.rules) {
      systemPrompt += `\n\n## Rules\n${settings.rules}`;
    }
    if (settings.knowledge) {
      systemPrompt += `\n\n## Knowledge Base\n${settings.knowledge}`;
    }
    if (settings.escalationTurns && settings.escalationNumber) {
      systemPrompt += `\n\nIf the caller needs to speak with a human or you cannot help after ${settings.escalationTurns} exchanges, say you are transferring them and end the call.`;
    }

    // Response style — appended before language lock
    const responseStyle = settings.responseStyle || 'concise';
    if (responseStyle === 'brief') {
      systemPrompt += '\n\n## Response Length\nAnswer in ONE sentence only. Never elaborate. Never ask follow-up questions unless essential.';
    } else if (responseStyle === 'concise') {
      systemPrompt += '\n\n## Response Length\nKeep answers to 1-2 sentences. Be direct and to the point. Do not over-explain.';
    }
    // 'detailed' = no constraint added

    // Hard language lock — always appended regardless of persona
    const lang = settings.language || 'he';
    if (lang === 'auto') {
      systemPrompt += '\n\n## Response language\nAutomatically detect the language the caller is speaking and respond in the SAME language. If the caller speaks Hebrew — answer in Hebrew. If English — answer in English. If Arabic — answer in Arabic. Always match the caller\'s language.';
    } else if (lang === 'he') {
      systemPrompt += '\n\n## שפת תגובה\nחובה לענות תמיד בעברית בלבד — גם אם המתקשר דיבר בשפה אחרת. אל תענה בערבית, אנגלית, או כל שפה אחרת. תמיד עברית.';
    } else if (lang === 'en') {
      systemPrompt += '\n\n## Response language\nAlways respond in English only, regardless of what language the caller used.';
    } else if (lang === 'ar') {
      systemPrompt += '\n\n## لغة الاستجابة\nيجب الرد دائماً باللغة العربية فقط.';
    } else if (lang === 'ru') {
      systemPrompt += '\n\n## Язык ответа\nВсегда отвечайте только на русском языке, независимо от языка звонящего.';
    } else if (lang === 'fr') {
      systemPrompt += '\n\n## Langue de réponse\nRépondez toujours en français uniquement.';
    } else if (lang === 'es') {
      systemPrompt += '\n\n## Idioma de respuesta\nResponde siempre únicamente en español.';
    }

    const integrations = global.integrations || {};
    // Tool toggles — default true unless explicitly disabled
    const toolToggles = {
      findContact:    settings.toolFindContact    !== false,
      addContact:     settings.toolAddContact     !== false,
      scheduleCall:   settings.toolScheduleCall   !== false,
      calendar:       settings.toolCalendar       !== false,
      homeAssistant:  settings.toolHomeAssistant  !== false,
      transferCall:   settings.toolTransferCall   !== false,
    };

    const toolDeclarations = [];
    const activeToolNames = [];

    if (toolToggles.findContact) {
      toolDeclarations.push({
        name: 'find_contact',
        description: 'Search the contacts book by name. Returns phone number and contact info.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Contact name to search for' } },
          required: ['name']
        }
      });
      activeToolNames.push('find_contact — חיפוש איש קשר לפי שם');
    }

    if (toolToggles.addContact) {
      toolDeclarations.push({
        name: 'add_contact',
        description: 'Save a new contact to the address book.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Contact name' },
            phone: { type: 'string', description: 'Phone number or SIP URI' }
          },
          required: ['name', 'phone']
        }
      });
      activeToolNames.push('add_contact — שמירת איש קשר חדש');
    }

    if (toolToggles.scheduleCall) {
      toolDeclarations.push({
        name: 'add_scheduled_call',
        description: 'Schedule a future outbound call. Use when user says "remind me", "call me at", "call X tomorrow", etc.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Phone number or contact name to call' },
            time: { type: 'string', description: 'Time in HH:MM format (24h)' },
            message: { type: 'string', description: 'What the bot should say when the call is answered' },
            repeat: { type: 'string', description: 'once, daily, or weekdays', enum: ['once', 'daily', 'weekdays'] }
          },
          required: ['target', 'time']
        }
      });
      activeToolNames.push('add_scheduled_call — תזמון שיחה עתידית');
    }

    toolDeclarations.push({
      name: 'get_bot_status',
      description: 'Get current bot statistics: active calls, total calls today, SIP registration status.',
      parameters: { type: 'object', properties: {} }
    });

    if (toolToggles.calendar && (global.botSettings || {}).calendarUrl) {
      toolDeclarations.push({
        name: 'check_calendar',
        description: 'Check the user calendar for upcoming events. Use when asked about schedule, appointments, "what do I have today/tomorrow", etc.',
        parameters: {
          type: 'object',
          properties: { days: { type: 'number', description: 'How many days ahead to look (default 1 = today, 7 = this week)' } }
        }
      });
      toolDeclarations.push({
        name: 'add_calendar_event',
        description: 'Schedule a new calendar event. Adds to scheduler and sends a Google Calendar creation link via Telegram.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title' },
            date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
            time: { type: 'string', description: 'Time in HH:MM 24h format' },
            duration: { type: 'number', description: 'Duration in minutes (default 60)' },
            location: { type: 'string', description: 'Location or Zoom link (optional)' }
          },
          required: ['title', 'date', 'time']
        }
      });
      activeToolNames.push('check_calendar — בדיקת יומן', 'add_calendar_event — הוספת אירוע ליומן');
    }

    if (toolToggles.homeAssistant && integrations.ha?.enabled && integrations.ha?.url) {
      toolDeclarations.push({
        name: 'control_home_assistant',
        description: 'Control smart home devices via Home Assistant. Turn lights on/off, adjust temperature, lock doors, etc.',
        parameters: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'HA domain: light, switch, climate, lock, script, etc.' },
            service: { type: 'string', description: 'HA service: turn_on, turn_off, toggle, set_temperature, etc.' },
            entity_id: { type: 'string', description: 'HA entity ID, e.g. light.living_room' }
          },
          required: ['domain', 'service']
        }
      });
      activeToolNames.push('control_home_assistant — שליטה בבית חכם (Home Assistant)');
    }

    // Transfer call tool
    if (toolToggles.transferCall) {
    toolDeclarations.push({
      name: 'transfer_call',
      description: 'Transfer the current call to another phone number or extension. Use this when the caller asks to speak with a human, a specific person, or another department. You can look up the contact first with find_contact.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Phone number, SIP extension, or contact name to transfer to' },
          announce: { type: 'string', description: 'Optional announcement to say before transferring, e.g. "מעביר אותך עכשיו"' },
        },
        required: ['target']
      }
    });
    activeToolNames.push('transfer_call — העברת שיחה לשלוחה או מספר אחר');
    }

    // Custom tools from dashboard
    const customTools = settings.customTools || [];
    for (const ct of customTools) {
      if (!ct.enabled || !ct.name) continue;
      toolDeclarations.push({
        name: ct.name,
        description: ct.description || ct.name,
        parameters: { type: 'object', properties: { input: { type: 'string', description: 'User input for this tool' } } }
      });
      activeToolNames.push(`${ct.name} — ${ct.description || ''}`);
    }

    // Inject active tools list into system prompt so the bot knows its capabilities
    if (activeToolNames.length > 0) {
      systemPrompt += `\n\n## כלים זמינים\nיש לך גישה לכלים הבאים — השתמש בהם באופן יזום כשרלוונטי:\n${activeToolNames.map(t => `- ${t}`).join('\n')}`;
    }

    const voiceName = settings.voice || 'Kore';
    const aiEngine = settings.aiEngine || 'gemini-live';
    const useGroqPipeline = aiEngine === 'groq-pipeline';
    let session;
    try {
      if (useGroqPipeline) {
        // Build tool handler for Groq pipeline (same logic as Gemini tool_call handler below)
        const pipelineToolHandler = async (name, args) => {
          return this._handleToolCall(name, args, callId, settings);
        };
        const callLang = settings.language || process.env.CALL_LANGUAGE || 'he';
        session = await groqManager.getOrCreate(callId, {
          deepgramApiKey: settings.deepgramApiKey,
          groqApiKey: settings.groqApiKey,
          systemPrompt,
          language: callLang === 'auto' ? 'multi' : callLang,
          tools: toolDeclarations,
          toolHandler: pipelineToolHandler,
          ttsConfig: {
            voiceName: settings.ttsVoice || undefined,
            googleKeyPath: resolveGoogleTtsKeyPath(),
          },
        });
      } else {
        session = await geminiManager.getOrCreate(callId, {
          systemPrompt,
          language: settings.language || process.env.CALL_LANGUAGE || 'he',
          model: settings.geminiModel || undefined,
          apiKey: settings.geminiApiKey || undefined,
          voiceConfig: {
            voice_config: {
              prebuilt_voice_config: { voice_name: voiceName }
            }
          },
          tools: toolDeclarations,
        });
      }
    } catch (err) {
      logger.error(`${useGroqPipeline ? 'GroqPipeline' : 'Gemini'} unavailable — voicemail mode`, { callId, error: err.message });
      await this._handleVoicemail(endpoint, dialog, callId, callerName);
      return;
    }

    let audioChunks = [];

    // Register in global session map so inject endpoint can reach this call
    if (global.activeSessions) global.activeSessions.set(callId, session);

    session.on('error', (err) => {
      logger.error('GeminiLive session error', { callId, error: err.message });
    });

    session.on('input_transcript', (text) => {
      logger.info('Caller said', { callId, text });
      transcript.push({ role: 'user', text, ts: Date.now() });
    });

    session.on('output_transcript', (text) => {
      logger.info('Bot said', { callId, text });
      transcript.push({ role: 'bot', text, ts: Date.now() });
    });

    // Suppress audio input until the first greeting has been played, then during
    // bot playback + 800ms after (reduced from 1500ms for faster responsiveness)
    let isPlaying = false;
    let postPlaySuppressUntil = 0;
    let firstPlayDone = false;
    const ECHO_SUPPRESS_MS = 800;

    // Serialized playback queue — only one WAV playing at a time
    const playQueue = [];
    let playBusy = false;

    const drainQueue = async () => {
      if (playBusy || !playQueue.length) return;
      playBusy = true;
      isPlaying = true;
      while (playQueue.length) {
        const pcm = playQueue.shift();
        const t0 = Date.now();
        logger.info('Playing Gemini response', { callId, bytes: pcm.length });
        try {
          const wavFile = await this._savePcmAsWav(pcm, callId);
          await endpoint.play(wavFile);
          fs.unlink(wavFile, () => {});
          logger.debug('Playback done', { callId, ms: Date.now() - t0 });
        } catch (err) {
          logger.error('Playback error', { callId, error: err.message });
        }
      }
      isPlaying = false;
      firstPlayDone = true;
      postPlaySuppressUntil = Date.now() + ECHO_SUPPRESS_MS;
      playBusy = false;
    };

    const enqueueAudio = (pcm) => {
      playQueue.push(pcm);
      drainQueue();
    };

    // Streaming playback: flush once we have 1s of audio (48000 bytes at 24kHz 16-bit),
    // then flush the remainder on turn_complete. This starts playback ~1-2s earlier than
    // waiting for the full response, while still avoiding choppy tiny-fragment gaps.
    const STREAM_START_BYTES = 48000; // 1 second of 24kHz 16-bit PCM
    let streamStartFlushed = false;

    const flushAudio = () => {
      if (!audioChunks.length) return;
      const pcm = Buffer.concat(audioChunks);
      audioChunks = [];
      enqueueAudio(pcm);
    };

    session.on('audio', (chunk) => {
      audioChunks.push(chunk);
      if (!streamStartFlushed) {
        const totalBytes = audioChunks.reduce((s, c) => s + c.length, 0);
        if (totalBytes >= STREAM_START_BYTES) {
          streamStartFlushed = true;
          flushAudio();
        }
      }
    });

    session.on('turn_complete', () => {
      waitingForGemini = false;
      streamStartFlushed = false;
      flushAudio(); // flush any remaining audio not yet played
    });

    session.on('interrupted', () => {
      const wasPlaying = isPlaying;
      audioChunks = [];
      waitingForGemini = false;
      streamStartFlushed = false;
      // Only clear the play queue if we're actually playing audio.
      // If Gemini sends 'interrupted' while we're NOT playing (e.g. it interrupted
      // its own generation before we started playing), preserve the queued audio.
      if (wasPlaying) {
        playQueue.length = 0;
        isPlaying = false;
      }
      logger.info('Barge-in detected', { callId, wasPlaying });
    });

    session.on('tool_call', async (functionCalls) => {
      const responses = [];
      for (const fc of functionCalls) {
        const result = await this._handleToolCall(fc.name, fc.args, callId, settings);
        responses.push({ id: fc.id, name: fc.name, response: { output: result } });
      }
      session.sendToolResponse(responses);
    });

    // Send initial greeting — personalized if caller is known
    let greeting = (global.botSettings || {}).greeting || 'שלום! ברך את המשתמש בקצרה בעברית.';
    if (callerName) {
      greeting = `שלום ${callerName}! ברך את ${callerName} בשמו בקצרה בעברית.`;
      logger.info('Personalized greeting for known caller', { callId, callerName });
    }
    session.sendText(greeting);

    // ── Audio input handling ──
    // For Groq pipeline: Deepgram handles VAD internally, so just forward all audio.
    // For Gemini Live: manual energy-based VAD with activity markers.
    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;
    const MIN_SPEECH_FRAMES = 15;

    let speaking = false;
    let silenceCount = 0;
    let speechCount = 0;
    let waitingForGemini = false;
    let waitingForGeminiTimer = null;
    const GEMINI_RESPONSE_TIMEOUT_MS = 10000;

    this.audioForkServer.register(callId, {
      onAudio: (buf) => {
        if (!firstPlayDone || isPlaying) return;

        if (useGroqPipeline) {
          // Groq pipeline: send all audio directly to Deepgram STT
          session.sendAudio(buf);
          return;
        }

        // Gemini Live: manual VAD
        if (waitingForGemini) return;

        const rms = calcRms(buf);

        if (rms > SPEECH_RMS_THRESHOLD) {
          silenceCount = 0;
          speechCount++;
          if (!speaking && speechCount >= 2) {
            speaking = true;
            session.sendActivityStart();
            logger.debug('Speech start', { callId, rms: rms.toFixed(0) });
          }
          if (speaking) session.sendAudio(buf);
        } else {
          if (speaking) {
            silenceCount++;
            session.sendAudio(buf);
            if (silenceCount >= SILENCE_FRAMES_NEEDED) {
              if (speechCount >= MIN_SPEECH_FRAMES) {
                session.sendActivityEnd();
                waitingForGemini = true;
                if (waitingForGeminiTimer) clearTimeout(waitingForGeminiTimer);
                waitingForGeminiTimer = setTimeout(() => {
                  waitingForGemini = false;
                  logger.warn('Gemini response timeout — unlocking input', { callId });
                }, GEMINI_RESPONSE_TIMEOUT_MS);
                logger.info('Speech end → sent to Gemini', { callId, speechFrames: speechCount });
              } else {
                session.sendActivityEnd();
                logger.debug('Speech too short, closing activity', { callId, speechFrames: speechCount });
              }
              speaking = false;
              silenceCount = 0;
              speechCount = 0;
            }
          } else {
            speechCount = 0;
          }
        }
      },
      onClose: () => {
        if (waitingForGeminiTimer) clearTimeout(waitingForGeminiTimer);
        if (speaking) session.sendActivityEnd();
        session.close();
      }
    });

    // Start audio fork — FreeSWITCH will connect to our shared WS server
    const wsUrl = `ws://127.0.0.1:${WS_PORT}/${encodeURIComponent(callId)}`;
    logger.info('Starting audio fork', { callId, wsUrl });

    await new Promise((resolve) => {
      endpoint.forkAudioStart({
        wsUrl,
        mixType: 'mono',
        sampling: '16k',
      }).then(() => {
        logger.info('Audio fork started', { callId });
      }).catch((err) => {
        logger.error('forkAudioStart failed', { callId, error: err.message });
        resolve();
      });

      // Wait until call ends
      const onDestroy = () => resolve();
      dialog.once('destroy', onDestroy);

      setTimeout(() => {
        dialog.removeListener('destroy', onDestroy);
        logger.warn('Call max duration reached', { callId });
        resolve();
      }, MAX_CALL_DURATION_MS);
    });

    // Save transcript after call ends
    if (transcript.length > 0) {
      const durationS = Math.round((Date.now() - callStartedAt) / 1000);
      this._saveRecording(callId, callerName, durationS, transcript);
    }
  }

  /**
   * Handle a tool call from either Gemini or Groq pipeline.
   * @param {string} name - tool function name
   * @param {object} args - tool arguments
   * @param {string} callId
   * @param {object} settings - effective bot settings
   * @returns {object} result
   */
  async _handleToolCall(name, args, callId, settings) {
    logger.info('Tool call', { callId, tool: name, args });
    try {
      if (name === 'find_contact') {
        const query = (args.name || '').toLowerCase();
        const found = (global.contacts || []).filter(c => c.name.toLowerCase().includes(query));
        if (found.length === 0) return { found: false, message: 'No contact found with that name' };
        if (found.length === 1) return { found: true, name: found[0].name, phone: found[0].phone };
        return { found: true, multiple: true, contacts: found.map(c => ({ name: c.name, phone: c.phone })) };
      } else if (name === 'add_scheduled_call') {
        const { target, time, message, repeat } = args;
        let resolvedTarget = target;
        if (!/\d{5,}/.test(target) && !target.startsWith('sip:')) {
          const contact = (global.contacts || []).find(c => c.name.toLowerCase().includes(target.toLowerCase()));
          if (contact) resolvedTarget = contact.phone;
        }
        const job = { id: `j-${Date.now()}`, name: target, target: resolvedTarget, message: message || '', time, repeat: repeat || 'once', enabled: true, createdAt: Date.now(), lastRan: null };
        const [hh, mm] = time.split(':').map(Number);
        const next = new Date(); next.setHours(hh, mm, 0, 0);
        if (next <= new Date()) next.setDate(next.getDate() + 1);
        job.nextAt = next.getTime();
        (global.scheduledJobs || []).push(job);
        if (global.saveScheduler) global.saveScheduler();
        return { success: true, scheduledFor: next.toLocaleTimeString('he-IL'), target: resolvedTarget };
      } else if (name === 'get_bot_status') {
        const stats = global.metrics ? global.metrics.getStats() : {};
        return {
          activeCalls: global.activeCalls ? global.activeCalls.size : 0,
          totalCalls: stats.totalCalls || 0,
          successfulCalls: stats.successfulCalls || 0,
          contacts: (global.contacts || []).length,
          scheduledJobs: (global.scheduledJobs || []).filter(j => j.enabled).length,
        };
      } else if (name === 'add_contact') {
        const { name: contactName, phone } = args;
        const contact = { id: `c-${Date.now()}`, name: contactName, phone, notes: '', createdAt: Date.now() };
        (global.contacts || []).push(contact);
        if (global.saveContacts) global.saveContacts();
        return { success: true, message: `Saved ${contactName} as ${phone}` };
      } else if (name === 'check_calendar') {
        const days = args.days || 1;
        if (global.fetchCalendarEvents) {
          const events = await global.fetchCalendarEvents(days);
          if (events.length === 0) return { found: false, message: `No events in the next ${days} day(s)` };
          return { found: true, count: events.length, events: events.slice(0, 5).map(e => ({
            title: e.title,
            start: e.start?.toLocaleString('he-IL', { weekday: 'long', hour: '2-digit', minute: '2-digit' }),
            location: e.location || undefined,
          })) };
        }
        return { error: 'Calendar not configured' };
      } else if (name === 'add_calendar_event') {
        const { title, date, time, duration, location } = args;
        // Schedule a local reminder
        const next = new Date(`${date}T${time}:00`);
        const job = { id: `cal-${Date.now()}`, name: title, target: '', message: `תזכורת: ${title}`, time, repeat: 'once', enabled: true, createdAt: Date.now(), lastRan: null, nextAt: next.getTime() };
        (global.scheduledJobs || []).push(job);
        if (global.saveScheduler) global.saveScheduler();

        // Try OAuth calendar first, then SA, then fallback to link
        let gcResult = null;
        const tenantId = this._currentTenantId || 'global';
        if (global.goauth && global.goauth.isConnected(tenantId, process.env.AUDIO_DIR || '/tmp/voice-worker-audio')) {
          try {
            const { calendar } = global.goauth.getCalendarClient(tenantId, process.env.AUDIO_DIR || '/tmp/voice-worker-audio');
            const startDt2 = new Date(`${date}T${time}:00`);
            const endDt2 = new Date(startDt2.getTime() + (duration || 60) * 60000);
            const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jerusalem';
            const res = await calendar.events.insert({
              calendarId: 'primary',
              resource: {
                summary: title,
                start: { dateTime: startDt2.toISOString(), timeZone },
                end: { dateTime: endDt2.toISOString(), timeZone },
                ...(location ? { location } : {}),
              },
            });
            gcResult = { id: res.data.id, htmlLink: res.data.htmlLink };
            logger.info('Calendar event created via OAuth', { callId, eventId: gcResult.id });
          } catch (err) {
            logger.warn('OAuth calendar create failed, trying SA', { error: err.message });
          }
        }
        if (!gcResult && global.gcal && global.gcal.isAvailable()) {
          try {
            gcResult = await global.gcal.createEvent({ title, date, time, duration: duration || 60, location });
            logger.info('Calendar event created via SA', { callId, eventId: gcResult.id });
          } catch (err) {
            logger.warn('SA calendar create failed, falling back to link', { error: err.message });
          }
        }

        if (global.sendTelegramMessage) {
          if (gcResult) {
            global.sendTelegramMessage(`📅 <b>אירוע נוסף ליומן</b>\n📌 ${title}\n🕐 ${date} ${time}${location ? '\n📍 ' + location : ''}\n✅ נוסף ישירות ל-Google Calendar`);
          } else {
            const startDt = `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
            const endDt = (() => { const e = new Date(next.getTime() + (duration || 60) * 60000); return e.toISOString().replace(/[-:]/g, '').slice(0, 15); })();
            const gcUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${startDt}/${endDt}${location ? '&location=' + encodeURIComponent(location) : ''}`;
            global.sendTelegramMessage(`📅 <b>אירוע חדש נוסף</b>\n📌 ${title}\n🕐 ${date} ${time}\n<a href="${gcUrl}">הוסף לGoogle Calendar</a>`);
          }
        }
        return { success: true, message: gcResult ? `Event "${title}" added to Google Calendar for ${date} at ${time}.` : `Event "${title}" scheduled for ${date} at ${time}. A Google Calendar link was sent to Telegram.` };
      } else if (name === 'control_home_assistant') {
        const { domain, service, entity_id } = args;
        if (global.callHaService) {
          const r = await global.callHaService(domain, service, entity_id ? { entity_id } : {});
          return { success: true, response: r };
        }
        return { success: false, error: 'Home Assistant not configured' };
      } else if (name === 'transfer_call') {
        let { target, announce } = args;
        // Resolve contact name to number
        if (target && !/\d{3,}/.test(target) && !target.startsWith('sip:')) {
          const contact = (global.contacts || []).find(c => c.name.toLowerCase().includes(target.toLowerCase()));
          if (contact) {
            logger.info('Transfer: resolved contact', { callId, name: target, phone: contact.phone });
            target = contact.phone;
          }
        }
        const ctx = this._callContexts.get(callId);
        if (!ctx || !ctx.endpoint) {
          return { success: false, error: 'Call context not available for transfer' };
        }
        try {
          // Build SIP URI if just a number/extension
          let sipTarget = target;
          if (!target.startsWith('sip:')) {
            const domain = (settings.sipServer || process.env.SIP_DOMAIN || '127.0.0.1:5060');
            sipTarget = `sip:${target}@${domain}`;
          }
          logger.info('Transferring call', { callId, target: sipTarget, announce });
          // Execute blind transfer via FreeSWITCH endpoint
          await ctx.endpoint.execute('transfer', target);
          if (global.sendTelegramMessage && settings.telegramCallSummary) {
            global.sendTelegramMessage(`🔀 <b>שיחה הועברה</b>\n📱 יעד: ${target}\n🆔 ${callId.slice(0, 12)}`);
          }
          return { success: true, message: `Call transferred to ${target}` };
        } catch (err) {
          logger.error('Call transfer failed', { callId, target, error: err.message });
          return { success: false, error: 'Transfer failed: ' + err.message };
        }
      } else {
        // Check custom tools
        const customTools = (settings || global.botSettings || {}).customTools || [];
        const customTool = customTools.find(ct => ct.name === name && ct.enabled);
        if (customTool) {
          // Fire webhook if configured
          if (customTool.webhookUrl) {
            try {
              const payload = JSON.stringify({ tool: name, args, callId, timestamp: new Date().toISOString() });
              const url = new URL(customTool.webhookUrl);
              const mod = url.protocol === 'https:' ? require('https') : require('http');
              const resp = await new Promise((resolve, reject) => {
                const req = mod.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 10000 }, (r) => {
                  let data = ''; r.on('data', c => data += c); r.on('end', () => { try { resolve(JSON.parse(data)); } catch(_) { resolve({ result: data }); } });
                });
                req.on('error', reject);
                req.write(payload); req.end();
              });
              return resp;
            } catch (err) {
              return { result: customTool.defaultResponse || 'בוצע', error: err.message };
            }
          }
          return { result: customTool.defaultResponse || 'בוצע' };
        }
        return { error: 'Unknown tool: ' + name };
      }
    } catch (e) {
      logger.error('Tool call error', { callId, tool: name, error: e.message });
      return { error: e.message };
    }
  }

  _estimateCostUsd(durationS, engine) {
    // Gemini 2.5 Flash Native Audio: $0.70/hr input + $5.00/hr output = $5.70/hr combined
    // OpenAI Realtime (GPT-4o):       $6.00/hr input + $12.00/hr output = $18.00/hr combined
    // Groq pipeline: ~$0.66/hr (Deepgram STT + Groq LLM + Google TTS)
    const rates = { 'gemini-live': 5.70, 'openai-realtime': 18.00, 'groq-pipeline': 0.66 };
    const hourlyRate = rates[engine] || rates['gemini-live'];
    return Math.round((durationS / 3600) * hourlyRate * 10000) / 10000; // 4 decimal places
  }

  _saveRecording(callId, callerName, durationS, transcript) {
    const recDir = path.join(this.audioDir, 'recordings');
    try {
      if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
      const safeName = callId.replace(/[^a-z0-9-]/gi, '_');
      const filename = `${safeName}-${Date.now()}.json`;
      const engine = (global.botSettings || {}).aiEngine || 'gemini-live';
      const estimatedCostUsd = this._estimateCostUsd(durationS, engine);
      const data = { callId, callerName, durationS, savedAt: new Date().toISOString(), transcript, engine, estimatedCostUsd };
      fs.writeFileSync(path.join(recDir, filename), JSON.stringify(data, null, 2));
      logger.info('Transcript saved', { callId, filename, lines: transcript.length, estimatedCostUsd });
    } catch (err) {
      logger.error('Failed to save transcript', { callId, error: err.message });
    }
  }

  /**
   * Generate AI summary + intent from transcript using Gemini.
   * @returns {{ summary: string, intent: string, actionItems: string[] } | null}
   */
  async _generateAISummary(transcript) {
    const apiKey = (global.botSettings || {}).geminiApiKey;
    if (!apiKey || !transcript || transcript.length < 2) return null;

    const convo = transcript.map(t => `${t.role === 'user' ? 'מתקשר' : 'בוט'}: ${t.text}`).join('\n');
    const prompt = `אתה מנתח שיחות. קיבלת תמלול שיחה טלפונית. תן תשובה ב-JSON בלבד (בלי markdown):
{"summary":"תקציר של 1-2 משפטים בעברית","intent":"כוונת המתקשר - מילה אחת או שתיים (למשל: קביעת פגישה, שאלה, תלונה, בירור, הזמנה, תמיכה טכנית, אחר)","sentiment":"positive/neutral/negative/frustrated","sentimentScore":0.8,"actionItems":["פעולה 1","פעולה 2"]}

תמלול:
${convo.slice(0, 3000)}`;

    try {
      const https = require('https');
      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
      });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
              // Extract JSON from response (may have markdown wrapping)
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) resolve(JSON.parse(jsonMatch[0]));
              else resolve(null);
            } catch (e) { resolve(null); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });
      if (result && result.summary) {
        logger.info('AI summary generated', { intent: result.intent, actionItems: result.actionItems?.length || 0 });
        return result;
      }
    } catch (err) {
      logger.warn('AI summary generation failed', { error: err.message });
    }
    return null;
  }

  /**
   * Send call summary to Telegram & WhatsApp with AI-generated insights.
   */
  async _sendCallSummary(direction, callId, callerName, callerNumber, durationS, transcript) {
    const settings = global.botSettings || {};
    const dirLabel = direction === 'inbound' ? 'שיחה נכנסת' : 'שיחה יוצאת';
    const mins = Math.floor(durationS / 60);
    const secs = durationS % 60;
    const durationStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')} דק׳` : `${secs} שנ׳`;

    // Generate AI summary
    let aiSection = '';
    let aiData = null;
    try {
      aiData = await this._generateAISummary(transcript);
      if (aiData) {
        aiSection = `\n\n🧠 <b>סיכום AI:</b> ${aiData.summary}`;
        if (aiData.intent) aiSection += `\n🎯 <b>כוונה:</b> ${aiData.intent}`;
        if (aiData.sentiment) {
          const sEmoji = { positive: '😊', neutral: '😐', negative: '😞', frustrated: '😤' };
          aiSection += `\n${sEmoji[aiData.sentiment] || '❓'} <b>רגש:</b> ${aiData.sentiment}`;
        }
        if (aiData.actionItems && aiData.actionItems.length > 0) {
          aiSection += `\n📋 <b>פעולות:</b>\n${aiData.actionItems.map(a => '  • ' + a).join('\n')}`;
        }
        // Save AI summary to recording file
        this._updateRecordingWithAI(callId, aiData);
      }
    } catch (err) {
      logger.warn('AI summary failed', { callId, error: err.message });
    }

    // Fallback: transcript preview if no AI summary
    let preview = '';
    if (!aiData && transcript && transcript.length > 0) {
      const lines = transcript.slice(0, 4).map(t => {
        const role = t.role === 'user' ? '👤' : '🤖';
        const text = (t.text || '').slice(0, 100);
        return `${role} ${text}`;
      });
      preview = '\n\n💬 <b>תקציר:</b>\n' + lines.join('\n');
      if (transcript.length > 4) preview += `\n<i>... עוד ${transcript.length - 4} הודעות</i>`;
    }

    // Telegram notification
    if (global.sendTelegramMessage && settings.telegramCallSummary) {
      const msg = `📞 <b>${dirLabel} הסתיימה</b>\n` +
        `👤 ${callerName || 'לא ידוע'}${callerNumber ? ' (' + callerNumber + ')' : ''}\n` +
        `⏱ ${durationStr}\n` +
        `🆔 ${callId.slice(0, 12)}` +
        aiSection + preview;
      global.sendTelegramMessage(msg);
    }

    // WhatsApp notification
    if (global.sendWhatsappMessage && settings.whatsappCallSummary) {
      const plain = `📞 ${dirLabel} הסתיימה\n👤 ${callerName || 'לא ידוע'}\n⏱ ${durationStr}${aiData ? '\n🧠 ' + aiData.summary : ''}`;
      global.sendWhatsappMessage(plain);
    }

    // SMS notification
    if (global.sendSmsMessage && settings.smsCallSummary) {
      const smsText = `${dirLabel} | ${callerName || 'לא ידוע'} ${callerNumber ? '(' + callerNumber + ')' : ''} | ${durationStr}${aiData ? ' | ' + aiData.summary : ''}`;
      global.sendSmsMessage(smsText);
    }

    // CRM webhook — send structured data to external system
    const crmUrl = settings.crmWebhookUrl;
    if (crmUrl) {
      try {
        const payload = JSON.stringify({
          event: 'call.completed',
          callId,
          direction,
          callerName: callerName || null,
          callerNumber: callerNumber || null,
          durationS,
          timestamp: new Date().toISOString(),
          aiSummary: aiData ? aiData.summary : null,
          aiIntent: aiData ? aiData.intent : null,
          aiActionItems: aiData ? aiData.actionItems : [],
          transcriptLines: transcript ? transcript.length : 0,
        });
        const url = new URL(crmUrl);
        const mod = url.protocol === 'https:' ? require('https') : require('http');
        const sendCrmWebhook = (attempt) => {
          const crmReq = mod.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 10000 }, (r) => {
            r.resume();
            if (r.statusCode >= 400 && attempt < 3) {
              logger.warn('CRM webhook failed, retrying', { callId, status: r.statusCode, attempt });
              setTimeout(() => sendCrmWebhook(attempt + 1), attempt * 5000);
            }
          });
          crmReq.on('error', (e) => {
            logger.warn('CRM webhook error', { error: e.message, attempt });
            if (attempt < 3) setTimeout(() => sendCrmWebhook(attempt + 1), attempt * 5000);
          });
          crmReq.write(payload);
          crmReq.end();
        };
        sendCrmWebhook(1);
        logger.info('CRM webhook sent', { callId, url: crmUrl });
      } catch (err) {
        logger.warn('CRM webhook error', { callId, error: err.message });
      }
    }

    // Email notification
    if (global.sendEmailNotification && settings.emailNotify) {
      global.sendEmailNotification('call', { direction, callerName, callerNumber, durationS, aiSummary: aiData?.summary, aiIntent: aiData?.intent, aiSentiment: aiData?.sentiment, callId });
    }

    // Zapier/Make webhook
    if (global.fireZapierWebhook) {
      global.fireZapierWebhook('call.completed', { callId, direction, callerName, callerNumber, durationS, aiSummary: aiData?.summary, aiIntent: aiData?.intent, aiSentiment: aiData?.sentiment, aiActionItems: aiData?.actionItems });
    }

    // Google Sheets sync
    if (global.syncToGoogleSheets) {
      global.syncToGoogleSheets({ callId, direction, callerName, callerNumber, durationS, savedAt: new Date().toISOString(), aiSummary: aiData?.summary, aiIntent: aiData?.intent, aiSentiment: aiData?.sentiment, estimatedCostUsd: 0 });
    }

    // Auto follow-up
    if (global.scheduleAutoFollowUp && aiData) {
      global.scheduleAutoFollowUp({ callerNumber, callerName, aiActionItems: aiData.actionItems });
    }

    // Dequeue next call if queue has waiters
    if (global.dequeueCall && global.callQueue && global.callQueue.length > 0) {
      const next = global.dequeueCall();
      if (next) {
        logger.info('Dequeuing next call', { caller: next.callerNumber });
        if (global.sendTelegramMessage) global.sendTelegramMessage(`📞 <b>מחזיר שיחה מהתור</b>\n👤 ${next.callerName || next.callerNumber}`);
      }
    }

    logger.info('Call summary sent', { callId, direction, hasAI: !!aiData, transcript: transcript ? transcript.length : 0 });
  }

  /**
   * Update a saved recording file with AI summary data.
   */
  _updateRecordingWithAI(callId, aiData) {
    try {
      const recDir = path.join(this.audioDir, 'recordings');
      const files = fs.readdirSync(recDir).filter(f => f.includes(callId.replace(/[^a-z0-9-]/gi, '_')));
      if (files.length > 0) {
        const filePath = path.join(recDir, files[files.length - 1]);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.aiSummary = aiData.summary;
        data.aiIntent = aiData.intent;
        data.aiActionItems = aiData.actionItems || [];
        data.aiSentiment = aiData.sentiment || null;
        data.aiSentimentScore = aiData.sentimentScore || null;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        logger.info('Recording updated with AI summary', { callId, file: files[files.length - 1] });
      }
    } catch (err) {
      logger.warn('Failed to update recording with AI', { callId, error: err.message });
    }
  }

  async _handleVoicemail(endpoint, dialog, callId, callerName) {
    const vmDir = path.join(this.audioDir, 'voicemails');
    if (!fs.existsSync(vmDir)) fs.mkdirSync(vmDir, { recursive: true });
    logger.info('Voicemail mode', { callId, callerName });

    const voicemailChunks = [];
    let done = false;
    let silenceFrames = 0;
    const SILENCE_FRAMES_NEEDED = 250; // ~5s at 20ms/frame
    const MIN_FRAMES = 25; // ~500ms minimum to bother saving

    let resolveVm;
    const vmPromise = new Promise(r => { resolveVm = r; });

    this.audioForkServer.register(callId, {
      onAudio: (buf) => {
        if (done) return;
        voicemailChunks.push(buf);
        const rms = calcRms(buf);
        if (rms < 200) {
          silenceFrames++;
          if (silenceFrames >= SILENCE_FRAMES_NEEDED && voicemailChunks.length > MIN_FRAMES) {
            done = true;
            resolveVm();
          }
        } else {
          silenceFrames = 0;
        }
      },
      onClose: () => { if (!done) { done = true; resolveVm(); } }
    });

    const wsUrl = `ws://127.0.0.1:${WS_PORT}/${encodeURIComponent(callId)}`;
    await endpoint.forkAudioStart({ wsUrl, mixType: 'mono', sampling: '16k' }).catch(() => {});

    const timeout = setTimeout(() => { done = true; resolveVm(); }, 60000);
    await Promise.race([vmPromise, new Promise(r => dialog.once('destroy', r))]);
    clearTimeout(timeout);

    if (voicemailChunks.length > MIN_FRAMES) {
      try {
        const { WaveFile } = require('wavefile');
        const pcm = Buffer.concat(voicemailChunks);
        const wav = new WaveFile();
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
        wav.fromScratch(1, 16000, '16', samples);
        const ts = Date.now();
        const safeName = callId.replace(/[^a-z0-9-]/gi, '_');
        const wavFile = path.join(vmDir, `${safeName}-${ts}.wav`);
        const metaFile = path.join(vmDir, `${safeName}-${ts}.json`);
        fs.writeFileSync(wavFile, Buffer.from(wav.toBuffer()));
        const durationS = Math.round(voicemailChunks.length * 20 / 1000);
        fs.writeFileSync(metaFile, JSON.stringify({
          callId, callerName, savedAt: new Date().toISOString(), durationS,
          wavFile: path.basename(wavFile),
        }, null, 2));
        logger.info('Voicemail saved', { callId, wavFile, durationS });
        // Voicemail-to-Text: transcribe using Gemini
        const vmTranscript = await this._transcribeVoicemail(wavFile, metaFile).catch(() => null);
        const who = callerName || 'לא ידוע';
        if (global.sendTelegramMessage && (global.botSettings || {}).telegramCallSummary) {
          let vmMsg = `📩 <b>הודעה קולית חדשה</b>\n👤 מ: ${who}\n⏱ ~${durationS}ש\n🆔 ${callId.slice(0,12)}`;
          if (vmTranscript) vmMsg += `\n\n💬 <b>תמלול:</b>\n${vmTranscript.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`;
          global.sendTelegramMessage(vmMsg);
        }
        if (global.sendWhatsappMessage && (global.botSettings || {}).whatsappCallSummary) {
          let wmMsg = `📩 הודעה קולית חדשה\n👤 מ: ${who}\n⏱ ~${durationS}ש`;
          if (vmTranscript) wmMsg += `\n💬 ${vmTranscript}`;
          global.sendWhatsappMessage(wmMsg);
        }
        // Email notification
        if (global.sendEmailNotification) {
          global.sendEmailNotification('voicemail', { callerName: who, durationS, callId, transcript: vmTranscript });
        }
      } catch (err) {
        logger.error('Failed to save voicemail', { callId, error: err.message });
      }
    }

    this.audioForkServer.unregister(callId);
  }

  async _transcribeVoicemail(wavFilePath, metaFilePath) {
    const apiKey = (global.botSettings || {}).geminiApiKey;
    if (!apiKey) return null;
    try {
      const audioData = fs.readFileSync(wavFilePath);
      const base64Audio = audioData.toString('base64');
      const https = require('https');
      const body = JSON.stringify({
        contents: [{ parts: [
          { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
          { text: 'תמלל את ההודעה הקולית הזו לעברית. אם השפה אחרת, תמלל בשפה המקורית. תן רק את הטקסט, בלי הסברים.' }
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 30000,
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || null);
            } catch (_) { resolve(null); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });
      if (result && metaFilePath) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFilePath, 'utf8'));
          meta.transcript = result;
          fs.writeFileSync(metaFilePath, JSON.stringify(meta, null, 2));
        } catch (_) {}
      }
      logger.info('Voicemail transcribed', { file: path.basename(wavFilePath), length: result?.length });
      return result;
    } catch (err) {
      logger.warn('Voicemail transcription failed', { error: err.message });
      return null;
    }
  }

  async _savePcmAsWav(pcmBuffer, callId) {
    const { WaveFile } = require('wavefile');
    const wav = new WaveFile();
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
    wav.fromScratch(1, 24000, '16', samples);
    const wavBuf = Buffer.from(wav.toBuffer());
    const filename = `gemini-${Date.now()}.wav`;
    const filePath = path.join(this.audioDir, filename);
    fs.writeFileSync(filePath, wavBuf);
    // Return HTTP URL so FreeSWITCH can fetch it
    const url = `http://127.0.0.1:${this.audioPort}/audio/${filename}`;
    // Schedule cleanup after 60s
    setTimeout(() => fs.unlink(filePath, () => {}), 60000);
    return url;
  }

  // ── IVR handler ─────────────────────────────────────────────────────────

  async _playTts(endpoint, callId, text, lang) {
    try {
      const result = await this.sttTts.synthesize(text, callId, { languageCode: lang || 'he-IL' });
      if (result && result.success) {
        const tmpFile = path.join(os.tmpdir(), `ivr-${callId}-${Date.now()}.mp3`);
        fs.writeFileSync(tmpFile, result.audio);
        await endpoint.play(tmpFile);
        fs.unlink(tmpFile, () => {});
      }
    } catch (err) {
      logger.error('IVR TTS error', { callId, error: err.message });
    }
  }

  async _handleIvrCall(endpoint, dialog, callId, callerName, overrideSettings = null) {
    const ivr = global.ivrConfig || {};
    const nodes = ivr.nodes || [];
    const lang = (overrideSettings || global.botSettings || {}).language || 'he-IL';
    const greeting = ivr.greeting || 'ברוכים הבאים.';
    const timeoutMs = ((ivr.timeout || 5) * 1000);

    logger.info('IVR started', { callId, nodes: nodes.length });

    // Play greeting via TTS
    await this._playTts(endpoint, callId, greeting, lang);

    // Enable in-band DTMF detection
    try { await endpoint.execute('start_dtmf'); } catch (_) {}

    // Wait for DTMF digit
    const digit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      endpoint.once('dtmf', (evt) => {
        clearTimeout(timer);
        resolve(evt && (evt.dtmf || evt.digit || ''));
      });
    });

    logger.info('IVR digit received', { callId, digit });

    if (!digit) {
      // Timeout — use configured default action
      const action = ivr.timeoutAction || 'ai';
      if (action === 'ai') return this._handleGeminiLiveCall(endpoint, dialog, callId, callerName, overrideSettings);
      if (action === 'voicemail') return this._handleVoicemail(endpoint, dialog, callId, callerName);
      await this._playTts(endpoint, callId, 'לא קיבלנו תגובה. להתראות.', lang);
      try { dialog.destroy(); } catch (_) {}
      return;
    }

    const node = nodes.find(n => String(n.digit) === String(digit));
    if (!node) {
      await this._playTts(endpoint, callId, 'בחירה לא חוקית. להתראות.', lang);
      try { dialog.destroy(); } catch (_) {}
      return;
    }

    switch (node.action) {
      case 'ai':
        return this._handleGeminiLiveCall(endpoint, dialog, callId, callerName, overrideSettings);
      case 'voicemail':
        return this._handleVoicemail(endpoint, dialog, callId, callerName);
      case 'transfer':
        try { await endpoint.execute('transfer', node.value || ''); } catch (err) {
          logger.error('IVR transfer error', { callId, error: err.message });
        }
        break;
      case 'message':
        await this._playTts(endpoint, callId, node.value || '', lang);
        try { dialog.destroy(); } catch (_) {}
        break;
      default:
        return this._handleGeminiLiveCall(endpoint, dialog, callId, callerName);
    }
  }

  // ── Legacy STT+TTS path ──────────────────────────────────────────────────

  async _handleSttTtsCall(endpoint, dialog, callId) {
    try {
      const result = await this.sttTts.synthesize('שלום, איך אני יכול לעזור?', callId, {
        languageCode: 'he-IL',
        voiceName: 'he-IL-Wavenet-A'
      });
      if (result.success) {
        const tmpFile = path.join(os.tmpdir(), `tts-${callId}.mp3`);
        fs.writeFileSync(tmpFile, result.audio);
        await endpoint.play(tmpFile);
        fs.unlink(tmpFile, () => {});
      }
    } catch (err) {
      logger.error('STT/TTS call error', { callId, error: err.message });
    }
    this.metrics.record(callId, 'endCall', 'completed');
    this.metrics.finalize(callId);
  }
}

module.exports = CallHandler;
