# CallMe Bot

**An AI voice assistant that calls *you* — not just answers.**

Built on 3CX + SIP, powered by Gemini Live / Groq / OpenClaw. Speak Hebrew (or any language) with a real phone call, backed by AI that knows your calendar, contacts, and smart home.

---

## What it does

- **Outbound calls** — the bot initiates calls to any phone number or extension
- **Two-way voice conversation** — real-time, low-latency AI voice in Hebrew
- **Personal assistant** — connect OpenClaw as the AI brain: it remembers, plans, and acts
- **Human-in-the-loop** — Claude Code can call you mid-task for confirmation
- **Smart home alerts** — Home Assistant triggers a call when something happens
- **Multi-tenant SaaS ready** — multiple tenants, separate extensions, per-tenant cost limits

---

## Architecture

```
Phone (3CX app / desk phone)
        │
        ▼
3CX Cloud (YOUR_COMPANY.3cx.cloud)
        │  SIP over TLS
        ▼
drachtio  ← SIP signaling (Docker, port 5070)
        │
        ▼
FreeSWITCH  ← RTP media (Docker, port 5080)
        │  audio fork (WebSocket)
        ▼
voice-worker  ← Node.js (port 3101)
   ├── AI Engine: Gemini Live  (Google — $5.70/hr)
   ├── AI Engine: Groq Pipeline  (Deepgram STT + Groq LLM + Google TTS — $0.66/hr)
   └── AI Engine: OpenClaw  (Deepgram STT + Luky Bot + Google TTS — your AI brain)
```

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/shaike1/callme.git
cd callme
cp .env.example .env
# Edit .env with your values
```

### 2. Start

```bash
docker compose up -d
```

### 3. Open the dashboard

```
http://YOUR_SERVER_IP:3101
```

Default login: `admin` / `callme2024` (change it in Settings immediately)

---

## AI Engines

| Engine | Cost/hr | Notes |
|--------|---------|-------|
| **Gemini Live** | ~$5.70 | Google real-time voice, lowest latency |
| **Groq Pipeline** | ~$0.66 | Deepgram STT + Groq Llama + Google TTS. Cheapest. |
| **OpenClaw** | varies | Your OpenClaw agent as the AI brain — full tool access |

Switch engines in Settings → Engine.

---

## Outbound Call API

```bash
# Place a call
curl -X POST https://YOUR_SERVER/call \
  -u "username:password" \
  -H "Content-Type: application/json" \
  -d '{"to": "+972501234567"}'

# Response
{"success": true, "callId": "out-...", "status": "calling"}
```

### Home Assistant webhook

```bash
POST /api/ha/webhook
{"to": "12610", "persona": "Optional system prompt for this call"}
```

---

## OpenClaw Phone-Call Plugin

Let OpenClaw AI proactively make calls as a tool action.

### Install

```bash
cp -R openclaw-phone-call ~/.openclaw/extensions/phone-call
cd ~/.openclaw/extensions/phone-call
# Install @sinclair/typebox if needed:
mkdir -p node_modules/@sinclair
ln -s ~/.openclaw/extensions/lossless-claw/node_modules/@sinclair/typebox \
      node_modules/@sinclair/typebox
```

### Configure in OpenClaw

```json
{
  "voiceServerUrl": "https://callme.right-api.com",
  "username": "openclaw",
  "password": "your-api-password",
  "defaultDevice": "12611"
}
```

---

## Environment Variables

```env
# Network
EXTERNAL_IP=YOUR_SERVER_LAN_IP

# Drachtio
DRACHTIO_HOST=127.0.0.1
DRACHTIO_SECRET=your_drachtio_secret

# FreeSWITCH
FREESWITCH_HOST=127.0.0.1
FREESWITCH_SECRET=JambonzR0ck$$

# 3CX SIP
SIP_DOMAIN=YOUR_COMPANY.3cx.cloud
SIP_EXTENSION=12611
SIP_AUTH_ID=YOUR_SIP_AUTH_ID
SIP_AUTH_PASSWORD=YOUR_SIP_PASSWORD

# AI
GEMINI_API_KEY=
GROQ_API_KEY=
DEEPGRAM_API_KEY=

# OpenClaw (optional)
OPENCLAW_GATEWAY_TOKEN=

# Google TTS (for Groq/OpenClaw engines)
# Mount service account JSON: ./voice-worker/google-tts-sa.json
```

---

## Port Reference

| Port | Service |
|------|---------|
| 5060 | 3CX SmartSBC |
| 5070 | drachtio SIP |
| 5080 | FreeSWITCH RTP |
| 3101 | voice-worker (dashboard + API) |
| 3001 | audio fork WebSocket |

---

## License

MIT
