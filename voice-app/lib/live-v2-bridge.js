const axios = require('axios');
const { WaveFile } = require('wavefile');
const logger = require('./logger');

const V2_PROCESS_URL = process.env.V2_PROCESS_URL || 'http://127.0.0.1:8080/api/v1/process';
const V2_LIVE_PULL_BASE = process.env.V2_LIVE_PULL_BASE || 'http://127.0.0.1:8080/api/v1/live/session';
const V2_HTTP_TIMEOUT_MS = parseInt(process.env.V2_HTTP_TIMEOUT_MS || '45000', 10);

function pcmToWavBuffer(pcmBuffer, sampleRate = 16000) {
  const wav = new WaveFile();
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
  wav.fromScratch(1, sampleRate, '16', samples);
  return Buffer.from(wav.toBuffer());
}

async function processTurn({
  callId,
  audioBuffer,
  language = 'he',
  systemPrompt = null,
  interruptible = true,
  conversationEngine = 'gemini-live',
  saveAudio,
  sampleRate = 16000,
}) {
  if (typeof saveAudio !== 'function') {
    throw new Error('saveAudio function is required for V2 live bridge');
  }

  const payload = {
    call_id: callId,
    audio_data: Buffer.from(audioBuffer).toString('base64'),
    language,
    conversation_engine: conversationEngine,
    system_prompt: systemPrompt,
    interruptible,
  };

  logger.info('Sending turn to v2 processor', {
    callId,
    conversationEngine,
    bytes: audioBuffer.length,
    url: V2_PROCESS_URL,
  });

  const response = await axios.post(V2_PROCESS_URL, payload, {
    timeout: V2_HTTP_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
  });

  const data = response.data || {};
  let audioData = data.audio_data || null;

  if (!audioData && conversationEngine === 'gemini-live') {
    try {
      const pull = await axios.get(`${V2_LIVE_PULL_BASE}/${encodeURIComponent(callId)}/pull`, {
        timeout: 1500,
        params: { timeout_ms: 600 },
      });
      if (pull.data && pull.data.audio_data) {
        audioData = pull.data.audio_data;
        if (!data.response && pull.data.output_transcription) data.response = pull.data.output_transcription;
        if (!data.text && pull.data.input_transcription) data.text = pull.data.input_transcription;
      }
    } catch (err) {
      logger.warn('V2 live pull failed', { callId, error: err.message });
    }
  }

  let audioUrl = null;
  if (audioData) {
    const rawAudio = Buffer.from(audioData, 'base64');
    const wavAudio = pcmToWavBuffer(rawAudio, sampleRate);
    audioUrl = await saveAudio(wavAudio, 'wav');
  }

  return {
    transcript: data.text || '',
    responseText: data.response || '',
    audioUrl,
    raw: data,
  };
}

module.exports = {
  processTurn,
  pcmToWavBuffer,
};
