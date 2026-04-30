'use strict';
/**
 * Brain Mode — OCPlatform Gateway Integration
 * Instead of calling Claude SDK directly:
 *   transcript → OCPlatform gateway → AI response
 *
 * Shared brain with Teamy — same gateway, same session management
 * Gateway: http://100.64.0.12:18789
 */

const http = require('http');
const https = require('https');

class BrainMode {
  constructor(options = {}) {
    this.gatewayUrl = options.gatewayUrl
      || process.env.OCPLATFORM_GATEWAY_URL
      || process.env.OPENAI_BASE_URL
      || 'http://100.64.0.7:20129';
    this.token = options.token || process.env.OCPLATFORM_TOKEN || '';
    this.defaultModel = options.model || process.env.OCPLATFORM_MODEL || 'auto-route';

    // Per-call session tracking
    this._sessions = new Map(); // callId → { sessionKey, history }
  }

  /**
   * Send a message to OCPlatform and get AI response
   * @param {string} callId - Unique call identifier
   * @param {string} userText - Transcribed user speech
   * @param {object} persona - Bot persona config
   * @returns {Promise<string>} AI text response
   */
  async think(callId, userText, persona = {}) {
    const session = this._getOrCreateSession(callId, persona);

    // Add to history
    session.history.push({ role: 'user', content: userText, ts: Date.now() });

    try {
      const response = await this._sendToGateway(session, userText, persona);
      if (response) {
        session.history.push({ role: 'assistant', content: response, ts: Date.now() });
      }
      return response;
    } catch (e) {
      console.error(`[BrainMode] Gateway error for callId=${callId}: ${e.message}`);
      // Fallback: simple echo response
      return null;
    }
  }

  _getOrCreateSession(callId, persona) {
    if (!this._sessions.has(callId)) {
      this._sessions.set(callId, {
        callId,
        sessionKey: `callme-${callId}`,
        persona,
        history: [],
        startedAt: new Date().toISOString(),
      });
    }
    return this._sessions.get(callId);
  }

  async _sendToGateway(session, userText, persona) {
    const systemPrompt = persona.systemPrompt
      || `אתה עוזר AI בשם ${persona.name || 'Callme'}. עונה בעברית בצורה קצרה וברורה. אתה בתוך שיחת טלפון.`;

    const payload = JSON.stringify({
      model: this.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...session.history.slice(-10).map(h => ({ role: h.role, content: h.content })),
      ],
      max_tokens: 300,
      stream: false,
    });

    return new Promise((resolve, reject) => {
      const url = new URL('/v1/chat/completions', this.gatewayUrl);
      const lib = url.protocol === 'https:' ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

      const req = lib.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers,
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try {
            // OmniRoute returns JSON + SSE headers: extract JSON part
            const jsonEnd = raw.indexOf('\n:');
            const jsonPart = jsonEnd > 0 ? raw.slice(0, jsonEnd) : raw;
            const data = JSON.parse(jsonPart);
            // Handle OpenAI-style response
            const text = data?.choices?.[0]?.message?.content
              || data?.content?.[0]?.text
              || data?.response
              || data?.text
              || '';
            resolve(text.trim());
          } catch {
            resolve(raw.trim());
          }
        });
      });

      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Gateway timeout'));
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Get full transcript history for a call
   */
  getHistory(callId) {
    return this._sessions.get(callId)?.history || [];
  }

  /**
   * Generate end-of-call summary
   */
  async summarize(callId, persona = {}) {
    const session = this._sessions.get(callId);
    if (!session || session.history.length === 0) return null;

    const transcript = session.history
      .map(h => `${h.role === 'user' ? '👤' : '🤖'} ${h.content}`)
      .join('\n');

    const summaryPrompt = `סכם את השיחה הבאה בעברית בצורה קצרה (2-3 משפטים), כולל נקודות עיקריות והחלטות:\n\n${transcript}`;

    try {
      const fakeSummarySession = {
        callId: `${callId}-summary`,
        sessionKey: `${session.sessionKey}-summary`,
        history: [],
      };
      const summary = await this._sendToGateway(fakeSummarySession, summaryPrompt, {
        systemPrompt: 'אתה מסכם שיחות טלפון. ספק סיכום קצר ועניני.',
        name: 'Summarizer',
      });
      return summary;
    } catch (e) {
      console.error(`[BrainMode] Summary error: ${e.message}`);
      return null;
    }
  }

  /**
   * Close session and clean up
   */
  closeSession(callId) {
    this._sessions.delete(callId);
  }

  isAvailable() {
    return !!(this.gatewayUrl);
  }
}

module.exports = { BrainMode };
