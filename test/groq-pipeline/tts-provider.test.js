const test = require('node:test');
const assert = require('node:assert/strict');

const TTSProvider = require('../../src/groq-pipeline/tts-provider');

test('disables Hebrew TTS when Google credentials are unavailable', () => {
  const provider = new TTSProvider({
    deepgramApiKey: 'dg-test',
    language: 'he-IL',
  });

  assert.equal(provider.enabled, false);
});

test('uses Aura-2 English fallback when Google credentials are unavailable for English', () => {
  const provider = new TTSProvider({
    deepgramApiKey: 'dg-test',
    language: 'en-US',
  });

  assert.equal(provider.enabled, true);
  assert.equal(provider.deepgramVoice, 'aura-2-asteria-en');
});
