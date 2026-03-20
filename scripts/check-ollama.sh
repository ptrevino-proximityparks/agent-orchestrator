#!/bin/bash
# check-ollama.sh — Verify Ollama is ready for Agent Orchestrator
#
# Usage:
#   ./scripts/check-ollama.sh
#   ./scripts/check-ollama.sh --quiet  # Exit code only

set -e

QUIET=false
if [[ "$1" == "--quiet" ]] || [[ "$1" == "-q" ]]; then
  QUIET=true
fi

log() {
  if [[ "$QUIET" == false ]]; then
    echo "$1"
  fi
}

error() {
  echo "❌ $1" >&2
}

# Check if Ollama is installed
if ! command -v ollama &> /dev/null; then
  error "Ollama is not installed"
  log ""
  log "Install with:"
  log "  macOS:  brew install ollama"
  log "  Linux:  curl -fsSL https://ollama.com/install.sh | sh"
  exit 1
fi

log "✅ Ollama installed: $(ollama --version 2>/dev/null || echo 'unknown version')"

# Check if Ollama server is running
OLLAMA_ENDPOINT="${OLLAMA_HOST:-http://localhost:11434}"

if ! curl -s "${OLLAMA_ENDPOINT}/api/tags" > /dev/null 2>&1; then
  error "Ollama server is not running"
  log ""
  log "Start with:"
  log "  ollama serve"
  log ""
  log "Or as a service:"
  log "  macOS:  brew services start ollama"
  log "  Linux:  sudo systemctl start ollama"
  exit 1
fi

log "✅ Ollama server running at ${OLLAMA_ENDPOINT}"

# Check for installed models
MODELS=$(curl -s "${OLLAMA_ENDPOINT}/api/tags" | jq -r '.models[].name' 2>/dev/null || echo "")

if [[ -z "$MODELS" ]]; then
  error "No models installed"
  log ""
  log "Install a model with:"
  log "  ollama pull qwen3:8b"
  exit 1
fi

log ""
log "📦 Installed models:"
echo "$MODELS" | while read -r model; do
  log "   - $model"
done

# Check for recommended models
RECOMMENDED=("qwen3:8b" "qwen2.5-coder:7b" "devstral:latest" "codellama:7b")
HAS_RECOMMENDED=false

for rec in "${RECOMMENDED[@]}"; do
  if echo "$MODELS" | grep -q "^${rec}$"; then
    HAS_RECOMMENDED=true
    break
  fi
done

if [[ "$HAS_RECOMMENDED" == false ]]; then
  log ""
  log "⚠️  No recommended model found. Consider installing:"
  log "   ollama pull qwen3:8b"
fi

log ""
log "✅ Ollama is ready for Agent Orchestrator"

# Quick test if not quiet
if [[ "$QUIET" == false ]]; then
  log ""
  log "💡 Test with Claude Code:"
  log "   export ANTHROPIC_AUTH_TOKEN=ollama"
  log "   export ANTHROPIC_API_KEY=\"\""
  log "   export ANTHROPIC_BASE_URL=${OLLAMA_ENDPOINT}"
  log "   claude --model qwen3:8b \"Hello\""
fi

exit 0
