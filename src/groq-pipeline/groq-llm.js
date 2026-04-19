/**
 * GroqLLM — chat completion with tool calling via Groq API.
 *
 * Manages conversation history and streams responses for low latency.
 * Uses the Groq REST API directly (no SDK dependency needed).
 */
const https = require('https');
const logger = require('../logger');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

function normalizeToolName(rawName) {
  const trimmed = String(rawName || '').trim();
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)/);
  return match ? match[1] : trimmed;
}

function normalizeToolArguments(rawArgs, fallbackName) {
  const inlineArgs = String(fallbackName || '').trim().replace(/^[A-Za-z0-9_.-]+\s*/, '');
  if (typeof rawArgs === 'string' && rawArgs.trim()) return rawArgs.trim();
  if (rawArgs && typeof rawArgs === 'object') return JSON.stringify(rawArgs);
  if (inlineArgs.startsWith('{')) return inlineArgs;
  return '{}';
}

function normalizeToolCall(tc) {
  const rawName = tc?.function?.name || '';
  const name = normalizeToolName(rawName);
  const args = normalizeToolArguments(tc?.function?.arguments, rawName);
  return {
    id: tc?.id,
    type: 'function',
    function: {
      name,
      arguments: args,
    },
  };
}

function normalizeAssistantMessage(msg) {
  const toolCalls = Array.isArray(msg?.tool_calls)
    ? msg.tool_calls.map(normalizeToolCall)
    : undefined;

  const normalized = {
    role: 'assistant',
    content: typeof msg?.content === 'string' ? msg.content : null,
  };

  if (toolCalls && toolCalls.length > 0) {
    normalized.tool_calls = toolCalls;
  }

  return normalized;
}

class GroqLLM {
  constructor({ apiKey, model, systemPrompt, tools, callId = '' }) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.callId = callId;
    this.tools = tools || [];
    this.messages = [];

    if (systemPrompt) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
  }

  /**
   * Send a user message and get the assistant's response.
   * Handles tool calls automatically using the provided toolHandler.
   *
   * @param {string} text - User's transcribed speech
   * @param {function} toolHandler - async (name, args) => result
   * @returns {Promise<string>} - Assistant's text response
   */
  async chat(text, toolHandler) {
    this.messages.push({ role: 'user', content: text });

    const maxToolRounds = 5;
    for (let round = 0; round < maxToolRounds; round++) {
      const body = {
        model: this.model,
        messages: this.messages,
        temperature: 0.7,
        max_tokens: 1024,
      };

      if (this.tools.length > 0) {
        body.tools = this.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          }
        }));
        body.tool_choice = 'auto';
      }

      const response = await this._request(body);

      if (!response.choices?.[0]) {
        logger.error('Groq: no choices in response', { callId: this.callId });
        return 'מצטער, אירעה שגיאה.';
      }

      const choice = response.choices[0];
      const msg = choice.message || {};
      const assistantMessage = normalizeAssistantMessage(msg);

      // Add assistant message to history
      this.messages.push(assistantMessage);

      // If no tool calls, return the text response
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        return msg.content || '';
      }

      // Handle tool calls
      for (const tc of assistantMessage.tool_calls) {
        const fnName = tc.function.name;
        let fnArgs;
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch {
          fnArgs = {};
        }

        logger.info('Groq tool call', { callId: this.callId, tool: fnName, args: fnArgs });

        let result;
        try {
          result = toolHandler ? await toolHandler(fnName, fnArgs) : { error: 'No tool handler' };
        } catch (err) {
          logger.error('Tool handler error', { callId: this.callId, tool: fnName, error: err.message });
          result = { error: err.message };
        }

        this.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      // Loop back to get the assistant's response after tool results
    }

    logger.warn('Groq: max tool rounds reached', { callId: this.callId });
    return 'מצטער, נתקלתי בבעיה.';
  }

  /**
   * Make a request to Groq API.
   */
  _request(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url = new URL(GROQ_API_URL);

      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              logger.error('Groq API error', {
                callId: this.callId,
                status: res.statusCode,
                error: parsed.error?.message || responseData.slice(0, 200)
              });
              reject(new Error(parsed.error?.message || `Groq API ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error('Failed to parse Groq response'));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('Groq API timeout'));
      });
      req.write(data);
      req.end();
    });
  }
}

module.exports = GroqLLM;
