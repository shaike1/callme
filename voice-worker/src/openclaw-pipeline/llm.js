/**
 * OpenClawLLM — chat via the OpenClaw gateway's OpenAI-compatible endpoint.
 *
 * The OpenClaw gateway exposes POST /v1/chat/completions with model "openclaw/<agentId>".
 * Conversation history is managed here so each turn is contextual.
 */
const https = require('https');
const http = require('http');
const logger = require('../logger');

class OpenClawLLM {
  constructor({ gatewayUrl, token, agentId = 'main', systemPrompt, callId = '' }) {
    this.callId = callId;
    this.model = `openclaw/${agentId}`;
    this.messages = [];

    // Parse gateway URL
    const url = new URL(gatewayUrl);
    this.protocol = url.protocol === 'https:' ? https : http;
    this.hostname = url.hostname;
    this.port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
    this.token = token;

    if (systemPrompt) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
  }

  async chat(text) {
    this.messages.push({ role: 'user', content: text });

    const body = JSON.stringify({
      model: this.model,
      messages: this.messages,
      max_tokens: 512,
    });

    let responseText;
    try {
      const result = await this._request(body);
      responseText = result?.choices?.[0]?.message?.content?.trim();
      if (!responseText) {
        logger.error('OpenClawLLM: empty response', { callId: this.callId });
        return 'מצטער, לא הצלחתי לקבל תשובה.';
      }
    } catch (err) {
      logger.error('OpenClawLLM request failed', { callId: this.callId, error: err.message });
      return 'מצטער, אירעה שגיאה בתקשורת.';
    }

    this.messages.push({ role: 'assistant', content: responseText });
    return responseText;
  }

  _request(body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this.hostname,
        port: this.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${this.token}`,
        },
      };

      const req = this.protocol.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from OpenClaw: ${data.slice(0, 100)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('OpenClaw request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = OpenClawLLM;
