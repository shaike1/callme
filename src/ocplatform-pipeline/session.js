'use strict';
/**
 * OCPlatformPipelineSession — STT→OpenClaw→TTS pipeline
 *
 * Drop-in replacement for GroqPipelineSession / GeminiLiveSession.
 *
 * Flow:
 *   PCM audio → Deepgram STT → OCPlatform gateway (Claude/LLM) → Google TTS → PCM audio
 *
 * Emits the same events as GroqPipelineSession / GeminiLiveSession:
 *   'audio'             — Buffer of PCM 16-bit LE audio (24kHz output)
 *   'text'              — string response text
 *   'input_transcript'  — user's transcribed speech
 *   'output_transcript' — bot's response text
 *   'turn_complete'     — bot finished speaking
 *   'error'             — Error object
 *   'close'             — session closed
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const DeepgramSTT = require('../groq-pipeline/deepgram-stt');
const TTSProvider = require('../groq-pipeline/tts-provider');
const logger = require('../logger');

class OCPlatformPipelineSession extends EventEmitter {
  constructor({
    callId,
    deepgramApiKey,
    gatewayUrl,
    gatewayToken,
    agentId,
    systemPrompt,
    language,
    ttsConfig,
    dependencies = {},
  }) {
    super();
    this.callId = callId;
    this.language = language || 'he';
    this._closed = false;
    this.ready = false;

    // OpenClaw gateway config
    this.gatewayUrl = gatewayUrl || process.env.OCPLATFORM_GATEWAY_URL || 'http://100.64.0.7:18789';
    this.gatewayToken = gatewayToken || process.env.OCPLATFORM_TOKEN || '';
    this.agentId = agentId || process.env.OCPLATFORM_AGENT_ID || 'main';
    this.systemPrompt = systemPrompt || 'אתה עוזר קולי בשיחת טלפון. עונה בעברית בקצרה.';

    // Conversation history (kept in-process; gateway also tracks per sessionKey)
    this._history = [];
    this._sessionKey = `callme-${callId}`;

    // STT state
    this._utteranceText = '';
    this._utteranceTimer = null;
    this._processing = false;

    // Auto-language detection
    this._autoLang = language === 'auto' || language === 'multi';
    this._detectedLang = null;

    // Dependency injection for testing
    const DeepgramSTTClass = dependencies.DeepgramSTT || DeepgramSTT;
    const TTSProviderClass = dependencies.TTSProvider || TTSProvider;

    this.stt = new DeepgramSTTClass({
      apiKey: deepgramApiKey,
      language: this.language,
      callId,
    });

    this.tts = new TTSProviderClass({
      googleKeyPath: ttsConfig?.googleKeyPath,
      deepgramApiKey,
      language: this.language === 'he' ? 'he-IL' : (this.language === 'en' ? 'en-US' : this.language),
      voiceName: ttsConfig?.voiceName,
    });
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  async connect() {
    try {
      this.stt.on('error', (err) => this.emit('error', err));
      this.stt.on('close', () => { if (!this._closed) this.emit('close'); });

      await this.stt.connect();

      this.stt.on('transcript', ({ text, isFinal, detectedLang }) => {
        if (isFinal && text.trim()) {
          if (this._autoLang && detectedLang) {
            this._detectedLang = detectedLang;
            logger.info('[OCPPipeline] Auto-detected language', { callId: this.callId, lang: detectedLang });
          }
          this._utteranceText += (this._utteranceText ? ' ' : '') + text.trim();
          if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
          this._utteranceTimer = setTimeout(() => this._processUtterance(), 800);
        }
      });

      this.stt.on('utterance_end', () => {
        if (this._utteranceText.trim() && !this._processing) {
          if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
          this._processUtterance();
        }
      });

      this.ready = true;
      logger.info('[OCPPipeline] Session ready', { callId: this.callId, gateway: this.gatewayUrl });
      return this;
    } catch (err) {
      logger.error('[OCPPipeline] Connect failed', { callId: this.callId, error: err.message });
      throw err;
    }
  }

  // ── STT → LLM → TTS ──────────────────────────────────────────────────────

  async _processUtterance() {
    const text = this._utteranceText.trim();
    this._utteranceText = '';
    if (!text || this._processing) return;

    this._processing = true;
    logger.info('[OCPPipeline] Processing utterance', { callId: this.callId, text });
    this.emit('input_transcript', text);

    try {
      const response = await this._askGateway(text);

      if (!response || this._closed) {
        this._processing = false;
        return;
      }

      logger.info('[OCPPipeline] Gateway response', { callId: this.callId, text: response.slice(0, 120) });
      this.emit('text', response);
      this.emit('output_transcript', response);

      const ttsOpts = this._autoLang && this._detectedLang ? { language: this._detectedLang } : {};
      const pcm = await this.tts.synthesize(response, ttsOpts);
      if (!this._closed) {
        this.emit('audio', pcm);
        this.emit('turn_complete');
      }
    } catch (err) {
      logger.error('[OCPPipeline] Processing error', { callId: this.callId, error: err.message });
      this.emit('error', err);
      this.emit('turn_complete');
    }

    this._processing = false;
  }

  // ── OCPlatform Gateway call ───────────────────────────────────────────────

  async _askGateway(userText) {
    // Build messages array with system prompt + history + new user turn
    this._history.push({ role: 'user', content: userText });
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this._history.slice(-12), // Keep last 6 turns (12 messages)
    ];

    const payload = JSON.stringify({
      model: process.env.OCPLATFORM_MODEL || 'auto-route',
      messages,
      max_tokens: 300,
      stream: false,
    });

    const url = new URL('/v1/chat/completions', this.gatewayUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (this.gatewayToken) headers['Authorization'] = `Bearer ${this.gatewayToken}`;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try {
              // OmniRoute may return JSON body followed by '\n: x-omniroute-*' metadata lines
              const jsonPart = raw.split('\n:')[0].trim();
              const parsed = JSON.parse(jsonPart);
              const text = parsed.choices?.[0]?.message?.content
                || parsed.choices?.[0]?.text
                || parsed.text
                || null;
              if (text) {
                this._history.push({ role: 'assistant', content: text });
              }
              resolve(text);
            } catch (e) {
              logger.warn('[OCPPipeline] Failed to parse gateway response', { raw: raw.slice(0, 200) });
              resolve(null);
            }
          });
        }
      );

      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('OCPlatform gateway timeout (15s)'));
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Send raw PCM audio to STT.
   * @param {Buffer} pcmBuffer - 16kHz 16-bit LE mono
   */
  sendAudio(pcmBuffer) {
    if (this._closed) return;
    this.stt.sendAudio(pcmBuffer);
  }

  /**
   * Send text directly to LLM (e.g., initial greeting trigger).
   * @param {string} text
   */
  async sendText(text) {
    if (this._closed) return;
    this._processing = true;
    try {
      const response = await this._askGateway(text);
      if (response && !this._closed) {
        this.emit('text', response);
        this.emit('output_transcript', response);
        const ttsOpts = this._autoLang && this._detectedLang ? { language: this._detectedLang } : {};
        const pcm = await this.tts.synthesize(response, ttsOpts);
        if (!this._closed) {
          this.emit('audio', pcm);
          this.emit('turn_complete');
        }
      }
    } catch (err) {
      logger.error('[OCPPipeline] sendText error', { callId: this.callId, error: err.message });
      this.emit('error', err);
      this.emit('turn_complete');
    }
    this._processing = false;
  }

  // Compatibility stubs
  sendActivityStart() {}
  sendActivityEnd() {}
  endTurn() {}
  sendSpeech() {}
  sendToolResponse() {}

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
    this.stt.close();
    this.emit('close');
  }
}

module.exports = OCPlatformPipelineSession;
