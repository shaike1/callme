'use strict';
/**
 * WebSocket Audio Server
 * - Accepts PCM audio stream from 3CX/SIP
 * - Buffers audio, sends chunks to Whisper STT
 * - Emits transcript events
 */

const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const whisper = require('./whisper-client');

const CHUNK_DURATION_MS = 3000;   // buffer 3s of audio before sending to STT
const SAMPLE_RATE = 8000;          // 3CX telephony standard
const BYTES_PER_SAMPLE = 2;        // 16-bit PCM
const CHUNK_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * (CHUNK_DURATION_MS / 1000);

class AudioServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 3001;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;
    this._wss = null;
    this._sessions = new Map(); // sessionId → { buffer, callId, ws }
  }

  start() {
    this._wss = new WebSocketServer({ port: this.port });
    console.log(`[AudioServer] WebSocket listening on ws://0.0.0.0:${this.port}`);

    this._wss.on('connection', (ws, req) => {
      const url = new URL(req.url, `ws://localhost`);
      const callId = url.searchParams.get('callId') || `call-${Date.now()}`;
      const sessionId = `sess-${Date.now()}`;

      console.log(`[AudioServer] New connection: callId=${callId} session=${sessionId}`);

      const session = { buffer: [], byteCount: 0, callId, ws, sessionId };
      this._sessions.set(sessionId, session);

      this.emit('call:start', { callId, sessionId });

      ws.on('message', (data) => {
        // data is raw PCM Buffer
        session.buffer.push(data);
        session.byteCount += data.length;

        // When we have enough audio — transcribe
        if (session.byteCount >= CHUNK_BYTES) {
          const chunk = Buffer.concat(session.buffer);
          session.buffer = [];
          session.byteCount = 0;
          this._transcribeChunk(session, chunk);
        }
      });

      ws.on('close', () => {
        console.log(`[AudioServer] Disconnected: callId=${callId}`);
        // Flush remaining buffer
        if (session.buffer.length > 0) {
          const chunk = Buffer.concat(session.buffer);
          if (chunk.length > BYTES_PER_SAMPLE * 100) { // at least 100 samples
            this._transcribeChunk(session, chunk);
          }
        }
        this._sessions.delete(sessionId);
        this.emit('call:end', { callId, sessionId });
      });

      ws.on('error', (err) => {
        console.error(`[AudioServer] Error callId=${callId}: ${err.message}`);
      });
    });
  }

  async _transcribeChunk(session, chunk) {
    if (!whisper.isAvailable()) {
      console.warn('[AudioServer] Whisper not available — skipping transcription');
      return;
    }
    try {
      const text = await whisper.transcribe(chunk, {
        format: 'pcm',
        sampleRate: this.sampleRate,
        language: process.env.WHISPER_DEFAULT_LANG || 'he',
      });
      if (text && text.trim()) {
        this.emit('transcript', {
          callId: session.callId,
          sessionId: session.sessionId,
          text: text.trim(),
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[AudioServer] Transcription error: ${err.message}`);
    }
  }

  stop() {
    if (this._wss) {
      this._wss.close();
      console.log('[AudioServer] Stopped');
    }
  }

  getSessions() {
    return Array.from(this._sessions.values()).map(s => ({
      sessionId: s.sessionId,
      callId: s.callId,
    }));
  }
}

module.exports = { AudioServer };
