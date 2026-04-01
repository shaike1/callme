const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger');
const GeminiLiveManager = require('./gemini-live/manager');

const CONVERSATION_ENGINE = process.env.CONVERSATION_ENGINE || 'stt-tts';
const WS_PORT = parseInt(process.env.WS_PORT || '3001');
const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS || '300000');

const geminiManager = new GeminiLiveManager();

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
    if (global.resolveTenantForCall) {
      const resolved = global.resolveTenantForCall(calledRaw, calledRaw);
      if (resolved) {
        tenantSettings = resolved.settings;
        logger.info('Tenant resolved for call', { callId, tenantId: resolved.tenant.id });
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

    try {
      const audioOnlySdp = stripVideoFromSdp(req.body);
      const { endpoint, dialog } = await this.mediaServer.connectCaller(req, res, {
        remoteSdp: audioOnlySdp
      });

      const callStartedAt = Date.now();
      logger.info('Call connected', { callId, uuid: endpoint.uuid });
      if (global.fireWebhook) global.fireWebhook('call.started', { callId, direction: 'inbound', callerName, callerNumber: callerRaw, startedAt: callStartedAt });

      dialog.on('destroy', () => {
        const durationS = Math.round((Date.now() - callStartedAt) / 1000);
        logger.info('Call ended', { callId, durationS });
        geminiManager.close(callId);
        this.audioForkServer.unregister(callId);
        endpoint.destroy().catch(() => {});
        this.metrics.record(callId, 'endCall', 'hangup');
        this.metrics.finalize(callId);
        if (global.fireWebhook) global.fireWebhook('call.ended', { callId, direction: 'inbound', callerName, callerNumber: callerRaw, startedAt: callStartedAt, durationS });
        if (global.sendTelegramMessage && (global.botSettings || {}).telegramCallSummary) {
          const callerInfo = callerName ? callerName : (callerRaw || 'לא ידוע');
          const msg = `📞 <b>שיחה נכנסת הסתיימה</b>\n👤 מתקשר: ${callerInfo}\n⏱ משך: ${durationS}ש\n🆔 ${callId.slice(0,12)}`;
          global.sendTelegramMessage(msg);
        }
        if (global.sendWhatsappMessage && (global.botSettings || {}).whatsappCallSummary) {
          const callerInfo = callerName ? callerName : (callerRaw || 'לא ידוע');
          global.sendWhatsappMessage(`📞 שיחה נכנסת\n👤 ${callerInfo}\n⏱ ${durationS}ש`);
        }
      });

      // Use per-tenant IVR config if tenant was resolved, else fall back to global
      const ivrCfg = tenantSettings ? null : global.ivrConfig; // tenant IVR not loaded here yet — use global for now
      const aiEnabled = effectiveSettings.aiEnabled !== false; // default true
      if (!aiEnabled) {
        logger.info('AI engine disabled — routing to voicemail', { callId });
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

  async makeOutboundCall(target, from) {
    if (!this.mediaServer) throw new Error('Media server not ready');

    const callId = `outbound-${Date.now()}`;
    logger.info('Initiating outbound call', { callId, target, from });

    const { endpoint, dialog } = await this.mediaServer.createEndpoint({});

    const sip = await this.srf.createUAC(target, {
      localSipUri: `sip:${from}@${process.env.SIP_DOMAIN}`,
      headers: { 'From': `sip:${from}@${process.env.SIP_DOMAIN}` }
    });

    dialog.on('destroy', () => {
      logger.info('Outbound call ended', { callId });
      geminiManager.close(callId);
      this.audioForkServer.unregister(callId);
      endpoint.destroy().catch(() => {});
    });

    if (CONVERSATION_ENGINE === 'gemini-live') {
      this._handleGeminiLiveCall(endpoint, sip, callId).catch((err) => {
        logger.error('Outbound Gemini call error', { callId, error: err.message });
      });
    }

    return { endpoint, dialog: sip };
  }

  // ── Gemini Live path ─────────────────────────────────────────────────────

  async _handleGeminiLiveCall(endpoint, dialog, callId, callerName = null, overrideSettings = null) {
    const callStartedAt = Date.now();
    const transcript = [];
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

    // Hard language lock — always appended regardless of persona
    const lang = settings.language || 'he';
    if (lang === 'he') {
      systemPrompt += '\n\n## שפת תגובה\nחובה לענות תמיד בעברית בלבד — גם אם המתקשר דיבר בשפה אחרת. אל תענה בערבית, אנגלית, או כל שפה אחרת. תמיד עברית.';
    } else if (lang === 'en') {
      systemPrompt += '\n\n## Response language\nAlways respond in English only, regardless of what language the caller used.';
    }

    const integrations = global.integrations || {};
    // Tool toggles — default true unless explicitly disabled
    const toolToggles = {
      findContact:    settings.toolFindContact    !== false,
      addContact:     settings.toolAddContact     !== false,
      scheduleCall:   settings.toolScheduleCall   !== false,
      calendar:       settings.toolCalendar       !== false,
      homeAssistant:  settings.toolHomeAssistant  !== false,
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

    // Inject active tools list into system prompt so the bot knows its capabilities
    if (activeToolNames.length > 0) {
      systemPrompt += `\n\n## כלים זמינים\nיש לך גישה לכלים הבאים — השתמש בהם באופן יזום כשרלוונטי:\n${activeToolNames.map(t => `- ${t}`).join('\n')}`;
    }

    const voiceName = settings.voice || 'Kore';
    let session;
    try {
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
    } catch (err) {
      logger.error('Gemini unavailable — voicemail mode', { callId, error: err.message });
      await this._handleVoicemail(endpoint, dialog, callId, callerName);
      return;
    }

    let audioChunks = [];

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
        logger.info('Tool call', { callId, tool: fc.name, args: fc.args });
        let result = {};
        try {
          if (fc.name === 'find_contact') {
            const query = (fc.args.name || '').toLowerCase();
            const found = (global.contacts || []).filter(c => c.name.toLowerCase().includes(query));
            if (found.length === 0) {
              result = { found: false, message: 'No contact found with that name' };
            } else if (found.length === 1) {
              result = { found: true, name: found[0].name, phone: found[0].phone };
            } else {
              result = { found: true, multiple: true, contacts: found.map(c => ({ name: c.name, phone: c.phone })) };
            }
          } else if (fc.name === 'add_scheduled_call') {
            const { target, time, message, repeat } = fc.args;
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
            result = { success: true, scheduledFor: next.toLocaleTimeString('he-IL'), target: resolvedTarget };
          } else if (fc.name === 'get_bot_status') {
            const stats = global.metrics ? global.metrics.getStats() : {};
            result = {
              activeCalls: global.activeCalls ? global.activeCalls.size : 0,
              totalCalls: stats.totalCalls || 0,
              successfulCalls: stats.successfulCalls || 0,
              contacts: (global.contacts || []).length,
              scheduledJobs: (global.scheduledJobs || []).filter(j => j.enabled).length,
            };
          } else if (fc.name === 'add_contact') {
            const { name, phone } = fc.args;
            const contact = { id: `c-${Date.now()}`, name, phone, notes: '', createdAt: Date.now() };
            (global.contacts || []).push(contact);
            if (global.saveContacts) global.saveContacts();
            result = { success: true, message: `Saved ${name} as ${phone}` };
          } else if (fc.name === 'check_calendar') {
            const days = fc.args.days || 1;
            if (global.fetchCalendarEvents) {
              const events = await global.fetchCalendarEvents(days);
              if (events.length === 0) {
                result = { found: false, message: `No events in the next ${days} day(s)` };
              } else {
                result = { found: true, count: events.length, events: events.slice(0, 5).map(e => ({
                  title: e.title,
                  start: e.start?.toLocaleString('he-IL', { weekday: 'long', hour: '2-digit', minute: '2-digit' }),
                  location: e.location || undefined,
                })) };
              }
            } else {
              result = { error: 'Calendar not configured' };
            }
          } else if (fc.name === 'add_calendar_event') {
            const { title, date, time, duration, location } = fc.args;
            // Add to internal scheduler
            const [hh, mm] = time.split(':').map(Number);
            const jobTime = time;
            const job = { id: `cal-${Date.now()}`, name: title, target: '', message: `תזכורת: ${title}`, time: jobTime, repeat: 'once', enabled: true, createdAt: Date.now(), lastRan: null };
            const next = new Date(`${date}T${time}:00`);
            job.nextAt = next.getTime();
            (global.scheduledJobs || []).push(job);
            if (global.saveScheduler) global.saveScheduler();
            // Send Google Calendar link via Telegram
            const startDt = `${date.replace(/-/g,'')}T${time.replace(':','')}00`;
            const endDt = (() => { const e = new Date(next.getTime() + (duration || 60) * 60000); return e.toISOString().replace(/[-:]/g,'').slice(0,15); })();
            const gcUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${startDt}/${endDt}${location ? '&location=' + encodeURIComponent(location) : ''}`;
            if (global.sendTelegramMessage) {
              global.sendTelegramMessage(`📅 <b>אירוע חדש נוסף</b>\n📌 ${title}\n🕐 ${date} ${time}\n<a href="${gcUrl}">הוסף לGoogle Calendar</a>`);
            }
            result = { success: true, message: `Event "${title}" scheduled for ${date} at ${time}. A Google Calendar link was sent to Telegram.` };
          } else if (fc.name === 'control_home_assistant') {
            const { domain, service, entity_id } = fc.args;
            if (global.callHaService) {
              const r = await global.callHaService(domain, service, entity_id ? { entity_id } : {});
              result = { success: true, response: r };
            } else {
              result = { success: false, error: 'Home Assistant not configured' };
            }
          } else {
            result = { error: 'Unknown tool: ' + fc.name };
          }
        } catch (e) {
          logger.error('Tool call error', { callId, tool: fc.name, error: e.message });
          result = { error: e.message };
        }
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

    // Energy-based VAD with manual activity markers.
    // Gemini's automatic VAD is disabled — we tell it exactly when speech starts/ends
    // so it processes the full utterance as one context instead of tiny 20ms fragments.
    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;  // ~400ms silence = end of utterance
    const MIN_SPEECH_FRAMES = 15;      // ~300ms minimum — filters noise but allows short Hebrew phrases through

    let speaking = false;
    let silenceCount = 0;
    let speechCount = 0;
    // After sending activityEnd for real speech, block new activityStart until Gemini
    // fires turn_complete or interrupted — prevents rapid interrupt cascade that stops
    // Gemini from ever completing a response turn.
    let waitingForGemini = false;
    let waitingForGeminiTimer = null;
    const GEMINI_RESPONSE_TIMEOUT_MS = 10000; // safety unlock after 10s if no response

    this.audioForkServer.register(callId, {
      onAudio: (buf) => {
        if (!firstPlayDone || isPlaying) return;
        // Block new speech input while Gemini is generating its response
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
            session.sendAudio(buf); // send trailing silence too
            if (silenceCount >= SILENCE_FRAMES_NEEDED) {
              if (speechCount >= MIN_SPEECH_FRAMES) {
                // Real speech — lock input until Gemini responds
                session.sendActivityEnd();
                waitingForGemini = true;
                if (waitingForGeminiTimer) clearTimeout(waitingForGeminiTimer);
                waitingForGeminiTimer = setTimeout(() => {
                  waitingForGemini = false;
                  logger.warn('Gemini response timeout — unlocking input', { callId });
                }, GEMINI_RESPONSE_TIMEOUT_MS);
                logger.info('Speech end → sent to Gemini', { callId, speechFrames: speechCount });
              } else {
                // Too short — close activity to unblock Gemini, but don't lock
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

  _estimateCostUsd(durationS, engine) {
    // Gemini 2.5 Flash Native Audio: $0.70/hr input + $5.00/hr output = $5.70/hr combined
    // OpenAI Realtime (GPT-4o):       $6.00/hr input + $12.00/hr output = $18.00/hr combined
    const rates = { 'gemini-live': 5.70, 'openai-realtime': 18.00 };
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
        if (global.sendTelegramMessage && (global.botSettings || {}).telegramCallSummary) {
          const who = callerName || 'לא ידוע';
          global.sendTelegramMessage(`📩 <b>הודעה קולית חדשה</b>\n👤 מ: ${who}\n⏱ ~${durationS}ש\n🆔 ${callId.slice(0,12)}`);
        }
        if (global.sendWhatsappMessage && (global.botSettings || {}).whatsappCallSummary) {
          const who = callerName || 'לא ידוע';
          global.sendWhatsappMessage(`📩 הודעה קולית חדשה\n👤 מ: ${who}\n⏱ ~${durationS}ש`);
        }
      } catch (err) {
        logger.error('Failed to save voicemail', { callId, error: err.message });
      }
    }

    this.audioForkServer.unregister(callId);
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
