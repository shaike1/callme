'use strict';
/**
 * OpenClaw Client
 * HTTP client to the OCPlatform gateway
 * Manages sessions per call, routes transcript → AI response
 */

const http = require('http');
const https = require('https');

class OCPlatformClient {
  constructor(options = {}) {
    this.gatewayUrl = options.gatewayUrl || process.env.OCPLATFORM_GATEWAY_URL || 'http://100.64.0.12:18789';
    this.token = options.token || process.env.OCPLATFORM_TOKEN || '';
    this._sessions = new Map(); // callId → sessionId
  }

  async _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.gatewayUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const bodyStr = body ? JSON.stringify(body) : null;
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, data: { text: raw } }); }
        });
      });

      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * Send transcript to OCPlatform and get AI response
   */
  async chat(callId, transcript, persona = {}) {
    // Reuse or create session per call
    let sessionId = this._sessions.get(callId);

    try {
      const res = await this._request('POST', '/api/v1/chat', {
        sessionId,
        message: transcript,
        persona: {
          name: persona.name || 'Callme',
          systemPrompt: persona.systemPrompt || '',
          language: persona.language || 'he',
        },
      });

      if (res.status === 200 && res.data.sessionId) {
        this._sessions.set(callId, res.data.sessionId);
      }

      return res.data.response || res.data.text || '';
    } catch (e) {
      console.error(`[OCPlatform] chat error: ${e.message}`);
      return null;
    }
  }

  /**
   * Close session for a call
   */
  async closeSession(callId) {
    const sessionId = this._sessions.get(callId);
    if (sessionId) {
      try {
        await this._request('DELETE', `/api/v1/sessions/${sessionId}`);
      } catch {}
      this._sessions.delete(callId);
    }
  }

  isAvailable() {
    return !!(this.gatewayUrl);
  }
}

module.exports = { OCPlatformClient };
