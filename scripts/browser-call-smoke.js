#!/usr/bin/env node

const WebSocket = require('ws');
const fs = require('fs');

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const endpoint = getArg('url', process.env.BROWSER_CALL_WS_URL || 'ws://127.0.0.1:3101/api/browser-call');
  const user = getArg('user', process.env.BROWSER_CALL_USER || 'superadmin');
  const pass = getArg('pass', process.env.BROWSER_CALL_PASS || '');
  const language = getArg('language', process.env.BROWSER_CALL_LANGUAGE || 'he');
  const timeoutMs = parseInt(getArg('timeout-ms', process.env.BROWSER_CALL_TIMEOUT_MS || '20000'), 10);
  const token = getArg('token', process.env.BROWSER_CALL_TOKEN || Buffer.from(`${user}:${pass}`).toString('base64'));
  const audioFile = getArg('audio-file', process.env.BROWSER_CALL_AUDIO_FILE || '');
  const chunkBytes = parseInt(getArg('chunk-bytes', process.env.BROWSER_CALL_CHUNK_BYTES || '3200'), 10);
  const chunkDelayMs = parseInt(getArg('chunk-delay-ms', process.env.BROWSER_CALL_CHUNK_DELAY_MS || '20'), 10);
  const tailSilenceMs = parseInt(getArg('tail-silence-ms', process.env.BROWSER_CALL_TAIL_SILENCE_MS || '800'), 10);
  const url = new URL(endpoint);
  url.searchParams.set('token', token);

  const results = {
    statuses: [],
    transcripts: [],
    audioChunks: 0,
    audioBytes: 0,
    sentFakeAudio: false,
    sentAudioFile: !!audioFile,
  };

  const ws = new WebSocket(url.toString(), { perMessageDeflate: false });
  let settled = false;
  let audioTriggered = false;
  let baselineBotTranscripts = 0;
  let baselineAudioChunks = 0;

  const hasBotTranscript = () => results.transcripts.some((entry) => entry.role === 'bot' && entry.text);
  const hasUserTranscript = () => results.transcripts.some((entry) => entry.role === 'user' && entry.text);
  const sendPcmFile = async (filename) => {
    const audio = fs.readFileSync(filename);
    for (let offset = 0; offset < audio.length; offset += chunkBytes) {
      const chunk = audio.subarray(offset, Math.min(offset + chunkBytes, audio.length));
      ws.send(chunk);
      if (chunkDelayMs > 0) await wait(chunkDelayMs);
    }
    if (tailSilenceMs > 0) {
      const silenceFrames = Math.max(1, Math.ceil(tailSilenceMs / Math.max(chunkDelayMs, 20)));
      for (let i = 0; i < silenceFrames; i++) {
        ws.send(Buffer.alloc(chunkBytes));
        if (chunkDelayMs > 0) await wait(chunkDelayMs);
      }
    }
  };
  const maybeSucceed = async () => {
    if (!audioTriggered) return;
    if (!results.statuses.includes('ready') || !results.statuses.includes('listening')) return;
    if (!audioFile) {
      if (results.audioChunks < 1 && !hasBotTranscript()) return;
    } else {
      const botRepliesAfterAudio = results.transcripts.filter((entry) => entry.role === 'bot').length - baselineBotTranscripts;
      const audioAfterInput = results.audioChunks - baselineAudioChunks;
      if (!hasUserTranscript()) return;
      if (botRepliesAfterAudio < 1 && audioAfterInput < 1) return;
    }
    await wait(250);
    clearTimeout(timeout);
    finish(0, { results });
  };

  const finish = (code, payload) => {
    if (settled) return;
    settled = true;
    if (code === 0) {
      console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
    } else {
      console.error(JSON.stringify({ ok: false, ...payload }, null, 2));
    }
    ws.terminate();
    process.exit(code);
  };

  const timeout = setTimeout(() => {
    finish(1, { error: 'timeout', results });
  }, timeoutMs);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      language,
      systemPrompt: 'ענה בקצרה בעברית. זהו smoke test אוטומטי.',
    }));
  });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      results.audioChunks += 1;
      results.audioBytes += data.length;
      await maybeSucceed();
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (error) {
      return finish(1, { error: `invalid-json:${error.message}`, raw: data.toString() });
    }

    if (msg.type === 'status') {
      results.statuses.push(msg.state);
      if (msg.state === 'listening' && !audioTriggered) {
        baselineBotTranscripts = results.transcripts.filter((entry) => entry.role === 'bot').length;
        baselineAudioChunks = results.audioChunks;
        audioTriggered = true;
        results.sentFakeAudio = !audioFile;
        if (audioFile) {
          await sendPcmFile(audioFile);
        } else {
          for (let i = 0; i < 8; i++) {
            ws.send(Buffer.alloc(3200));
          }
        }
      }
      await maybeSucceed();
    } else if (msg.type === 'transcript') {
      results.transcripts.push({ role: msg.role, text: msg.text });
      await maybeSucceed();
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(timeout);
    if (!settled) {
      finish(code === 1000 ? 0 : 1, {
        error: 'closed',
        closeCode: code,
        closeReason: reason.toString(),
        results,
      });
    }
  });

  ws.on('error', (error) => {
    clearTimeout(timeout);
    finish(1, { error: error.message, results });
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
