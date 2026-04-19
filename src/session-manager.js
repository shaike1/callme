const axios = require('axios');
const logger = require('./logger');
const config = require('./config');

class SessionManager {
  constructor() {
    this.activeSessions = new Map();
  }

  /**
   * Create unique session key for this call
   */
  createSessionKey(callId) {
    return `${config.claude.sessionPrefix}${callId}`;
  }

  /**
   * Send text to Claude API with session isolation
   */
  async sendToClaude(callId, text, direction = 'inbound') {
    const sessionKey = this.createSessionKey(callId);
    
    logger.debug('Sending to Claude', { callId, sessionKey, text, direction });

    const payload = {
      sessionKey,
      message: text,
      context: {
        direction,
        callId,
        timestamp: new Date().toISOString()
      }
    };

    let attempts = 0;
    const maxAttempts = config.session.lockRetryCount;

    while (attempts < maxAttempts) {
      try {
        const response = await axios.post(
          `${config.claude.apiUrl}/api/converse`,
          payload,
          {
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.OPENCLAW_TOKEN || ''}`
            }
          }
        );

        logger.info('Claude response received', {
          callId,
          sessionKey,
          status: response.status
        });

        return {
          success: true,
          data: response.data,
          sessionKey
        };

      } catch (err) {
        attempts++;
        
        if (err.response?.status === 423 && attempts < maxAttempts) {
          // Session locked - retry with delay
          const delay = config.session.lockRetryDelayMs;
          logger.warn('Session locked, retrying', {
            callId,
            attempt: attempts,
            maxAttempts,
            delay
          });
          await this.sleep(delay);
          continue;
        }

        logger.error('Claude API error', {
          callId,
          attempt: attempts,
          error: err.message,
          status: err.response?.status
        });

        return {
          success: false,
          error: err.message,
          sessionKey
        };
      }
    }

    return {
      success: false,
      error: 'Max retries exceeded',
      sessionKey
    };
  }

  /**
   * Cleanup session after call ends
   */
  async cleanupSession(callId) {
    const sessionKey = this.createSessionKey(callId);
    
    logger.info('Cleaning up session', { callId, sessionKey });
    
    this.activeSessions.delete(callId);
    
    // Optional: Tell OpenClaw to cleanup
    try {
      await axios.post(
        `${config.claude.apiUrl}/api/session-end`,
        { sessionKey },
        { timeout: 5000 }
      );
    } catch (err) {
      logger.warn('Failed to cleanup session on server', {
        callId,
        sessionKey,
        error: err.message
      });
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SessionManager;
