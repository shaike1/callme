# CallMe Bot Skill for OpenClaw/Claude Code

This repository already ships the CallMe Bot MCP helper that exposes the voice worker (`POST /call`, `/api/tts`, `/api/status`, `/api/calls`) as Claude Code tools. The zipped artifact below is ready to drop into any OpenClaw/Claude environment when you want the same skill packaged as a standalone binary.

## Artifact
- `callme-mcp.zip` — contains the MCP server (`callme-mcp/server.js` and `package.json`). Unzip it, run `npm install`, and start it with a Node 18+ runtime beside your Claude/OpenClaw agent.

## Configuration
1. Place the server next to your MCP runner and install dependencies:
   ```bash
   unzip callme-mcp.zip -d /opt/callme-mcp
   cd /opt/callme-mcp
   npm install
   ```
2. Set the CallMe Bot connection info (any `.env` file, systemd unit, or shell):
   ```bash
   export CALLME_URL=http://127.0.0.1:3101
   export CALLME_USER=admin
   export CALLME_PASS=the-dashboard-password
   ```
3. Launch the MCP helper:
   ```bash
   npm start
   ```

## MCP tooling
`callme-mcp/server.js` defines the following tools that proxy to the voice worker:
- `callme_dial(target, from?)` → HTTP `POST /call`
- `callme_hangup(callId)` → HTTP `DELETE /call/:callId`
- `callme_calls()` → HTTP `GET /api/calls`
- `callme_speak(text, voice?, language?)` → HTTP `POST /api/tts`
- `callme_notify(text)` → `callme_speak` with Hebrew defaults
- `callme_status()` → `GET /api/status`

These tools return their result text via the MCP response, so your Claude Code agent can `tools/call` any of the above without knowing the CallMe Bot HTTP layout.

## Claude/OpenClaw integration
Add this entry into your `.mcp.json` to bring up the skill automatically:
```json
{
  "command": "node",
  "args": ["/opt/callme-mcp/server.js"]
}
```
Make sure the MCP host has network access to the voice-worker service (default `http://127.0.0.1:3101`). Once `callme_mcp` registers, your Claude skill can use `callme_dial` to invoke the same `POST /call` flow we verified earlier.

## OpenClaw usage notes
- The bot has already been exercised via the web dialer/call path; the skill simply proxies to that same URL so costs, tracing, and SIP registration stay centralized.
- Keep the Google TTS key mounted and the `.env` values (especially `CALLME_PASS`) in sync with the voice worker so calls remain authenticated.
- Watch the `CallMe Bot` logs for the usual `GroqPipeline session ready` / `Bot said …` posts after the MCP tool executes.
