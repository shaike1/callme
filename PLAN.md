# CallMe Bot — Development Plan

## Vision
AI-powered voice secretary that handles calls, schedules, and CRM — deployable as a white-label SaaS for any business.

---

## Phase 1 — Personal Secretary (DONE)
- Google Calendar integration (OAuth per tenant)
- Telegram Bot per tenant (webhook + commands)
- Dashboard UX overhaul (app grid, drawer panels)
- Contact management + Google Contacts sync

## Phase 2 — Core Strengthening (DONE)
- AI call summary + intent detection (Gemini Flash)
- Call transfer (FreeSWITCH blind transfer)
- Dashboard stats widgets + live transcript viewer
- CRM webhook (POST call data to external URL)
- Deep search across recordings
- PWA (manifest + service worker)
- Audit log (backend + dashboard UI)

## Phase 3 — Notifications & Automation (DONE)
- SMS notifications (Twilio SMS API)
- Scheduled callbacks (API + dashboard + scheduler tick)
- Blacklist/whitelist (call filter with wildcard support)
- Call recording download (WAV/MP3)
- Multi-language (he/en/ar/ru/fr/es + auto-detect)
- CRM webhook retry (3 attempts with backoff)

## Phase 4 — Intelligence & Analytics (DONE)
- Call notes (add/delete per recording)
- Call tags (VIP, urgent, follow-up, resolved, spam)
- CSV export (all recordings, UTF-8 BOM for Hebrew)
- Auto-blacklist (5 short calls -> auto-block + Telegram alert)
- Sentiment analysis (positive/neutral/negative/frustrated)
- Voicemail-to-text (Gemini transcription)
- Email notifications (raw SMTP with STARTTLS)
- Enhanced call analytics (daily chart, sentiment breakdown, top callers)

## Phase 5 — Advanced Integrations (DONE)
- Call queue (SIP 486 Busy when occupied)
- Custom AI tools (dashboard-defined, webhook-backed)
- Zapier/Make generic webhook (event-driven)
- Google Sheets sync (googleapis Sheets API)
- Auto follow-up (schedule callback on AI action items)

## Phase 6 — Power Features (DONE)
- Keyboard shortcuts for dashboard navigation
- Audio playback in transcript modal

## Phase 7 — Operations & Management (DONE)
- Business hours (auto-voicemail outside hours)
- Live call monitor (real-time dashboard, 3s refresh)
- Call rating (1-5 stars on recordings)
- Speed dial (favorites + one-click dial)
- Webhook logs (delivery history in dashboard)
- API keys (generate/manage for external access)
- Call queue UI (full dashboard panel)
- Auto-reply SMS (to callers when queued/after-hours)
- Email/Zapier settings UI in dashboard
- Drachtio secret fix (SIP connection restored)

---

## Phase 8 — Next Up (PLANNED)
- [ ] IVR Menu Builder enhancements (multi-level menus, DTMF routing)
- [ ] Call recording playback waveform visualization
- [ ] Dashboard real-time WebSocket updates (no polling)
- [ ] Caller ID reputation scoring (integrate with spam databases)
- [ ] Multi-tenant billing (usage tracking per tenant, Stripe integration)
- [ ] Agent roles & skills (route calls by topic/language/expertise)
- [ ] Call whisper/barge (supervisor can listen or join live calls)
- [ ] Outbound campaign dialer (bulk calls with script)
- [ ] AI-powered FAQ builder (auto-generate from call transcripts)
- [ ] Voice cloning (custom TTS voice per tenant)

## Phase 9 — SaaS Platform (PLANNED)
- [ ] Self-service signup + onboarding wizard
- [ ] Stripe subscription billing (per-minute or flat rate)
- [ ] White-label branding (logo, colors, domain per tenant)
- [ ] SLA monitoring + uptime dashboard
- [ ] API documentation (Swagger/OpenAPI)
- [ ] Webhook signature verification (HMAC)
- [ ] Rate limiting per API key
- [ ] Multi-region deployment (EU, US, IL)
- [ ] GDPR compliance (data export, deletion, retention policies)
- [ ] SOC 2 audit preparation

## Phase 10 — Multi-Agent (PLANNED)
- [ ] Agent marketplace (pre-built personas: receptionist, support, sales)
- [ ] Agent-to-agent handoff (escalation chains)
- [ ] Knowledge base per agent (RAG with embeddings)
- [ ] Conversation memory (cross-call context per caller)
- [ ] A/B testing for agent prompts
- [ ] Agent performance analytics (resolution rate, satisfaction)

---

## Architecture

```
Caller (PSTN/SIP) --> 3CX/Twilio/Vonage --> Drachtio SIP --> FreeSWITCH
                                                                  |
                                                           voice-worker
                                                           /     |     \
                                                    Gemini   Groq    OpenClaw
                                                    Live    Pipeline  Engine
                                                          |
                                                    Dashboard (Express)
                                                    /    |    \     \
                                              Telegram  SMS  Email  Webhooks
```

## Tech Stack
- **Runtime**: Node.js 20 + Express
- **SIP**: Drachtio + FreeSWITCH (via drachtio-srf + drachtio-fsmrf)
- **AI Engines**: Gemini Live, Groq Pipeline (Deepgram STT + Groq LLM + Google TTS), OpenClaw
- **Integrations**: Telegram, WhatsApp (CallMeBot), Twilio, Vonage, Google Calendar, Google Sheets, Home Assistant
- **Storage**: JSON files on disk (recordings, settings, audit log)
- **Deploy**: Docker (single container, host network), Caddy reverse proxy
- **Frontend**: Single-page HTML dashboard (vanilla JS, no framework)
