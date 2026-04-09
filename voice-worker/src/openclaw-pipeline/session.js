/**
 * OpenClawPipelineSession — STT→OpenClaw→TTS pipeline.
 *
 * Drop-in replacement for GeminiLiveSession / GroqPipelineSession.
 * Uses Deepgram for STT, OpenClaw gateway for LLM, Google TTS for speech.
 *
 * Emits the same events:
 *   'audio'            — Buffer of PCM 16-bit LE audio (24kHz)
 *   'input_transcript' — user's transcribed speech
 *   'output_transcript' — bot's response text
 *   'turn_complete'    — bot finished speaking
 *   'error'            — Error object
 *   'close'            — session closed
 */
const { EventEmitter } = require('events');
const DeepgramSTT = require('../groq-pipeline/deepgram-stt');
const TTSProvider = require('../groq-pipeline/tts-provider');
const OpenClawLLM = require('./llm');
const logger = require('../logger');

class OpenClawPipelineSession extends EventEmitter {
  constructor({ callId, deepgramApiKey, gatewayUrl, gatewayToken, agentId, systemPrompt, language, ttsConfig }) {
    super();
    this.callId = callId;
    this.language = language || 'he';
    this._closed = false;
    this.ready = false;
    this._utteranceText = '';
    this._utteranceTimer = null;
    this._processing = false;
    this._autoLang = language === 'auto' || language === 'multi';
    this._detectedLang = null;

    this.stt = new DeepgramSTT({
      apiKey: deepgramApiKey,
      language: this.language,
      callId,
    });

    this.llm = new OpenClawLLM({
      gatewayUrl: gatewayUrl || 'http://100.64.0.7:18789',
      token: gatewayToken,
      agentId: agentId || 'main',
      systemPrompt,
      callId,
    });

    this.tts = new TTSProvider({
      googleKeyPath: ttsConfig?.googleKeyPath,
      deepgramApiKey,
      language: this.language === 'he' ? 'he-IL' : (this.language === 'en' ? 'en-US' : this.language),
      voiceName: ttsConfig?.voiceName,
    });
  }

  async connect() {
    try {
      this.stt.on('error', (err) => this.emit('error', err));
      this.stt.on('close', () => { if (!this._closed) this.emit('close'); });

      await this.stt.connect();

      this.stt.on('transcript', ({ text, isFinal, detectedLang }) => {
        if (isFinal && text.trim()) {
          if (this._autoLang && detectedLang) {
            this._detectedLang = detectedLang;
            logger.info('Auto-detected language', { callId: this.callId, lang: detectedLang });
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
      logger.info('OpenClawPipeline session ready', { callId: this.callId });
      return this;
    } catch (err) {
      logger.error('OpenClawPipeline connect failed', { callId: this.callId, error: err.message });
      throw err;
    }
  }

  async _processUtterance() {
    const text = this._utteranceText.trim();
    this._utteranceText = '';
    if (!text || this._processing) return;

    this._processing = true;
    logger.info('OpenClaw processing utterance', { callId: this.callId, text });
    this.emit('input_transcript', text);

    try {
      const response = await this.llm.chat(text);

      if (!response || this._closed) {
        this._processing = false;
        return;
      }

      logger.info('OpenClaw response', { callId: this.callId, text: response.slice(0, 100) });
      this.emit('output_transcript', response);

      const ttsOpts = this._autoLang && this._detectedLang ? { language: this._detectedLang } : {};
      const pcm = await this.tts.synthesize(response, ttsOpts);
      if (!this._closed) {
        this.emit('audio', pcm);
        this.emit('turn_complete');
      }
    } catch (err) {
      logger.error('OpenClawPipeline error', { callId: this.callId, error: err.message });
      this.emit('error', err);
      this.emit('turn_complete');
    }

    this._processing = false;
  }

  sendAudio(pcmBuffer) {
    if (this._closed) return;
    this.stt.sendAudio(pcmBuffer);
  }

  async sendText(text) {
    if (this._closed) return;
    this._processing = true;
    try {
      const response = await this.llm.chat(text);
      if (response && !this._closed) {
        this.emit('output_transcript', response);
        const ttsOpts = this._autoLang && this._detectedLang ? { language: this._detectedLang } : {};
        const pcm = await this.tts.synthesize(response, ttsOpts);
        if (!this._closed) {
          this.emit('audio', pcm);
          this.emit('turn_complete');
        }
      }
    } catch (err) {
      logger.error('OpenClawPipeline sendText error', { callId: this.callId, error: err.message });
      this.emit('error', err);
      this.emit('turn_complete');
    }
    this._processing = false;
  }

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

module.exports = OpenClawPipelineSession;
