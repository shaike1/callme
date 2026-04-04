const fs = require('fs');

function resolveGoogleTtsKeyPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.GOOGLE_CLOUD_TTS_KEY_PATH,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    '/app/keys/google-tts-key.json',
    '/app/google-tts-sa.json',
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch (_) {
      return false;
    }
  });
}

module.exports = {
  resolveGoogleTtsKeyPath,
};
