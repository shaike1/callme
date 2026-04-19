const textToSpeech = require('@google-cloud/text-to-speech');
const logger = require('../logger');

class GoogleCloudTTS {
  constructor() {
    try {
      this.client = new textToSpeech.TextToSpeechClient({
        keyFile: process.env.GOOGLE_CLOUD_TTS_KEY_PATH
      });
      this.enabled = true;
      logger.info('Google Cloud TTS initialized');
    } catch (err) {
      logger.error('Failed to initialize Google Cloud TTS', { error: err.message });
      this.enabled = false;
    }
  }

  async synthesize(text, options = {}) {
    if (!this.enabled) {
      throw new Error('Google Cloud TTS not enabled');
    }

    const {
      languageCode = 'he-IL',
      voiceName = 'he-IL-Wavenet-A',
      speakingRate = 1.0,
      pitch = 0.0
    } = options;

    const request = {
      input: { text },
      voice: {
        languageCode,
        name: voiceName,
        ssmlGender: 'NEUTRAL'
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate,
        pitch
      }
    };

    try {
      const [response] = await this.client.synthesizeSpeech(request);
      
      logger.debug('TTS success', {
        textLength: text.length,
        audioSize: response.audioContent.length
      });

      return {
        success: true,
        audio: response.audioContent,
        format: 'mp3'
      };
    } catch (err) {
      logger.error('Google Cloud TTS error', {
        error: err.message,
        textLength: text.length
      });
      throw err;
    }
  }
}

module.exports = GoogleCloudTTS;
