const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveGoogleTtsKeyPath } = require('../../src/groq-pipeline/tts-config');

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('prefers explicit existing key path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-config-'));
  const explicit = path.join(tmpDir, 'explicit.json');
  const envPath = path.join(tmpDir, 'env.json');
  fs.writeFileSync(explicit, '{}');
  fs.writeFileSync(envPath, '{}');

  withEnv({ GOOGLE_CLOUD_TTS_KEY_PATH: envPath, GOOGLE_APPLICATION_CREDENTIALS: undefined }, () => {
    assert.equal(resolveGoogleTtsKeyPath(explicit), explicit);
  });
});

test('falls back to configured env path when explicit path is missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-config-'));
  const envPath = path.join(tmpDir, 'env.json');
  fs.writeFileSync(envPath, '{}');

  withEnv({ GOOGLE_CLOUD_TTS_KEY_PATH: envPath, GOOGLE_APPLICATION_CREDENTIALS: undefined }, () => {
    assert.equal(resolveGoogleTtsKeyPath(path.join(tmpDir, 'missing.json')), envPath);
  });
});

test('returns undefined when no candidate path exists', () => {
  withEnv({ GOOGLE_CLOUD_TTS_KEY_PATH: undefined, GOOGLE_APPLICATION_CREDENTIALS: undefined }, () => {
    assert.equal(resolveGoogleTtsKeyPath('/definitely/missing/key.json'), undefined);
  });
});
