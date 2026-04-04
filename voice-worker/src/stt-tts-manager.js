const GoogleCloudTTS = require('./tts/google-cloud');
const OpenAIWhisper = require('./stt/openai-whisper');
const logger = require('./logger');

class SttTtsManager {
  constructor() {
    // Initialize TTS providers
    this.ttsProviders = {
      'google-cloud': new GoogleCloudTTS()
    };

    // Initialize STT providers
    this.sttProviders = {};
    const openAiWhisper = new OpenAIWhisper();
    if (openAiWhisper.enabled) {
      this.sttProviders['openai-whisper'] = openAiWhisper;
    }

    this.primaryTts = process.env.PRIMARY_TTS || 'google-cloud';
    this.fallbackTts = process.env.FALLBACK_TTS || null;
    this.primaryStt = process.env.PRIMARY_STT || (this.sttProviders['openai-whisper'] ? 'openai-whisper' : null);
    this.fallbackStt = process.env.FALLBACK_STT || null;

    logger.info('STT/TTS Manager initialized', {
      primaryTts: this.primaryTts,
      fallbackTts: this.fallbackTts,
      primaryStt: this.primaryStt,
      fallbackStt: this.fallbackStt
    });
  }

  /**
   * Transcribe audio with primary + fallback
   */
  async transcribe(audioBuffer, callId, options = {}) {
    logger.debug('STT request', { callId, provider: this.primaryStt });

    if (!this.primaryStt) {
      throw new Error('No STT provider configured');
    }

    // Try primary
    try {
      const provider = this.sttProviders[this.primaryStt];
      if (!provider) {
        throw new Error(`Primary STT provider not found: ${this.primaryStt}`);
      }

      const result = await provider.transcribe(audioBuffer, options);
      logger.info('STT success', { callId, provider: this.primaryStt });
      return result;
    } catch (err) {
      logger.warn('Primary STT failed, trying fallback', {
        callId,
        primary: this.primaryStt,
        error: err.message
      });

      // Try fallback
      if (this.fallbackStt && this.sttProviders[this.fallbackStt]) {
        try {
          const result = await this.sttProviders[this.fallbackStt].transcribe(audioBuffer, options);
          logger.info('Fallback STT success', { callId, provider: this.fallbackStt });
          return result;
        } catch (fallbackErr) {
          logger.error('Fallback STT also failed', {
            callId,
            provider: this.fallbackStt,
            error: fallbackErr.message
          });
        }
      }

      throw err;
    }
  }

  /**
   * Synthesize speech with primary + fallback
   */
  async synthesize(text, callId, options = {}) {
    logger.debug('TTS request', { callId, provider: this.primaryTts, textLength: text.length });

    // Try primary
    try {
      const provider = this.ttsProviders[this.primaryTts];
      if (!provider) {
        throw new Error(`Primary TTS provider not found: ${this.primaryTts}`);
      }

      const result = await provider.synthesize(text, options);
      logger.info('TTS success', { callId, provider: this.primaryTts });
      return result;
    } catch (err) {
      logger.warn('Primary TTS failed, trying fallback', {
        callId,
        primary: this.primaryTts,
        error: err.message
      });

      // Try fallback
      if (this.fallbackTts && this.ttsProviders[this.fallbackTts]) {
        try {
          const result = await this.ttsProviders[this.fallbackTts].synthesize(text, options);
          logger.info('Fallback TTS success', { callId, provider: this.fallbackTts });
          return result;
        } catch (fallbackErr) {
          logger.error('Fallback TTS also failed', {
            callId,
            provider: this.fallbackTts,
            error: fallbackErr.message
          });
        }
      }

      throw err;
    }
  }
}

module.exports = SttTtsManager;
