const OpenAI = require('openai');
const fs = require('fs');
const logger = require('../logger');

class OpenAIWhisper {
  constructor() {
    const apiKey = process.env.OPENAI_WHISPER_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.enabled = false;
      this.client = null;
      logger.info('OpenAI Whisper STT disabled: no API key configured');
      return;
    }

    try {
      this.client = new OpenAI({
        apiKey
      });
      this.enabled = true;
      logger.info('OpenAI Whisper STT initialized');
    } catch (err) {
      logger.error('Failed to initialize OpenAI Whisper', { error: err.message });
      this.enabled = false;
    }
  }

  async transcribe(audioBuffer, options = {}) {
    if (!this.enabled) {
      throw new Error('OpenAI Whisper not enabled');
    }

    const {
      language = 'he',
      model = 'whisper-1',
      prompt = ''
    } = options;

    // Create temp file for OpenAI API
    const tempFile = `/tmp/whisper-${Date.now()}.mp3`;
    fs.writeFileSync(tempFile, audioBuffer);

    try {
      const transcription = await this.client.audio.transcriptions.create({
        file: fs.createReadStream(tempFile),
        model,
        language,
        prompt: prompt || undefined
      });

      logger.debug('Whisper success', {
        textLength: transcription.text.length,
        language
      });

      return {
        success: true,
        text: transcription.text,
        language,
        confidence: 0.95
      };
    } catch (err) {
      logger.error('OpenAI Whisper error', {
        error: err.message,
        audioSize: audioBuffer.length
      });
      throw err;
    } finally {
      // Cleanup temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        logger.warn('Failed to cleanup temp file', { file: tempFile });
      }
    }
  }
}

module.exports = OpenAIWhisper;
