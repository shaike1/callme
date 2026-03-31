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
      'You are a helpful voice assistant named Luky. The caller speaks Hebrew. Always respond in Hebrew. The audio may have phone quality noise — do your best to understand Hebrew speech.';

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

    // Accumulate all audio until turn_complete, then play as one file — avoids choppy gaps
    const flushAudio = () => {
      if (!audioChunks.length) return;
      const pcm = Buffer.concat(audioChunks);
      audioChunks = [];
      enqueueAudio(pcm);
    };

    session.on('audio', (chunk) => {
      audioChunks.push(chunk);
    });

    session.on('turn_complete', () => {
      flushAudio();
    });

    session.on('interrupted', () => {
      audioChunks = [];
      playQueue.length = 0;
      isPlaying = false;
      logger.info('Barge-in detected', { callId });
    });

    // Send initial greeting
    const greeting = (global.botSettings || {}).greeting || 'שלום! ברך את המשתמש בקצרה בעברית.';
    session.sendText(greeting);

    // Energy-based VAD with manual activity markers.
    // Gemini's automatic VAD is disabled — we tell it exactly when speech starts/ends
    // so it processes the full utterance as one context instead of tiny 20ms fragments.
    const SPEECH_RMS_THRESHOLD = 400;
    const SILENCE_FRAMES_NEEDED = 20;  // ~400ms silence = end of utterance
    const MIN_SPEECH_FRAMES = 25;      // ~500ms minimum — prevents short noise from being misidentified as non-Hebrew

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
    // After sending activityEnd, suppress new input for 1.5s so Gemini can process
    // without being interrupted by the tail of the utterance or mic echo
    let postUtteranceSuppressUntil = 0;
    const POST_UTTERANCE_SUPPRESS_MS = 1500;

    this.audioForkServer.register(callId, {
      onAudio: (buf) => {
        if (!firstPlayDone || isPlaying || Date.now() < postPlaySuppressUntil) return;
        if (Date.now() < postUtteranceSuppressUntil) return;

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
                session.sendActivityEnd();
                postUtteranceSuppressUntil = Date.now() + POST_UTTERANCE_SUPPRESS_MS;
                logger.info('Speech end → sent to Gemini', { callId, speechFrames: speechCount });
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
