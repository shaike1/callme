/**
 * GeminiLiveSession — bidirectional realtime audio session with Gemini Live API.
 *
 * One session per call. Opens a WebSocket, streams PCM audio in, receives PCM
 * audio chunks back. Emits events:
 *   'audio'   — Buffer of PCM 16-bit LE audio (24kHz output)
 *   'text'    — string transcript/response text
 *   'turn_complete' — Gemini finished speaking
 *   'interrupted'   — Gemini was interrupted (barge-in)
 *   'error'   — Error object
 *   'close'   — session closed
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const logger = require('../logger');

const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'models/gemini-2.5-flash-native-audio-latest';

class GeminiLiveSession extends EventEmitter {
  constructor({ callId, apiKey, model, systemPrompt, language, voiceConfig, tools }) {
    super();
    this.callId = callId;
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.systemPrompt = systemPrompt || null;
    this.language = language || 'he';
    this.voiceConfig = voiceConfig || null;
    this.tools = tools || null;

    this.ws = null;
    this.ready = false;
    this._pendingAudio = [];
    this._closed = false;
  }

  async connect() {
    const url = `${GEMINI_WS_BASE}?key=${this.apiKey}`;
    this.ws = new WebSocket(url);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Gemini Live WS connect timeout')), 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this._sendSetup();
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data, resolve);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        logger.error('GeminiLive WS error', { callId: this.callId, error: err.message });
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this._closed = true;
        this.ready = false;
        logger.info('GeminiLive WS closed', { callId: this.callId, code, reason: reason?.toString() });
        this.emit('close', { code, reason: reason?.toString() });
      });
    });
  }

  _sendSetup() {
    const setup = {
      setup: {
        model: this.model,
        generation_config: {
          response_modalities: ['AUDIO'],
          speech_config: this.voiceConfig || {
            voice_config: {
              prebuilt_voice_config: { voice_name: 'Aoede' }
            }
          }
        },
        input_audio_transcription: {},
        realtime_input_config: {
          automatic_activity_detection: { disabled: true }
        }
      }
    };

    if (this.systemPrompt) {
      setup.setup.system_instruction = {
        parts: [{ text: this.systemPrompt }]
      };
    }

    if (this.tools && this.tools.length > 0) {
      setup.setup.tools = [{ functionDeclarations: this.tools }];
    }

    this.ws.send(JSON.stringify(setup));
    logger.debug('GeminiLive setup sent', { callId: this.callId, model: this.model });
  }

  _handleMessage(rawData, setupResolve) {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (err) {
      logger.warn('GeminiLive: failed to parse message', { callId: this.callId });
      return;
    }

    // Setup confirmation
    if (msg.setupComplete !== undefined) {
      this.ready = true;
      logger.info('GeminiLive session ready', { callId: this.callId });
      if (setupResolve) setupResolve(this);
      // Flush any audio buffered before ready
      for (const chunk of this._pendingAudio) this._sendAudioChunk(chunk);
      this._pendingAudio = [];
      return;
    }

    // Tool call from Gemini
    if (msg.toolCall) {
      this.emit('tool_call', msg.toolCall.functionCalls);
      return;
    }

    // Server content (audio/text response)
    const content = msg.serverContent;
    if (!content) return;

    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData.data) {
          const audioBuf = Buffer.from(part.inlineData.data, 'base64');
          this.emit('audio', audioBuf);
        }
        if (part.text) {
          this.emit('text', part.text);
        }
      }
    }

    if (content.inputTranscription?.text) {
      this.emit('input_transcript', content.inputTranscription.text);
    }

    if (content.outputTranscription?.text) {
      this.emit('output_transcript', content.outputTranscription.text);
    }

    if (content.turnComplete) {
      this.emit('turn_complete');
    }

    if (content.interrupted) {
      this.emit('interrupted');
    }
  }

  /**
   * Send a PCM 16-bit LE audio chunk (16kHz input expected by Gemini).
   * @param {Buffer} pcmBuffer
   */
  sendAudio(pcmBuffer) {
    if (this._closed) return;
    if (!this.ready) {
      this._pendingAudio.push(pcmBuffer);
      return;
    }
    this._sendAudioChunk(pcmBuffer);
  }

  _sendAudioChunk(pcmBuffer) {
    const msg = {
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data: pcmBuffer.toString('base64')
        }]
      }
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn('GeminiLive: failed to send audio chunk', { callId: this.callId, error: err.message });
    }
  }

  /**
   * Signal start of user speech activity (for manual VAD mode).
   */
  sendActivityStart() {
    if (this._closed || !this.ready) return;
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    } catch (err) {
      logger.warn('GeminiLive: failed to send activityStart', { callId: this.callId, error: err.message });
    }
  }

  /**
   * Signal end of user speech activity (for manual VAD mode).
   */
  sendActivityEnd() {
    if (this._closed || !this.ready) return;
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    } catch (err) {
      logger.warn('GeminiLive: failed to send activityEnd', { callId: this.callId, error: err.message });
    }
  }

  /**
   * Signal end-of-turn (user stopped speaking).
   */
  endTurn() {
    if (this._closed || !this.ready) return;
    try {
      this.ws.send(JSON.stringify({ clientContent: { turnComplete: true } }));
      logger.debug('GeminiLive: turn complete sent', { callId: this.callId });
    } catch (err) {
      logger.warn('GeminiLive: failed to send turnComplete', { callId: this.callId, error: err.message });
    }
  }

  /**
   * Send a text message (for injecting context mid-call).
   * @param {string} text
   */
  sendText(text) {
    if (this._closed || !this.ready) return;
    const msg = {
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true
      }
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn('GeminiLive: failed to send text', { callId: this.callId, error: err.message });
    }
  }

  /**
   * Send a collected speech utterance as a clientContent turn (explicit turn-based mode).
   * Use this when streaming VAD isn't triggering Gemini's automatic response.
   * @param {Buffer} pcmBuffer - 16kHz 16-bit LE mono PCM
   */
  sendSpeech(pcmBuffer) {
    if (this._closed || !this.ready) return;
    const msg = {
      clientContent: {
        turns: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: pcmBuffer.toString('base64') } }] }],
        turnComplete: true
      }
    };
    try {
      this.ws.send(JSON.stringify(msg));
      logger.debug('GeminiLive: sent speech utterance', { callId: this.callId, bytes: pcmBuffer.length });
    } catch (err) {
      logger.warn('GeminiLive: failed to send speech', { callId: this.callId, error: err.message });
    }
  }

  /**
   * Send tool call responses back to Gemini.
   * @param {Array<{id, name, response}>} responses
   */
  sendToolResponse(responses) {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({
      tool_response: {
        function_responses: responses.map(r => ({
          id: r.id,
          name: r.name,
          response: r.response,
        }))
      }
    }));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this.ws?.close();
    } catch (_) {}
  }
}

module.exports = GeminiLiveSession;
