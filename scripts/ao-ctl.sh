#!/usr/bin/env bash
# ao-ctl.sh — Control the Agent Orchestrator daemon
# Usage: ./scripts/ao-ctl.sh [start|stop|restart|status|logs|url]

set -euo pipefail

PLIST="com.proximityparks.ao-daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST.plist"
PID_DIR="$HOME/.ao-sessions/pids"
LOG_DIR="$HOME/.ao-sessions/logs"

case "${1:-status}" in
  start)
    echo "Starting Agent Orchestrator daemon..."
    launchctl load "$PLIST_PATH" 2>/dev/null || true
    launchctl start "$PLIST"
    echo "✅ Started. Run './scripts/ao-ctl.sh status' to check."
    ;;

  stop)
    echo "Stopping Agent Orchestrator daemon..."
    launchctl stop "$PLIST" 2>/dev/null || true
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    # Clean up stale PIDs
    rm -f "$PID_DIR/dashboard.pid" "$PID_DIR/cloudflared.pid"
    echo "✅ Stopped."
    ;;

  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;

  status)
    echo "══════════════════════════════════════"
    echo "  Agent Orchestrator Status"
    echo "══════════════════════════════════════"

    # LaunchAgent
    if launchctl list "$PLIST" >/dev/null 2>&1; then
      echo "  LaunchAgent:  ✅ loaded"
    else
      echo "  LaunchAgent:  ❌ not loaded"
    fi

    # Dashboard
    if [[ -f "$PID_DIR/dashboard.pid" ]] && kill -0 "$(cat "$PID_DIR/dashboard.pid")" 2>/dev/null; then
      echo "  Dashboard:    ✅ running (PID $(cat "$PID_DIR/dashboard.pid"))"
    else
      echo "  Dashboard:    ❌ not running"
    fi

    # Tunnel
    if [[ -f "$PID_DIR/cloudflared.pid" ]] && kill -0 "$(cat "$PID_DIR/cloudflared.pid")" 2>/dev/null; then
      echo "  Tunnel:       ✅ running (PID $(cat "$PID_DIR/cloudflared.pid"))"
    else
      echo "  Tunnel:       ❌ not running"
    fi

    # URL
    if [[ -f "$PID_DIR/tunnel-url.txt" ]]; then
      echo "  Tunnel URL:   $(cat "$PID_DIR/tunnel-url.txt")"
      echo "  Webhook URL:  $(cat "$PID_DIR/tunnel-url.txt")/api/webhooks/linear"
    else
      echo "  Tunnel URL:   (not available)"
    fi

    # Port
    if lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  Port 3000:    ✅ listening"
    else
      echo "  Port 3000:    ❌ not listening"
    fi

    echo "══════════════════════════════════════"
    ;;

  logs)
    target="${2:-all}"
    case "$target" in
      tunnel)    tail -f "$LOG_DIR/cloudflared.log" ;;
      dashboard) tail -f "$LOG_DIR/dashboard.log" ;;
      daemon)    tail -f "$LOG_DIR/ao-daemon-stdout.log" ;;
      errors)    tail -f "$LOG_DIR/ao-daemon-stderr.log" ;;
      *)         tail -f "$LOG_DIR/ao-daemon-stdout.log" "$LOG_DIR/cloudflared.log" ;;
    esac
    ;;

  url)
    if [[ -f "$PID_DIR/tunnel-url.txt" ]]; then
      cat "$PID_DIR/tunnel-url.txt"
    else
      echo "No tunnel URL available. Is the daemon running?"
      exit 1
    fi
    ;;

  *)
    echo "Usage: ao-ctl [start|stop|restart|status|logs|url]"
    echo ""
    echo "  start    - Start the daemon (dashboard + tunnel + webhook)"
    echo "  stop     - Stop everything"
    echo "  restart  - Stop and start"
    echo "  status   - Show component status"
    echo "  logs     - Tail logs [all|tunnel|dashboard|daemon|errors]"
    echo "  url      - Print current tunnel URL"
    exit 1
    ;;
esac
