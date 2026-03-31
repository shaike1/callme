const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger');
const GeminiLiveManager = require('./gemini-live/manager');

const CONVERSATION_ENGINE = process.env.CONVERSATION_ENGINE || 'stt-tts';
const WS_PORT = parseInt(process.env.WS_PORT || '3001');
const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS || '300000');

const geminiManager = new GeminiLiveManager();

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

    try {
      const audioOnlySdp = stripVideoFromSdp(req.body);
      const { endpoint, dialog } = await this.mediaServer.connectCaller(req, res, {
        remoteSdp: audioOnlySdp
      });

      logger.info('Call connected', { callId, uuid: endpoint.uuid });

      dialog.on('destroy', () => {
        logger.info('Call ended', { callId });
        geminiManager.close(callId);
        this.audioForkServer.unregister(callId);
        endpoint.destroy().catch(() => {});
        this.metrics.record(callId, 'endCall', 'hangup');
        this.metrics.finalize(callId);
      });

      if (CONVERSATION_ENGINE === 'gemini-live') {
        await this._handleGeminiLiveCall(endpoint, dialog, callId);
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

  async _handleGeminiLiveCall(endpoint, dialog, callId) {
    const settings = global.botSettings || {};
    const systemPrompt = settings.persona || process.env.GEMINI_SYSTEM_PROMPT ||
      'You are a helpful voice assistant named CallMe Bot. The caller speaks Hebrew. Always respond in Hebrew. The audio may have phone quality noise — do your best to understand Hebrew speech.';

    // Inject HA tool instructions into voice system prompt if enabled
    const integrations = global.integrations || {};
    if (integrations.ha?.enabled && integrations.ha?.url) {
      systemPrompt += '\n\nYou can control smart home devices. When the user asks to turn on/off lights, adjust temperature, etc., confirm verbally in Hebrew and append (at the very end of your response): <ha_action>{"domain":"light","service":"turn_on","entity_id":"light.living_room"}</ha_action>. Use the correct domain/service/entity_id for the requested action.';
    }

    const voiceName = settings.voice || 'Kore';
    const session = await geminiManager.getOrCreate(callId, {
      systemPrompt,
      language: process.env.CALL_LANGUAGE || 'he',
      voiceConfig: {
        voice_config: {
          prebuilt_voice_config: { voice_name: voiceName }
        }
      }
    });

    let audioChunks = [];

    session.on('error', (err) => {
      logger.error('GeminiLive session error', { callId, error: err.message });
    });

    session.on('input_transcript', (text) => {
      logger.info('Caller said', { callId, text });
    });

    session.on('output_transcript', (text) => {
      logger.info('Bot said', { callId, text });
      // Execute any Home Assistant actions embedded in the transcript
      const haMatch = text.match(/<ha_action>([\s\S]*?)<\/ha_action>/);
      if (haMatch && global.callHaService) {
        try {
          const action = JSON.parse(haMatch[1]);
          global.callHaService(action.domain, action.service, action.serviceData || { entity_id: action.entity_id })
            .then(r => logger.info('HA action executed', { callId, action, result: r }))
            .catch(e => logger.error('HA action failed', { callId, error: e.message }));
        } catch (e) {
          logger.error('HA action parse error', { callId, error: e.message });
        }
      }
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

    // Send initial greeting
    const greeting = (global.botSettings || {}).greeting || 'שלום! ברך את המשתמש בקצרה בעברית.';
    session.sendText(greeting);

    // Energy-based VAD with manual activity markers.
    // Gemini's automatic VAD is disabled — we tell it exactly when speech starts/ends
    // so it processes the full utterance as one context instead of tiny 20ms fragments.
    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;  // ~400ms silence = end of utterance
    const MIN_SPEECH_FRAMES = 15;      // ~300ms minimum — filters noise but allows short Hebrew phrases through

    const calcRms = (buf) => {
      let sum = 0;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const s = buf.readInt16LE(i);
        sum += s * s;
      }
      return Math.sqrt(sum / (buf.length / 2));
    };

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
