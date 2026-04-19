/**
 * DeepgramSTT — streaming speech-to-text using Deepgram's WebSocket API.
 *
 * Accepts 16kHz 16-bit PCM mono audio chunks and emits transcription events.
 * Uses Deepgram's live transcription with interim results for responsiveness.
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const logger = require('../logger');

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

function normalizeDeepgramLanguage(language) {
  const normalized = String(language || '').toLowerCase();
  if (normalized === 'auto' || normalized === 'multi') return 'multi';
  if (normalized.startsWith('he')) return 'he';
  if (normalized.startsWith('en')) return 'en';
  return language;
}

class DeepgramSTT extends EventEmitter {
  constructor({ apiKey, language = 'he', callId = '' }) {
    super();
    this.apiKey = apiKey;
    this.language = normalizeDeepgramLanguage(language);
    this.callId = callId;
    this.ws = null;
    this.ready = false;
    this._closed = false;
    this._pendingAudio = [];
  }

  async connect() {
    const isMulti = this.language === 'multi';
    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      utterance_end_ms: '1500',
      vad_events: 'true',
      smart_format: 'true',
      punctuate: 'true',
    });
    if (isMulti) {
      params.set('detect_language', 'true');
    } else {
      params.set('language', this.language);
    }

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` }
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Deepgram WS connect timeout')), 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.ready = true;
        logger.info('Deepgram STT connected', { callId: this.callId });
        // Flush buffered audio
        for (const chunk of this._pendingAudio) this.ws.send(chunk);
        this._pendingAudio = [];
        resolve(this);
      });

      this.ws.on('message', (data) => this._handleMessage(data));

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        logger.error('Deepgram STT WS error', { callId: this.callId, error: err.message });
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this._closed = true;
        this.ready = false;
        logger.info('Deepgram STT WS closed', { callId: this.callId, code });
        this.emit('close');
      });
    });
  }

  _handleMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (err) {
      return;
    }

    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const transcript = alt.transcript || '';
      if (!transcript) return;

      // Extract detected language (available when detect_language=true)
      const detectedLang = msg.channel?.detected_language || alt.detected_language || null;

      const isFinal = msg.is_final;
      if (isFinal) {
        logger.info('Deepgram final transcript', { callId: this.callId, text: transcript, detectedLang });
        this.emit('transcript', { text: transcript, isFinal: true, detectedLang });
      } else {
        this.emit('transcript', { text: transcript, isFinal: false, detectedLang });
      }
    } else if (msg.type === 'UtteranceEnd') {
      logger.debug('Deepgram utterance end', { callId: this.callId });
      this.emit('utterance_end');
    }
  }

  /**
   * Send PCM audio chunk to Deepgram.
   * @param {Buffer} pcmBuffer - 16kHz 16-bit LE mono PCM
   */
  sendAudio(pcmBuffer) {
    if (this._closed) return;
    if (!this.ready) {
      this._pendingAudio.push(pcmBuffer);
      return;
    }
    try {
      this.ws.send(pcmBuffer);
    } catch (err) {
      logger.warn('Deepgram STT: failed to send audio', { callId: this.callId, error: err.message });
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      // Send CloseStream message to gracefully close
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      this.ws?.close();
    } catch (_) {}
  }
}

module.exports = DeepgramSTT;
