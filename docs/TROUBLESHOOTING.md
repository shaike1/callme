# Troubleshooting Guide

Common issues and solutions for Claude Phone.

## Quick Diagnostics

Start here for most problems:

```bash
claude-phone doctor   # Automated health checks
claude-phone status   # Service status overview
claude-phone logs     # View recent logs
```

## Setup Issues

### "API key validation failed"

**Symptom:** Setup fails when validating ElevenLabs or OpenAI key.

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Key is incorrect | Double-check you copied the full key |
| No billing enabled | Add payment method to your account |
| Account suspended | Check account status on provider dashboard |
| Network issue | Check internet connectivity |

**For OpenAI specifically:**
- New accounts need billing enabled before API works
- Free tier credits expire after 3 months
- Check [platform.openai.com/account/billing](https://platform.openai.com/account/billing)

**For ElevenLabs:**
- Free tier has limited characters/month
- Check [elevenlabs.io/subscription](https://elevenlabs.io/subscription)

### "Can't detect 3CX SBC"

**Symptom:** Setup can't connect to your 3CX server.

**Solutions:**
1. Verify 3CX FQDN is correct (e.g., `yourcompany.3cx.us`)
2. Ensure 3CX SBC (Session Border Controller) is enabled
3. Check firewall allows port 5060 (SIP) outbound
4. Try using port 5070 if 5060 is blocked

### "Docker not found" or "Docker not running"

**Symptom:** Prerequisite check fails for Docker.

**Solutions:**

**macOS:**
```bash
# Install Docker Desktop
brew install --cask docker
# Then launch Docker Desktop from Applications
```

**Linux (Debian/Ubuntu):**
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in
```

**Raspberry Pi:**
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker pi
# Reboot the Pi
```

## Connection Issues

### Calls don't connect at all

**Symptom:** Phone rings forever or immediately fails.

**Checklist:**
1. Is the extension registered with 3CX?
   ```bash
   claude-phone status
   # Look for "SIP Registration: OK"
   ```

2. Is the SIP domain correct?
   ```bash
   claude-phone config show
   # Check sip.domain matches your 3CX FQDN
   ```

3. Are credentials correct?
   - Log into 3CX admin panel
   - Check extension auth ID and password match config

4. Is drachtio container running?
   ```bash
   docker ps | grep drachtio
   ```

### Extension not registering with 3CX

**Symptom:** `claude-phone status` shows SIP registration failed.

**Solutions:**
1. Verify extension exists in 3CX
2. Check auth ID matches (usually same as extension number)
3. Verify password is correct
4. Ensure SBC is enabled in 3CX settings
5. Check if another device is using the same extension

### Calls connect but no audio

**Symptom:** Call connects, you can see it's answered, but there's silence.

**Most common cause:** Wrong `EXTERNAL_IP` setting.

**Fix:**
```bash
# Find your server's LAN IP
ip addr show | grep "inet " | grep -v 127.0.0.1

# Re-run setup to fix
claude-phone setup
# Enter correct IP when prompted for "External IP"
```

**Other causes:**
- RTP ports blocked by firewall (needs 30000-30100 UDP)
- NAT issues (server can't receive return audio)
- FreeSWITCH container unhealthy

### RTP Port Conflict (3CX SBC)

**Symptom:** Calls fail with "INCOMPATIBLE_DESTINATION" error. Logs show `AUDIO RTP REPORTS ERROR: [Bind Error! IP:port]`.

**Cause:** 3CX SBC uses RTP ports 20000-20099. If FreeSWITCH uses the same range, it can't bind.

**Fix:** Claude Phone uses ports 30000-30100 by default. If you upgraded from an older version:

```bash
# Check current port config
grep "rtp-range" ~/.claude-phone/docker-compose.yml

# If it shows 20000, update to 30000:
sed -i 's/--rtp-range-start 20000/--rtp-range-start 30000/' ~/.claude-phone/docker-compose.yml
sed -i 's/--rtp-range-end 20100/--rtp-range-end 30100/' ~/.claude-phone/docker-compose.yml

# Restart services
claude-phone stop
claude-phone start
```

## Runtime Issues

### "Sorry, something went wrong" on every call

**Symptom:** Calls connect, but Claude always says there was an error.

**Causes:**

1. **API server unreachable:**
   ```bash
   claude-phone status
   # Check "Claude API Server" status

   # For split deployments, verify connectivity:
   curl http://<api-server-ip>:3333/health
   ```

2. **Claude Code CLI not working:**
   ```bash
   # On the API server machine:
   claude --version
   claude "Hello"  # Test basic functionality
   ```

3. **Session errors:**
   ```bash
   claude-phone logs voice-app | grep -i error
   ```

### Speech-to-Text (STT) errors

**Symptom:** Claude responds to wrong words or doesn't understand speech.

The STT stack tries providers in order: **Google Cloud STT → Google Web Speech (free) → OpenAI Whisper**

| Cause | Solution |
|-------|----------|
| Google Cloud key missing | Set `GOOGLE_CLOUD_KEY` in `.env` and recreate container |
| `FLAC conversion utility not available` | `flac` package missing from Docker image — rebuild |
| OpenAI billing exhausted | Add credits, or rely on free Google Web Speech fallback |
| Audio quality poor | Check microphone, reduce background noise |

**FLAC fix (if on older image):**
```bash
# Add flac to voice-app Dockerfile:
# apt-get install -y python3 python3-pip flac
docker compose build voice-app && docker compose up -d voice-app
```

**Verify Google Cloud key is inside container:**
```bash
docker exec voice-app printenv GOOGLE_CLOUD_KEY
# If empty, do a force-recreate (restart is not enough for env_file changes):
docker compose up -d --force-recreate voice-app
```

### TTS errors / no audio response

**Symptom:** Claude's responses aren't spoken, or voice sounds wrong.

The TTS stack tries providers in order: **Google Cloud TTS → MOSS TTS → gTTS → OpenAI TTS → ElevenLabs**

| Cause | Solution |
|-------|----------|

### `voice-worker-gemini` answers in English on a Hebrew bot

**Symptom:** The 3CX bot answers, but the voice sounds like the wrong language even though the bot text is Hebrew.

**Cause:** Deepgram Aura does not provide a Hebrew TTS voice. If the worker does not have Google Cloud TTS credentials mounted, the older fallback could speak Hebrew text with an English voice.

**Fix:** Mount the Google service-account file into the active worker container and recreate it.

```yaml
voice-worker-gemini:
  volumes:
    - ./voice-worker/google-tts-sa.json:/app/google-tts-sa.json:ro
  environment:
    - GOOGLE_CLOUD_TTS_KEY_PATH=/app/google-tts-sa.json
```

Then rebuild and recreate:

```bash
docker compose build voice-worker-gemini
docker compose up -d --force-recreate voice-worker-gemini
```

Expected result:
- Hebrew bot calls use Google `he-IL-Wavenet-*` voices
- If the Google key is missing, Hebrew TTS now fails closed instead of falling back to an English Deepgram voice

### Web dialer vs browser-call

There are two separate web test paths in `voice-worker`:

- The dialer buttons call `POST /call` and place a real outbound SIP call through 3CX.
- The browser-call panel uses `/api/browser-call` WebSocket audio and does not place a SIP call through 3CX.

If the browser-call panel works but the dialer does not, inspect:

```bash
docker logs voice-worker-gemini --tail 200
docker logs drachtio --tail 200
```

Look for:
- outbound `407` then authenticated `INVITE`
- `180 Ringing`
- `200 OK`
- `Outbound media connection established`
| Google Cloud key missing | Set `GOOGLE_CLOUD_KEY` in `.env` and force-recreate container |
| MOSS TTS too slow (ARM) | Set `MOSS_TTS_URL=` (empty) to skip it — gTTS takes ~500 ms |
| ElevenLabs quota exhausted | Add credits, or rely on free gTTS fallback |
| OpenAI billing exhausted | Add credits, or rely on gTTS fallback |

### Calls disconnect after a few seconds

**Symptom:** Call connects, maybe plays greeting, then drops.

**Causes:**
- FreeSWITCH timeout (check logs)
- SIP session timeout
- Network instability

```bash
# Check FreeSWITCH logs for clues
claude-phone logs freeswitch | tail -100
```

## Split Deployment Issues

### Pi can't reach API server

**Symptom:** Voice services start but calls fail with connection errors.

**Diagnostics:**
```bash
# On the Pi, test connectivity:
curl http://<api-server-ip>:3333/health

# Check configured API URL:
claude-phone config show | grep claudeApiUrl
```

**Solutions:**
1. Verify API server IP is correct in Pi's config
2. Ensure API server is running: `claude-phone api-server`
3. Check firewall allows port 3333
4. Verify both machines are on same network (or have routing)

### API server won't start

**Symptom:** `claude-phone api-server` fails immediately.

**Solutions:**
1. Check port 3333 isn't already in use:
   ```bash
   lsof -i :3333
   ```

2. Verify Claude Code CLI works:
   ```bash
   claude --version
   ```

3. Check for Node.js errors in output

## Getting Logs

### Voice App Logs
```bash
claude-phone logs voice-app
# or
docker compose logs -f voice-app
```

### SIP Server Logs
```bash
claude-phone logs drachtio
# or
docker compose logs -f drachtio
```

### Media Server Logs
```bash
claude-phone logs freeswitch
# or
docker compose logs -f freeswitch
```

### API Server Logs
```bash
# If running in foreground, check terminal output
# If running via start command, check:
cat ~/.claude-phone/api-server.log
```

## ARM64 / Cloud VPS Deployment

### No audio on Oracle Cloud (or any cloud NAT)

**Symptom:** Calls connect, bot speaks, but you can't be heard (STT never triggers).

**Root cause:** Cloud instances have a public IP that is **not bound to any network interface** — the
private IP is what drachtio and FreeSWITCH see. Setting `EXTERNAL_IP` to the public IP causes SDP
to advertise an unreachable address for RTP.

**Fix:**
```bash
# Use the private LAN IP, not the public IP
EXTERNAL_IP=10.0.0.4   # whatever "ip addr show" reports
```

### `expectSession TIMEOUT` in logs

**Symptom:** The audio fork WebSocket never connects; each call attempt times out.

**Cause:** TTS generation took too long (e.g. MOSS TTS > 15 s) so FreeSWITCH hung up before the
conversation loop started.

**Fix:** Disable slow TTS providers for ARM deployments:
```bash
MOSS_TTS_URL=   # leave empty — gTTS (~500 ms) is used instead
```

### Google Cloud env vars not picked up after `.env` update

**Symptom:** `docker exec voice-app printenv GOOGLE_CLOUD_KEY` returns nothing even though the key
is in `.env`.

**Cause:** `docker compose restart` does **not** re-read `env_file`. A full container recreation is needed.

**Fix:**
```bash
docker compose up -d --force-recreate voice-app
```

### FLAC missing (Google Web Speech STT fails)

**Symptom:** Logs show `FLAC conversion utility not available`.

**Cause:** The `SpeechRecognition` Python library requires the `flac` CLI to convert WAV → FLAC
before sending audio to Google's free speech endpoint.

**Fix:** Rebuild the voice-app Docker image (flac is already included in the current Dockerfile):
```bash
docker compose build voice-app && docker compose up -d voice-app
```

## Still Stuck?

1. **Check the video tutorial:** [youtu.be/cT22fTzotYc](https://youtu.be/cT22fTzotYc) covers common setup issues
2. **Run full diagnostics:** `claude-phone doctor`
3. **Open an issue:** [github.com/shaike1/openclaw-3cx/issues](https://github.com/shaike1/openclaw-3cx/issues)

When opening an issue, include:
- Output of `claude-phone doctor`
- Output of `claude-phone status`
- Relevant log snippets (redact any API keys!)
- Your deployment type (All-in-one or Split)
- Platform (macOS, Linux, Raspberry Pi)

### 403 on outbound INVITE

**Symptom:** Outbound API call fails in ~1 second with `Sip non-success response: 403`.

**Fix checklist:**
1. `SIP_AUTH_ID` and `SIP_AUTH_USERNAME` must equal the selected device `authId` in `voice-app/config/devices.json`.
2. `SIP_AUTH_PASSWORD` must match that device password.
3. `DEFAULT_CALLER_ID` must be the extension number (e.g. `12611`).
4. Recreate the container after env changes:

```bash
docker compose up -d --force-recreate voice-app
```

**Quick validation:**
```bash
curl -sS -X POST http://127.0.0.1:3000/api/outbound-call \
  -H "Content-Type: application/json" \
  -d {to:12610,message:hello}

# Then check for ringing in logs
docker logs --since 20s voice-app | grep -E "Phone is ringing|Sip non-success response"
```
