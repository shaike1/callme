'use strict';
/**
 * Audio Injector — Phase 3
 * Strategies for playing TTS audio back into a 3CX call:
 *
 * Strategy A: HTTP Audio URL
 *   - Serve TTS file via local HTTP
 *   - Use 3CX MakeCall with audioUrl (auto-answer bot)
 *
 * Strategy B: SIP REFER / Transfer
 *   - Transfer call to IVR/prompt extension temporarily
 *
 * Strategy C: WebSocket Playback (future)
 *   - Inject PCM directly into RTP stream
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class AudioInjector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 3002;
    this.host = options.host || '0.0.0.0';
    this.publicUrl = options.publicUrl || process.env.CALLME_PUBLIC_URL || `http://localhost:${options.port || 3002}`;
    this.audioDir = options.audioDir || '/tmp/callme-tts';
    this._server = null;
    this._files = new Map(); // token → filePath
  }

  /**
   * Start HTTP server for serving audio files to 3CX
   */
  start() {
    this._server = http.createServer((req, res) => {
      const token = req.url.replace('/', '').split('?')[0];
      const filePath = this._files.get(token);

      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404); res.end('Not Found');
        return;
      }

      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
      };

      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'audio/mpeg',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
      });

      fs.createReadStream(filePath).pipe(res);
      console.log(`[AudioInjector] Served: ${token} → ${filePath}`);
    });

    this._server.listen(this.port, this.host, () => {
      console.log(`[AudioInjector] HTTP audio server on ${this.host}:${this.port}`);
    });
  }

  /**
   * Register an audio file and get a public URL
   * @param {string} filePath - Local path to audio file
   * @param {number} ttlMs - Auto-remove after ms (default: 5 min)
   * @returns {string} Public URL
   */
  registerFile(filePath, ttlMs = 5 * 60 * 1000) {
    const { randomBytes } = require('crypto');
    const token = randomBytes(8).toString('hex');
    this._files.set(token, filePath);

    // Auto-cleanup
    setTimeout(() => {
      this._files.delete(token);
    }, ttlMs);

    const url = `${this.publicUrl}/${token}`;
    console.log(`[AudioInjector] Registered: ${url}`);
    return url;
  }

  /**
   * Inject TTS audio into a call via 3CX MakeCall
   *
   * 3CX Strategy A:
   * - Make an outbound call from bot extension to a "listener" extension
   * - Use audioUrl so 3CX auto-plays the file
   * - Transfer the original caller to conference with bot
   *
   * Simpler approach: Serve audio URL, 3CX will play it on answer
   */
  async injectToCall(callId, audioFilePath, threecxClient) {
    try {
      const audioUrl = this.registerFile(audioFilePath);
      console.log(`[AudioInjector] Injecting to call ${callId}: ${audioUrl}`);

      // Strategy A: Make a call to the extension with audio URL
      // 3CX plays the audioUrl when the call is answered
      // TODO: Get the real extension from active call participants
      const result = await threecxClient.makeCall(
        threecxClient.extension, // call ourselves (bot extension)
        audioUrl                 // play this when answered
      );

      this.emit('injected', { callId, audioUrl, result });
      return { success: true, audioUrl, result };
    } catch (e) {
      console.error(`[AudioInjector] Inject error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Simpler approach: Just return the URL for manual use
   * Caller decides how to use it
   */
  prepareAudioUrl(filePath) {
    return this.registerFile(filePath);
  }

  stop() {
    if (this._server) {
      this._server.close();
      console.log('[AudioInjector] Stopped');
    }
  }
}

module.exports = { AudioInjector };
