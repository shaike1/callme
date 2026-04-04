/**
 * TTS Provider — Google Cloud TTS with Hebrew support.
 *
 * Outputs 24kHz 16-bit PCM mono to match the existing playback pipeline.
 * Falls back to Deepgram Aura if no Google credentials available.
 */
const https = require('https');
const textToSpeech = require('@google-cloud/text-to-speech');
const logger = require('../logger');
const { resolveGoogleTtsKeyPath } = require('./tts-config');

function defaultDeepgramVoice(language) {
  const normalized = String(language || '').toLowerCase();
  if (normalized.startsWith('en')) return 'aura-2-asteria-en';
  if (normalized.startsWith('es')) return 'aura-2-celeste-es';
  return 'aura-2-asteria-en';
}

class TTSProvider {
  constructor({ googleKeyPath, deepgramApiKey, language = 'he-IL', voiceName } = {}) {
    this.language = language;
    this.deepgramApiKey = deepgramApiKey;

    // Try Google Cloud TTS first
    this.client = null;
    this._useGoogle = false;
    const resolvedGoogleKeyPath = resolveGoogleTtsKeyPath(googleKeyPath);
    if (resolvedGoogleKeyPath) {
      try {
        this.client = new textToSpeech.TextToSpeechClient({
          keyFile: resolvedGoogleKeyPath,
        });
        this._useGoogle = true;
        // Pick Hebrew voice
        if (language.startsWith('he')) {
          this.googleVoice = voiceName || 'he-IL-Wavenet-A';
          this.googleLang = 'he-IL';
        } else {
          this.googleVoice = voiceName || 'en-US-Wavenet-C';
          this.googleLang = language;
        }
        logger.info('TTS Provider initialized (Google Cloud)', {
          language: this.googleLang,
          voice: this.googleVoice,
          keyPath: resolvedGoogleKeyPath,
        });
      } catch (err) {
        logger.warn('Google TTS init failed, falling back to Deepgram Aura', { error: err.message });
      }
    } else if (googleKeyPath) {
      logger.warn('Google TTS key file not found, falling back to Deepgram Aura', { googleKeyPath });
    }

    // Deepgram Aura fallback
    if (!this._useGoogle) {
      if (String(language || '').toLowerCase().startsWith('he')) {
        this.enabled = false;
        logger.error('TTS Provider: Hebrew TTS requires Google Cloud credentials', {
          language,
          requestedVoice: voiceName || null,
        });
        return;
      }

      this.deepgramVoice = voiceName || defaultDeepgramVoice(language);
      this.enabled = !!this.deepgramApiKey;
      if (this.enabled) {
        logger.info('TTS Provider initialized (Deepgram Aura fallback)', { language, voice: this.deepgramVoice });
      } else {
        logger.error('TTS Provider: no Google credentials and no Deepgram API key');
      }
    } else {
      this.enabled = true;
    }
  }

  /**
   * Synthesize text to 24kHz 16-bit PCM mono buffer.
   * @param {string} text
   * @returns {Promise<Buffer>} PCM audio buffer
   */
  async synthesize(text) {
    if (!this.enabled) throw new Error('TTS provider not enabled');
    if (this._useGoogle) return this._synthesizeGoogle(text);
    return this._synthesizeDeepgram(text);
  }

  async _synthesizeGoogle(text) {
    logger.info('Google TTS: starting synthesis', { textLength: text.length });
    const [response] = await this.client.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode: this.googleLang,
        name: this.googleVoice,
      },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: 24000,
      },
    });
    const audioContent = response.audioContent || Buffer.alloc(0);
    const pcm = typeof audioContent === 'string'
      ? Buffer.from(audioContent, 'base64')
      : Buffer.from(audioContent);
    const audioData = pcm.length > 44 && pcm.toString('ascii', 0, 4) === 'RIFF'
      ? pcm.slice(44)
      : pcm;
    logger.info('Google TTS synthesized', { textLength: text.length, pcmBytes: audioData.length });
    return audioData;
  }

  async _synthesizeDeepgram(text) {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://api.deepgram.com/v1/speak?model=${this.deepgramVoice}&encoding=linear16&sample_rate=24000`);

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.deepgramApiKey}`,
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            const errMsg = buf.toString().slice(0, 200);
            logger.error('Deepgram TTS error', { status: res.statusCode, error: errMsg });
            reject(new Error(`Deepgram TTS ${res.statusCode}: ${errMsg}`));
            return;
          }
          logger.debug('TTS synthesized', { textLength: text.length, pcmBytes: buf.length });
          resolve(buf);
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('Deepgram TTS timeout')));
      req.write(JSON.stringify({ text }));
      req.end();
    });
  }
}

module.exports = TTSProvider;
