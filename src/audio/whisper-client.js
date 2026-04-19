'use strict';
/**
 * Whisper STT Client
 * Supports: OpenAI Whisper API / local Whisper HTTP API
 * Converts PCM audio buffers to text — Hebrew + English auto-detect
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const FormData = require('form-data');

// Lazy OpenAI client
let openai = null;
function getOpenAI() {
  if (!openai) {
    const { OpenAI } = require('openai');
    const baseURL = process.env.OPENAI_BASE_URL || undefined;
    const apiKey = process.env.OPENAI_API_KEY || 'not-set';
    openai = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }
  return openai;
}

/**
 * Convert raw L16 PCM buffer → WAV buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 8000) {
  const { WaveFile } = require('wavefile');
  const wav = new WaveFile();
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  wav.fromScratch(1, sampleRate, '16', samples);
  return Buffer.from(wav.toBuffer());
}

/**
 * Transcribe via local Whisper HTTP API (e.g. whisper.cpp server)
 * POST multipart/form-data with audio file
 */
async function transcribeLocal(audioBuffer, options = {}) {
  const whisperUrl = process.env.WHISPER_API_URL || 'http://localhost:9091';
  const language = options.language || process.env.WHISPER_DEFAULT_LANG || 'he';

  const wavBuffer = options.format === 'wav' ? audioBuffer : pcmToWav(audioBuffer, options.sampleRate);
  const tempFile = `/tmp/callme-whisper-${Date.now()}.wav`;
  fs.writeFileSync(tempFile, wavBuffer);

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(tempFile), { filename: 'audio.wav', contentType: 'audio/wav' });
    form.append('language', language);

    const result = await new Promise((resolve, reject) => {
      const req = form.submit(whisperUrl + '/inference', (err, res) => {
        if (err) return reject(err);
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({ text: raw.trim() }); }
        });
      });
    });
    return (result.text || '').trim();
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

/**
 * Transcribe via OpenAI Whisper API
 */
async function transcribeOpenAI(audioBuffer, options = {}) {
  const language = options.language || process.env.WHISPER_DEFAULT_LANG || 'he';
  const wavBuffer = options.format === 'wav' ? audioBuffer : pcmToWav(audioBuffer, options.sampleRate);
  const tempFile = `/tmp/callme-whisper-${Date.now()}.wav`;
  fs.writeFileSync(tempFile, wavBuffer);

  try {
    const client = getOpenAI();
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: 'whisper-1',
      language,
      response_format: 'text',
    });
    return (transcription || '').trim();
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

/**
 * Main transcribe function — routes to local or OpenAI
 */
async function transcribe(audioBuffer, options = {}) {
  const useLocal = !!(process.env.WHISPER_API_URL);

  const start = Date.now();
  const text = useLocal
    ? await transcribeLocal(audioBuffer, options)
    : await transcribeOpenAI(audioBuffer, options);

  console.log(`[Whisper] transcribed in ${Date.now() - start}ms: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
  return text;
}

function isAvailable() {
  return !!(process.env.WHISPER_API_URL || process.env.OPENAI_API_KEY);
}

module.exports = { transcribe, pcmToWav, isAvailable };
