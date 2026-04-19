'use strict';
/**
 * TTS Service
 * Providers: Google Cloud TTS (he-IL) → ElevenLabs fallback → OpenAI TTS fallback
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

let audioDir = '/tmp/callme-tts';

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function setAudioDir(dir) {
  audioDir = dir;
  ensureDir(dir);
}

function cacheKey(text, voice) {
  return crypto.createHash('md5').update(text + voice).digest('hex').slice(0, 10);
}

/** Google Cloud TTS — he-IL-Wavenet-B */
async function googleTTS(text, options = {}) {
  const key = process.env.GOOGLE_TTS_KEY;
  if (!key) throw new Error('GOOGLE_TTS_KEY not set');

  const voice = options.voice || 'he-IL-Wavenet-B';
  const lang = options.lang || 'he-IL';

  const res = await axios.post(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
    {
      input: { text },
      voice: { languageCode: lang, name: voice },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0 },
    }
  );

  if (!res.data.audioContent) throw new Error('Google TTS: no audio content');
  return Buffer.from(res.data.audioContent, 'base64');
}

/** Azure TTS */
async function azureTTS(text, options = {}) {
  const key = process.env.AZURE_TTS_KEY;
  const region = process.env.AZURE_TTS_REGION || 'israelcentral';
  if (!key) throw new Error('AZURE_TTS_KEY not set');

  const voice = options.voice || 'he-IL-AvriNeural';
  const tokenRes = await axios.post(
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    null,
    { headers: { 'Ocp-Apim-Subscription-Key': key } }
  );
  const token = tokenRes.data;

  const ssml = `<speak version="1.0" xml:lang="he-IL">
    <voice xml:lang="he-IL" name="${voice}">${text}</voice>
  </speak>`;

  const audioRes = await axios.post(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    ssml,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(audioRes.data);
}

/** ElevenLabs TTS */
async function elevenLabsTTS(text, options = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not set');

  const voiceId = options.voiceId || process.env.ELEVENLABS_VOICE_ID || 'JAgnJveGGUh4qy4kh6dF';
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    { text, model_id: 'eleven_turbo_v2' },
    {
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(res.data);
}

/**
 * Generate speech — tries providers in order
 * Returns: { filePath, url, buffer }
 */
async function speak(text, options = {}) {
  ensureDir(audioDir);

  const fname = `tts-${Date.now()}-${cacheKey(text, options.voice || 'default')}.mp3`;
  const filePath = path.join(audioDir, fname);

  // Provider chain
  const providers = [];
  if (process.env.GOOGLE_TTS_KEY) providers.push({ name: 'google', fn: googleTTS });
  if (process.env.AZURE_TTS_KEY) providers.push({ name: 'azure', fn: azureTTS });
  if (process.env.ELEVENLABS_API_KEY) providers.push({ name: 'elevenlabs', fn: elevenLabsTTS });

  if (providers.length === 0) {
    throw new Error('No TTS provider configured (GOOGLE_TTS_KEY / AZURE_TTS_KEY / ELEVENLABS_API_KEY)');
  }

  let lastErr;
  for (const p of providers) {
    try {
      const buf = await p.fn(text, options);
      fs.writeFileSync(filePath, buf);
      console.log(`[TTS] ${p.name} → ${fname} (${buf.length} bytes)`);
      return { filePath, buffer: buf };
    } catch (e) {
      console.warn(`[TTS] ${p.name} failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

function isAvailable() {
  return !!(process.env.GOOGLE_TTS_KEY || process.env.AZURE_TTS_KEY || process.env.ELEVENLABS_API_KEY);
}

module.exports = { speak, setAudioDir, isAvailable };
