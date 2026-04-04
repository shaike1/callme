/**
 * GroqPipelineManager — manages one GroqPipelineSession per active call.
 *
 * Drop-in replacement for GeminiLiveManager with the same interface:
 *   manager.getOrCreate(callId, options) → GroqPipelineSession
 *   manager.get(callId)                 → GroqPipelineSession | null
 *   manager.close(callId)
 *   manager.closeAll()
 */
const GroqPipelineSession = require('./session');
const logger = require('../logger');

class GroqPipelineManager {
  constructor() {
    this.sessions = new Map();
  }

  async getOrCreate(callId, options = {}) {
    if (this.sessions.has(callId)) {
      return this.sessions.get(callId);
    }

    if (!options.deepgramApiKey) throw new Error('Deepgram API key not set — configure it in dashboard settings');
    if (!options.groqApiKey) throw new Error('Groq API key not set — configure it in dashboard settings');

    const session = new GroqPipelineSession({
      callId,
      deepgramApiKey: options.deepgramApiKey,
      groqApiKey: options.groqApiKey,
      systemPrompt: options.systemPrompt,
      language: options.language,
      tools: options.tools,
      toolHandler: options.toolHandler,
      ttsConfig: options.ttsConfig,
    });

    session.on('close', () => {
      this.sessions.delete(callId);
      logger.info('GroqPipeline session removed', { callId });
    });

    session.on('error', (err) => {
      logger.error('GroqPipeline session error', { callId, error: err.message });
    });

    this.sessions.set(callId, session);

    try {
      await session.connect();
      logger.info('GroqPipeline session created', { callId });
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

module.exports = GroqPipelineManager;
