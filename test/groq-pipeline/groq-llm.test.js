const test = require('node:test');
const assert = require('node:assert/strict');

const GroqLLM = require('../../src/groq-pipeline/groq-llm');

test('returns plain assistant text when no tool calls are present', async () => {
  const llm = new GroqLLM({ apiKey: 'test', callId: 'call-1' });
  llm._request = async () => ({
    choices: [{ message: { role: 'assistant', content: 'shalom' } }],
  });

  const result = await llm.chat('hello');

  assert.equal(result, 'shalom');
  assert.deepEqual(llm.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'shalom' },
  ]);
});

test('executes tool calls and returns the follow-up assistant response', async () => {
  const llm = new GroqLLM({
    apiKey: 'test',
    callId: 'call-2',
    tools: [{ name: 'lookup_contact', description: 'Lookup', parameters: { type: 'object' } }],
  });

  const requests = [];
  llm._request = async (body) => {
    requests.push(body);
    if (requests.length === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tool-1',
              type: 'function',
              function: { name: 'lookup_contact', arguments: '{"name":"dana"}' },
            }],
          },
        }],
      };
    }

    return {
      choices: [{ message: { role: 'assistant', content: 'Found Dana' } }],
    };
  };

  const toolCalls = [];
  const result = await llm.chat('find dana', async (name, args) => {
    toolCalls.push({ name, args });
    return { ok: true, phone: '12345' };
  });

  assert.equal(result, 'Found Dana');
  assert.deepEqual(toolCalls, [{ name: 'lookup_contact', args: { name: 'dana' } }]);
  assert.equal(requests.length, 2);
  assert.equal(llm.messages[2].role, 'tool');
  assert.equal(llm.messages[2].tool_call_id, 'tool-1');
  assert.equal(llm.messages[3].content, 'Found Dana');
});

test('normalizes malformed Groq tool names that embed JSON arguments', async () => {
  const llm = new GroqLLM({
    apiKey: 'test',
    callId: 'call-3',
    tools: [{ name: 'add_contact', description: 'Add contact', parameters: { type: 'object' } }],
  });

  let requestCount = 0;
  llm._request = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tool-2',
              type: 'function',
              function: {
                name: 'add_contact {"name":"אוחזת","phone":"0541234567"}',
                arguments: '',
              },
            }],
          },
        }],
      };
    }

    return {
      choices: [{ message: { role: 'assistant', content: 'איש הקשר נוסף.' } }],
    };
  };

  const toolCalls = [];
  const reply = await llm.chat('save the number', async (name, args) => {
    toolCalls.push({ name, args });
    return { ok: true };
  });

  assert.equal(reply, 'איש הקשר נוסף.');
  assert.deepEqual(toolCalls, [{
    name: 'add_contact',
    args: { name: 'אוחזת', phone: '0541234567' },
  }]);
  assert.deepEqual(llm.messages[1].tool_calls, [{
    id: 'tool-2',
    type: 'function',
    function: {
      name: 'add_contact',
      arguments: '{"name":"אוחזת","phone":"0541234567"}',
    },
  }]);
});
