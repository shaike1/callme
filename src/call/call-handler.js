'use strict';
/**
 * Call Handler
 * Orchestrates a single call:
 *   3CX event → audio stream → Whisper STT → keyword detection → BrainMode → TTS → speak
 */

const { EventEmitter } = require('events');
const { speak } = require('../audio/tts-service');
const { BrainMode } = require('../ocplatform/brain-mode');

class CallHandler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.persona = options.persona || {};
    this.threecx = options.threecx || null;
    this.brain = options.brain || new BrainMode();
    this.audioInjector = options.audioInjector || null;
    this._transcripts = new Map(); // callId → [{ts, text}]
    this._responding = new Set();  // callIds currently being responded to (debounce)
  }

  /**
   * New transcript chunk arrived for a call
   */
  async onTranscript({ callId, text }) {
    console.log(`[CallHandler] [${callId}] 📝 "${text}"`);

    if (!this._transcripts.has(callId)) {
      this._transcripts.set(callId, []);
    }
    this._transcripts.get(callId).push({ ts: new Date().toISOString(), text });

    this.emit('transcript', { callId, text });

    // Keyword detection + debounce
    if (this._shouldRespond(text) && !this._responding.has(callId)) {
      this._responding.add(callId);
      try {
        await this._respond(callId, text);
      } finally {
        this._responding.delete(callId);
      }
    }
  }

  /**
   * Check if text contains a trigger keyword
   */
  _shouldRespond(text) {
    const mode = this.persona.respondMode || 'keyword';
    if (mode === 'always') return true;
    if (mode === 'never') return false;

    const keywords = this.persona.keywords || ['callme', 'קולמי'];
    const lower = text.toLowerCase();
    return keywords.some(k => lower.includes(k.toLowerCase()));
  }

  /**
   * Get AI response from OCPlatform brain and speak it
   */
  async _respond(callId, userText) {
    console.log(`[CallHandler] [${callId}] 🧠 Thinking...`);
    this.emit('responding', { callId, userText });

    try {
      const response = await this.brain.think(callId, userText, this.persona);

      if (!response) {
        console.warn(`[CallHandler] [${callId}] No response from brain`);
        return;
      }

      console.log(`[CallHandler] [${callId}] 💬 "${response.slice(0, 80)}${response.length > 80 ? '...' : ''}"`);
      this.emit('response', { callId, text: response });

      // Convert to speech
      const ttsResult = await speak(response, {
        voice: this.persona.voice,
        lang: this.persona.language === 'he' ? 'he-IL' : 'en-US',
      }).catch(e => {
        console.warn(`[CallHandler] TTS failed: ${e.message}`);
        return null;
      });

      if (ttsResult) {
        console.log(`[CallHandler] [${callId}] 🔊 TTS ready: ${ttsResult.filePath}`);

        // Strategy: Serve audio URL and make a call to play it
        if (this.audioInjector) {
          const audioUrl = this.audioInjector.prepareAudioUrl(ttsResult.filePath);
          console.log(`[CallHandler] [${callId}] Audio URL: ${audioUrl}`);
          // TODO: Actual injection into existing call
          // For now: just log and emit the URL
          this.emit('spoke', { callId, text: response, filePath: ttsResult.filePath, audioUrl });
        } else {
          this.emit('spoke', { callId, text: response, filePath: ttsResult.filePath });
        }
      }

    } catch (e) {
      console.error(`[CallHandler] [${callId}] Error: ${e.message}`);
      this.emit('error', { callId, error: e.message });
    }
  }

  /**
   * Call ended — summarize + cleanup
   */
  async onCallEnd(callId) {
    console.log(`[CallHandler] [${callId}] 📴 Call ended`);
    const transcript = this._transcripts.get(callId) || [];

    // Generate summary
    if (transcript.length > 0) {
      const summary = await this.brain.summarize(callId, this.persona).catch(() => null);
      if (summary) {
        console.log(`[CallHandler] [${callId}] 📋 Summary: ${summary}`);
        this.emit('summary', { callId, summary, transcript });
      }
    }

    this.brain.closeSession(callId);
    this._transcripts.delete(callId);
    this._responding.delete(callId);
    this.emit('call:ended', { callId, transcript });
  }

  getTranscript(callId) {
    return this._transcripts.get(callId) || [];
  }

  getActiveCalls() {
    return Array.from(this._transcripts.keys());
  }
}

module.exports = { CallHandler };
