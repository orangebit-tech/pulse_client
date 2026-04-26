#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[refresh] Docker Compose is required but was not found." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "[refresh] Missing .env in $SCRIPT_DIR" >&2
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq 'pulse-client'; then
  echo "[refresh] Removing existing pulse-client container only..."
  docker rm -f pulse-client >/dev/null
else
  echo "[refresh] No existing pulse-client container found."
fi

echo "[refresh] Building pulse-client image..."
"${COMPOSE[@]}" build --pull pulse-client

echo "[refresh] Starting pulse-client container..."
"${COMPOSE[@]}" up -d --no-deps pulse-client

echo "[refresh] Current container:"
docker ps --filter "name=^/pulse-client$" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

PID_MODE="$(docker inspect pulse-client --format '{{.HostConfig.PidMode}}')"
if [[ "$PID_MODE" != "host" ]]; then
  echo "[refresh] WARNING: pulse-client PidMode is '$PID_MODE', expected 'host'. Host process metrics may not work." >&2
else
  echo "[refresh] PidMode: host"
fi
