#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5173}"
URL="http://${HOST}:${PORT}"

if ! command -v ruby >/dev/null 2>&1; then
  echo "Ruby was not found on PATH."
  echo "Install Ruby and try again (macOS usually ships with Ruby)."
  echo ""
  read -r "?Press Enter to close..."
  exit 1
fi

if command -v curl >/dev/null 2>&1 && curl -fsS "$URL" >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
  exit 0
fi

echo "Starting mobilithek-to-csv helper server at $URL"
HOST="$HOST" PORT="$PORT" ruby server.rb &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill -INT "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup INT TERM EXIT

if command -v curl >/dev/null 2>&1; then
  for _ in {1..80}; do
    if curl -fsS "$URL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

open "$URL" >/dev/null 2>&1 || true

wait "$SERVER_PID"
