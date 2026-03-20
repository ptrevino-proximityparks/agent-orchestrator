# Ollama Setup Guide

This guide covers installing and configuring Ollama for use with Agent Orchestrator.

## Quick Install

### macOS

```bash
# Using Homebrew (recommended)
brew install ollama

# Start the Ollama server
ollama serve
```

Or download from [ollama.com/download](https://ollama.com/download).

### Linux

```bash
# One-line installer
curl -fsSL https://ollama.com/install.sh | sh

# Start the server
ollama serve
```

### Windows (WSL2)

```bash
# Inside WSL2
curl -fsSL https://ollama.com/install.sh | sh
ollama serve
```

---

## Download Models

After installing, download at least one model:

```bash
# Recommended — good balance of quality and speed
ollama pull qwen3:8b

# Code-optimized alternative
ollama pull qwen2.5-coder:7b

# High quality (requires 16GB+ RAM)
ollama pull devstral:latest
```

### Model Recommendations

| Model | Size | RAM | Best For |
|-------|------|-----|----------|
| `qwen3:8b` | 5GB | 8GB | General coding tasks |
| `qwen2.5-coder:7b` | 4GB | 8GB | Code generation and review |
| `codellama:7b` | 4GB | 8GB | Code completion |
| `devstral:latest` | 8GB | 16GB | Complex reasoning |
| `codellama:13b` | 7GB | 16GB | Larger context, better quality |

See the full [Ollama Model Library](https://ollama.com/library) for more options.

---

## Verify Installation

Run the verification script:

```bash
./scripts/check-ollama.sh
```

Or manually:

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# List installed models
ollama list

# Test a model
ollama run qwen3:8b "Write hello world in TypeScript"
```

---

## Test with Claude Code

Before using with Agent Orchestrator, verify Claude Code works with Ollama:

```bash
export ANTHROPIC_AUTH_TOKEN=ollama
export ANTHROPIC_API_KEY=""
export ANTHROPIC_BASE_URL=http://localhost:11434

claude --model qwen3:8b "Write a function that adds two numbers"
```

If this works, Agent Orchestrator will work too.

---

## Running as a Service

### macOS (launchd)

Ollama installed via Homebrew runs automatically. To manage it:

```bash
# Check status
brew services list | grep ollama

# Start
brew services start ollama

# Stop
brew services stop ollama

# Restart
brew services restart ollama
```

### Linux (systemd)

The installer creates a systemd service:

```bash
# Check status
systemctl status ollama

# Start
sudo systemctl start ollama

# Enable on boot
sudo systemctl enable ollama

# View logs
journalctl -u ollama -f
```

---

## Configuration

Ollama uses sensible defaults, but you can customize:

### Environment Variables

```bash
# Custom model storage location
export OLLAMA_MODELS=/path/to/models

# Custom host/port
export OLLAMA_HOST=0.0.0.0:11434

# GPU layers (for GPU acceleration)
export OLLAMA_NUM_GPU=999
```

### GPU Acceleration

Ollama automatically uses GPU if available:

- **NVIDIA**: Requires CUDA drivers
- **Apple Silicon**: Uses Metal automatically
- **AMD**: Requires ROCm (Linux only)

Check GPU usage:
```bash
# NVIDIA
nvidia-smi

# Apple Silicon — check Activity Monitor
```

---

## Troubleshooting

### "Ollama not responding"

```bash
# Check if running
pgrep ollama

# If not running, start it
ollama serve

# Check if port is in use
lsof -i :11434
```

### "Model not found"

```bash
# List available models
ollama list

# Pull the model
ollama pull qwen3:8b
```

### "Out of memory"

- Use a smaller model (7b instead of 13b)
- Close other applications
- Check RAM usage: `htop` or Activity Monitor

### Slow response times

- Ensure GPU acceleration is working
- Use a smaller model
- Check system resource usage
- Increase `OLLAMA_NUM_GPU` for more GPU layers

### Model downloads stuck

```bash
# Cancel and retry
# Press Ctrl+C, then:
ollama pull qwen3:8b --insecure  # Skip TLS verification
```

---

## Updating Ollama

### macOS

```bash
brew upgrade ollama
brew services restart ollama
```

### Linux

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl restart ollama
```

---

## Resources

- [Ollama Documentation](https://ollama.com)
- [Ollama GitHub](https://github.com/ollama/ollama)
- [Model Library](https://ollama.com/library)
- [Claude Code + Ollama Integration](https://docs.ollama.com/integrations/claude-code)

---

## See Also

- [Provider Configuration](providers.md) — Configure projects to use Ollama
- [agent-orchestrator.yaml.example](../agent-orchestrator.yaml.example) — Full config reference
