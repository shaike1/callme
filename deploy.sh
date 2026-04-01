#!/usr/bin/env bash
# ============================================================
# CallMe Bot — full deployment script
# Usage: ./deploy.sh [--build] [--restart-all]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load env
if [ -f .env ]; then
  set -a; source .env; set +a
fi

BUILD=${1:-}

echo "=== CallMe Bot Deployment ==="
echo "Working dir: $SCRIPT_DIR"

# ── Build voice-worker Docker image ─────────────────────────
if [[ "$BUILD" == "--build" || "$BUILD" == "--restart-all" ]]; then
  echo "[1/4] Building voice-worker-gemini image..."
  docker build -t voice-worker-gemini ./voice-worker
else
  echo "[1/4] Skipping build (pass --build to rebuild image)"
fi

# ── Stop existing voice-worker container if running ─────────
echo "[2/4] Stopping existing voice-worker-gemini container..."
docker rm -f voice-worker-gemini 2>/dev/null || true

# ── Start voice-worker-gemini ────────────────────────────────
echo "[3/4] Starting voice-worker-gemini..."
docker run -d \
  --name voice-worker-gemini \
  --network host \
  --restart unless-stopped \
  -v /tmp/voice-worker-audio:/tmp/voice-worker-audio \
  --env-file "$SCRIPT_DIR/.env" \
  voice-worker-gemini

# ── Optional: start drachtio + FreeSWITCH via docker-compose ─
if [[ "$BUILD" == "--restart-all" ]]; then
  echo "[4/4] Restarting drachtio + FreeSWITCH..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d
else
  echo "[4/4] Skipping drachtio/FreeSWITCH restart (pass --restart-all to restart everything)"
fi

echo ""
echo "=== Deployment complete ==="
docker ps --filter name=voice-worker-gemini --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "Dashboard: https://callme.right-api.com"
echo "Health:    curl http://127.0.0.1:3101/health"
