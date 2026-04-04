/**
 * GroqPipelineSession — STT→LLM→TTS pipeline as a drop-in replacement
 * for GeminiLiveSession.
 *
 * Emits the same events as GeminiLiveSession:
 *   'audio'           — Buffer of PCM 16-bit LE audio (24kHz output)
 *   'text'            — string response text
 *   'input_transcript' — user's transcribed speech
 *   'output_transcript' — bot's response text
 *   'turn_complete'   — bot finished speaking
 *   'interrupted'     — (not used in pipeline mode — VAD handles this externally)
 *   'tool_call'       — tool call from LLM (handled internally)
 *   'error'           — Error object
 *   'close'           — session closed
 */
const { EventEmitter } = require('events');
const DeepgramSTT = require('./deepgram-stt');
const GroqLLM = require('./groq-llm');
const TTSProvider = require('./tts-provider');
const logger = require('../logger');

class GroqPipelineSession extends EventEmitter {
  constructor({ callId, deepgramApiKey, groqApiKey, systemPrompt, language, tools, toolHandler, ttsConfig, dependencies = {} }) {
    super();
    this.callId = callId;
    this.language = language || 'he';
    this._closed = false;
    this.ready = false;

    // Accumulated final transcripts for current utterance
    this._utteranceText = '';
    this._utteranceTimer = null;
    this._processing = false;

    // Tool handler for LLM tool calls
    this._toolHandler = toolHandler || (async () => ({ error: 'No handler' }));

    const DeepgramSTTClass = dependencies.DeepgramSTT || DeepgramSTT;
    const GroqLLMClass = dependencies.GroqLLM || GroqLLM;
    const TTSProviderClass = dependencies.TTSProvider || TTSProvider;

    // Initialize components
    this.stt = new DeepgramSTTClass({
      apiKey: deepgramApiKey,
      language: this.language,
      callId,
    });

    this.llm = new GroqLLMClass({
      apiKey: groqApiKey,
      systemPrompt,
      tools: tools || [],
      callId,
    });

    this.tts = new TTSProviderClass({
      googleKeyPath: ttsConfig?.googleKeyPath,
      deepgramApiKey,
      language: this.language === 'he' ? 'he-IL' : (this.language === 'en' ? 'en-US' : this.language),
      voiceName: ttsConfig?.voiceName,
    });
  }

  async connect() {
    try {
      // Set up error/close listeners BEFORE connecting to avoid unhandled events
      this.stt.on('error', (err) => this.emit('error', err));
      this.stt.on('close', () => {
        if (!this._closed) this.emit('close');
      });

      // Connect Deepgram STT
      await this.stt.connect();

      // Listen for transcripts
      this.stt.on('transcript', ({ text, isFinal }) => {
        if (isFinal && text.trim()) {
          this._utteranceText += (this._utteranceText ? ' ' : '') + text.trim();
          // Debounce: wait 800ms after last final transcript before processing
          if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
          this._utteranceTimer = setTimeout(() => this._processUtterance(), 800);
        }
      });

      this.stt.on('utterance_end', () => {
        // Deepgram detected end of utterance — process immediately
        if (this._utteranceText.trim() && !this._processing) {
          if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
          this._processUtterance();
        }
      });

      this.ready = true;
      logger.info('GroqPipeline session ready', { callId: this.callId });
      return this;
    } catch (err) {
      logger.error('GroqPipeline connect failed', { callId: this.callId, error: err.message });
      throw err;
    }
  }

  async _processUtterance() {
    const text = this._utteranceText.trim();
    this._utteranceText = '';
    if (!text || this._processing) return;

    this._processing = true;
    logger.info('Processing utterance', { callId: this.callId, text });
    this.emit('input_transcript', text);

    try {
      // Get LLM response (handles tool calls internally)
      const response = await this.llm.chat(text, this._toolHandler);

      if (!response || this._closed) {
        this._processing = false;
        return;
      }

      logger.info('LLM response', { callId: this.callId, text: response.slice(0, 100) });
      this.emit('text', response);
      this.emit('output_transcript', response);

      // Synthesize speech
      const pcm = await this.tts.synthesize(response);
      if (!this._closed) {
        this.emit('audio', pcm);
        this.emit('turn_complete');
      }
    } catch (err) {
      logger.error('Pipeline processing error', { callId: this.callId, error: err.message });
      this.emit('error', err);
      this.emit('turn_complete');
    }

    this._processing = false;
  }

  /**
   * Send PCM audio to the STT engine.
   * @param {Buffer} pcmBuffer - 16kHz 16-bit LE mono
   */
  sendAudio(pcmBuffer) {
    if (this._closed) return;
    this.stt.sendAudio(pcmBuffer);
  }

  /**
   * Send a text message directly to the LLM (e.g., initial greeting).
   * @param {string} text
   */
  async sendText(text) {
    if (this._closed) return;

    this._processing = true;
    try {
      const response = await this.llm.chat(text, this._toolHandler);
      if (response && !this._closed) {
        this.emit('text', response);
        this.emit('output_transcript', response);
        const pcm = await this.tts.synthesize(response);
        if (!this._closed) {
          this.emit('audio', pcm);
          this.emit('turn_complete');
        }
      }
    } catch (err) {
      logger.error('Pipeline sendText error', { callId: this.callId, error: err.message });
      this.emit('error', err);
      this.emit('turn_complete');
    }
    this._processing = false;
  }

  // Compatibility methods — these are no-ops in pipeline mode since
  // Deepgram handles VAD internally and we manage turns via transcript events.
  sendActivityStart() {}
  sendActivityEnd() {}
  endTurn() {}
  sendSpeech() {}
  sendToolResponse() {} // Tool calls handled internally in GroqLLM

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
    this.stt.close();
    this.emit('close');
  }
}

module.exports = GroqPipelineSession;
