/**
 * GeminiLiveManager — manages one GeminiLiveSession per active call.
 *
 * Provides a simple interface for call-handler:
 *   manager.getOrCreate(callId, options) → GeminiLiveSession
 *   manager.get(callId)                 → GeminiLiveSession | null
 *   manager.close(callId)
 *   manager.closeAll()
 */
const GeminiLiveSession = require('./session');
const logger = require('../logger');

class GeminiLiveManager {
  constructor() {
    this.sessions = new Map(); // callId → GeminiLiveSession
  }

  /**
   * Get existing session or create + connect a new one.
   * @param {string} callId
   * @param {object} options — passed to GeminiLiveSession constructor
   * @returns {Promise<GeminiLiveSession>}
   */
  async getOrCreate(callId, options = {}) {
    if (this.sessions.has(callId)) {
      return this.sessions.get(callId);
    }

    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const session = new GeminiLiveSession({ callId, ...options, apiKey });

    session.on('close', () => {
      this.sessions.delete(callId);
      logger.info('GeminiLive session removed', { callId });
    });

    session.on('error', (err) => {
      logger.error('GeminiLive session error', { callId, error: err.message });
    });

    this.sessions.set(callId, session);

    try {
      await session.connect();
      logger.info('GeminiLive session created', { callId });
      return session;
    } catch (err) {
      this.sessions.delete(callId);
      throw err;
    }
  }

  get(callId) {
    return this.sessions.get(callId) || null;
  }

  close(callId) {
    const session = this.sessions.get(callId);
    if (session) {
      session.close();
      this.sessions.delete(callId);
    }
  }

  closeAll() {
    for (const [callId, session] of this.sessions) {
      session.close();
    }
    this.sessions.clear();
  }
}

module.exports = GeminiLiveManager;
