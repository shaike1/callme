const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const GroqPipelineSession = require('../../src/groq-pipeline/session');

class FakeSTT extends EventEmitter {
  constructor() {
    super();
    this.sentAudio = [];
    this.connected = false;
    this.closed = false;
  }

  async connect() {
    this.connected = true;
    return this;
  }

  sendAudio(chunk) {
    this.sentAudio.push(chunk);
  }

  close() {
    this.closed = true;
  }
}

class FakeLLM {
  constructor() {
    this.calls = [];
  }

  async chat(text, toolHandler) {
    this.calls.push({ text, hasToolHandler: typeof toolHandler === 'function' });
    return `reply:${text}`;
  }
}

class FakeTTS {
  constructor() {
    this.requests = [];
  }

  async synthesize(text) {
    this.requests.push(text);
    return Buffer.from(`pcm:${text}`);
  }
}

test('connect wires transcript events into a completed response turn', async () => {
  const session = new GroqPipelineSession({
    callId: 'call-1',
    deepgramApiKey: 'dg',
    groqApiKey: 'gq',
    dependencies: {
      DeepgramSTT: FakeSTT,
      GroqLLM: FakeLLM,
      TTSProvider: FakeTTS,
    },
  });

  const seen = [];
  session.on('input_transcript', (text) => seen.push(['input', text]));
  session.on('text', (text) => seen.push(['text', text]));
  session.on('output_transcript', (text) => seen.push(['output', text]));
  session.on('audio', (pcm) => seen.push(['audio', pcm.toString()]));
  session.on('turn_complete', () => seen.push(['done']));

  await session.connect();
  session.stt.emit('transcript', { text: 'shalom', isFinal: true });
  session.stt.emit('utterance_end');

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.ready, true);
  assert.deepEqual(seen, [
    ['input', 'shalom'],
    ['text', 'reply:shalom'],
    ['output', 'reply:shalom'],
    ['audio', 'pcm:reply:shalom'],
    ['done'],
  ]);
});

test('sendText synthesizes and emits a response turn directly', async () => {
  const session = new GroqPipelineSession({
    callId: 'call-2',
    deepgramApiKey: 'dg',
    groqApiKey: 'gq',
    dependencies: {
      DeepgramSTT: FakeSTT,
      GroqLLM: FakeLLM,
      TTSProvider: FakeTTS,
    },
  });

  const events = [];
  session.on('text', (text) => events.push(['text', text]));
  session.on('audio', (pcm) => events.push(['audio', pcm.toString()]));
  session.on('turn_complete', () => events.push(['done']));

  await session.sendText('welcome');

  assert.deepEqual(events, [
    ['text', 'reply:welcome'],
    ['audio', 'pcm:reply:welcome'],
    ['done'],
  ]);
});
