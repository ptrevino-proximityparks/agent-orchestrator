#!/usr/bin/env bash
# ao-daemon.sh — Starts dashboard + cloudflare tunnel + auto-registers Linear webhook
# Usage: ./scripts/ao-daemon.sh [project]
# Designed to run as LaunchAgent or manually.

set -euo pipefail

PROJECT="${1:-ao}"
PORT="${AO_PORT:-3000}"
LINEAR_TEAM_ID="${LINEAR_TEAM_ID:-d74813c3-16ef-4b18-9a66-ebf976ea4ce4}"
WEBHOOK_LABEL="ao-orchestrator"
LOG_DIR="$HOME/.ao-sessions/logs"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"
DASHBOARD_LOG="$LOG_DIR/dashboard.log"
PID_DIR="$HOME/.ao-sessions/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo "[ao-daemon] $(date '+%H:%M:%S') $*"; }

cleanup() {
  log "Shutting down..."
  # Kill cloudflared
  if [[ -f "$PID_DIR/cloudflared.pid" ]]; then
    kill "$(cat "$PID_DIR/cloudflared.pid")" 2>/dev/null || true
    rm -f "$PID_DIR/cloudflared.pid"
  fi
  # Kill dashboard (ao start child process)
  if [[ -f "$PID_DIR/dashboard.pid" ]]; then
    kill "$(cat "$PID_DIR/dashboard.pid")" 2>/dev/null || true
    rm -f "$PID_DIR/dashboard.pid"
  fi
  # Delete webhook from Linear
  if [[ -n "${WEBHOOK_ID:-}" ]]; then
    log "Removing Linear webhook $WEBHOOK_ID..."
    delete_linear_webhook "$WEBHOOK_ID" || true
  fi
  log "Stopped."
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# ---------------------------------------------------------------------------
# Linear API helpers (direct GraphQL)
# ---------------------------------------------------------------------------

linear_gql() {
  local query="$1"
  curl -s -X POST https://api.linear.app/graphql \
    -H "Content-Type: application/json" \
    -H "Authorization: $LINEAR_API_KEY" \
    -d "$query"
}

list_linear_webhooks() {
  linear_gql '{"query":"{ webhooks { nodes { id url label enabled } } }"}'
}

create_linear_webhook() {
  local url="$1"
  local secret="${LINEAR_WEBHOOK_SECRET:-}"

  python3 -c "
import json, urllib.request
query = 'mutation CreateWebhook(\$input: WebhookCreateInput!) { webhookCreate(input: \$input) { success webhook { id url enabled } } }'
inp = {'url': '$url', 'resourceTypes': ['Issue', 'Comment'], 'label': '$WEBHOOK_LABEL', 'enabled': True, 'teamId': '$LINEAR_TEAM_ID'}
secret = '$secret'
if secret:
    inp['secret'] = secret
data = json.dumps({'query': query, 'variables': {'input': inp}}).encode()
req = urllib.request.Request('https://api.linear.app/graphql', data=data,
    headers={'Content-Type': 'application/json', 'Authorization': '$LINEAR_API_KEY'})
resp = urllib.request.urlopen(req)
print(resp.read().decode())
"
}

delete_linear_webhook() {
  local webhook_id="$1"

  python3 -c "
import json, urllib.request
query = 'mutation DeleteWebhook(\$id: String!) { webhookDelete(id: \$id) { success } }'
data = json.dumps({'query': query, 'variables': {'id': '$webhook_id'}}).encode()
req = urllib.request.Request('https://api.linear.app/graphql', data=data,
    headers={'Content-Type': 'application/json', 'Authorization': '$LINEAR_API_KEY'})
resp = urllib.request.urlopen(req)
print(resp.read().decode())
"
}

# ---------------------------------------------------------------------------
# Step 1: Clean up any existing ao-orchestrator webhooks
# ---------------------------------------------------------------------------

rotate_webhook() {
  local tunnel_url="$1"
  local webhook_url="${tunnel_url}/api/webhooks/linear"

  log "Checking existing Linear webhooks..."
  local existing
  existing=$(list_linear_webhooks)

  # Find and delete existing ao-orchestrator webhooks
  local old_ids
  old_ids=$(echo "$existing" | python3 -c "
import sys, json
data = json.load(sys.stdin)
nodes = data.get('data', {}).get('webhooks', {}).get('nodes', [])
for n in nodes:
    if n.get('label') == '$WEBHOOK_LABEL':
        print(n['id'])
" 2>/dev/null || true)

  if [[ -n "$old_ids" ]]; then
    while IFS= read -r wid; do
      log "Deleting old webhook: $wid"
      delete_linear_webhook "$wid" >/dev/null
    done <<< "$old_ids"
  fi

  # Create new webhook
  log "Creating webhook → $webhook_url"
  local result
  result=$(create_linear_webhook "$webhook_url")

  WEBHOOK_ID=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
wh = data.get('data', {}).get('webhookCreate', {}).get('webhook', {})
print(wh.get('id', ''))
" 2>/dev/null || true)

  if [[ -n "$WEBHOOK_ID" ]]; then
    log "✅ Webhook registered: $WEBHOOK_ID"
    log "   URL: $webhook_url"
  else
    log "❌ Failed to create webhook. Response: $result"
  fi
}

# ---------------------------------------------------------------------------
# Step 2: Start dashboard
# ---------------------------------------------------------------------------

log "Starting dashboard on port $PORT..."
cd "$(dirname "$0")/.."

# Source environment
source "$HOME/.zshrc" 2>/dev/null || true

# Start ao (dashboard + orchestrator) in background
ao start "$PROJECT" > "$DASHBOARD_LOG" 2>&1 &
DASHBOARD_PID=$!
echo "$DASHBOARD_PID" > "$PID_DIR/dashboard.pid"
log "Dashboard PID: $DASHBOARD_PID"

# Wait for port to be ready
log "Waiting for port $PORT..."
for i in $(seq 1 60); do
  if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    log "Port $PORT ready after ${i}s"
    break
  fi
  if ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
    log "❌ Dashboard exited unexpectedly. Check $DASHBOARD_LOG"
    exit 1
  fi
  sleep 1
done

if ! lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log "❌ Port $PORT not ready after 60s. Check $DASHBOARD_LOG"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 3: Start Cloudflare tunnel
# ---------------------------------------------------------------------------

log "Starting Cloudflare tunnel..."
cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$PID_DIR/cloudflared.pid"
log "Cloudflared PID: $TUNNEL_PID"

# Wait for tunnel URL
log "Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -aoE 'https://[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
  if [[ -n "$TUNNEL_URL" ]]; then
    log "✅ Tunnel ready: $TUNNEL_URL"
    break
  fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  log "❌ Tunnel URL not found after 30s. Check $TUNNEL_LOG"
  exit 1
fi

# Save URL for reference
echo "$TUNNEL_URL" > "$PID_DIR/tunnel-url.txt"

# ---------------------------------------------------------------------------
# Step 4: Register webhook in Linear
# ---------------------------------------------------------------------------

rotate_webhook "$TUNNEL_URL"

# ---------------------------------------------------------------------------
# Step 5: Keep alive + health check
# ---------------------------------------------------------------------------

log "══════════════════════════════════════════════"
log "  Agent Orchestrator running"
log "  Dashboard:  http://localhost:$PORT"
log "  Tunnel:     $TUNNEL_URL"
log "  Webhook:    $TUNNEL_URL/api/webhooks/linear"
log "  Project:    $PROJECT"
log "══════════════════════════════════════════════"
log "Press Ctrl+C to stop."

# Health check loop
while true; do
  sleep 60

  # Check dashboard
  if ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
    log "⚠️ Dashboard died. Restarting..."
    ao start "$PROJECT" > "$DASHBOARD_LOG" 2>&1 &
    DASHBOARD_PID=$!
    echo "$DASHBOARD_PID" > "$PID_DIR/dashboard.pid"
  fi

  # Check tunnel
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    log "⚠️ Tunnel died. Restarting..."
    cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    echo "$TUNNEL_PID" > "$PID_DIR/cloudflared.pid"

    # Wait for new URL
    sleep 5
    NEW_URL=$(grep -aoE 'https://[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
    if [[ -n "$NEW_URL" && "$NEW_URL" != "$TUNNEL_URL" ]]; then
      TUNNEL_URL="$NEW_URL"
      echo "$TUNNEL_URL" > "$PID_DIR/tunnel-url.txt"
      log "New tunnel URL: $TUNNEL_URL"
      rotate_webhook "$TUNNEL_URL"
    fi
  fi
done
