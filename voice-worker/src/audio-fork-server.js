/**
 * AudioForkServer — single shared WebSocket server for FreeSWITCH audio forks.
 *
 * FreeSWITCH connects to ws://host:port/{callId} for each call.
 * This server routes each connection to the right handler by callId.
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const logger = require('./logger');

class AudioForkServer extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.wss = null;
    this.handlers = new Map(); // callId → function(audioBuffer)
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('listening', () => {
      logger.info('Audio fork server listening', { port: this.port });
      this.emit('listening');
    });

    this.wss.on('connection', (ws, req) => {
      // URL path is /{callId}
      const callId = decodeURIComponent((req.url || '/').replace(/^\//, ''));
      logger.info('Audio fork connection', { callId });

      ws.on('message', (data) => {
        const handler = this.handlers.get(callId);
        if (!handler) return;

        if (Buffer.isBuffer(data) && data.length > 0) {
          handler.onAudio(data);
        } else if (typeof data === 'string') {
          try {
            const ev = JSON.parse(data);
            handler.onEvent(ev);
          } catch (_) {}
        }
      });

      ws.on('close', () => {
        logger.info('Audio fork disconnected', { callId });
        const handler = this.handlers.get(callId);
        if (handler) handler.onClose();
      });

      ws.on('error', (err) => {
        logger.warn('Audio fork WS error', { callId, error: err.message });
      });
    });

    this.wss.on('error', (err) => {
      logger.error('Audio fork server error', { error: err.message });
    });
  }

  /**
   * Register a handler for a specific call.
   * @param {string} callId
   * @param {{ onAudio, onEvent, onClose }} handler
   */
  register(callId, handler) {
    this.handlers.set(callId, handler);
  }

  unregister(callId) {
    this.handlers.delete(callId);
  }

  stop() {
    if (this.wss) this.wss.close();
  }
}

module.exports = AudioForkServer;
