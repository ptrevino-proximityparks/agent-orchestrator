# Provider Configuration

Agent Orchestrator supports multiple AI providers for running Claude Code agents. Each project can be configured to use a different provider.

## Anthropic (Default)

Uses the Anthropic API directly. Requires an active Claude subscription.

### Configuration

```yaml
# agent-orchestrator.yaml
projects:
  my-project:
    repo: org/my-repo
    path: ~/my-project
    # No provider config needed — uses ANTHROPIC_API_KEY from environment
```

Or explicitly:

```yaml
projects:
  my-project:
    repo: org/my-repo
    path: ~/my-project
    provider:
      type: anthropic
      model: sonnet  # sonnet | opus | haiku
```

### Requirements

- `ANTHROPIC_API_KEY` environment variable set
- Active Anthropic API subscription

### Models

| Model | Best For |
|-------|----------|
| `sonnet` | Default, good balance of speed and quality |
| `opus` | Complex tasks requiring deeper reasoning |
| `haiku` | Fast iterations, simple tasks |

---

## Ollama (Local)

Run local models without API costs. Perfect for development, experimentation, or when you want to keep everything on your machine.

### Configuration

```yaml
projects:
  my-project:
    repo: org/my-repo
    path: ~/my-project
    provider:
      type: ollama
      model: qwen3:8b              # Any installed Ollama model
      endpoint: http://localhost:11434  # Optional, this is the default
```

### Requirements

1. Ollama installed: See [Ollama Setup Guide](ollama-setup.md)
2. Model downloaded: `ollama pull qwen3:8b`
3. Ollama running: `ollama serve`

### Recommended Models

| Model | RAM Required | Use Case |
|-------|--------------|----------|
| `qwen3:8b` | 8GB | Best balance of quality and speed |
| `qwen2.5-coder:7b` | 8GB | Optimized for code tasks |
| `devstral:latest` | 16GB | Maximum quality (Mistral AI) |
| `codellama:13b` | 16GB | Meta's code-focused model |

### How It Works

Claude Code natively supports Ollama via environment variables. When you configure a project with `provider.type: ollama`, the orchestrator automatically sets:

```bash
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=""
ANTHROPIC_BASE_URL=http://localhost:11434
```

The agent then runs with the specified model:

```bash
claude --model qwen3:8b
```

---

## Mixed Provider Usage

You can use different providers for different projects:

```yaml
projects:
  # Production project — use Anthropic for best quality
  production-app:
    repo: org/production-app
    path: ~/production-app
    provider:
      type: anthropic
      model: opus

  # Experimental project — use local Ollama
  experiment:
    repo: org/experiment
    path: ~/experiment
    provider:
      type: ollama
      model: qwen3:8b
```

This is useful for:
- **Cost optimization**: Use Ollama for development, Anthropic for production
- **Offline work**: Local models work without internet
- **Experimentation**: Try different models without API costs

---

## Dashboard Provider Toggle

The web dashboard shows a provider toggle when spawning sessions. This allows you to:

1. Override the project's default provider for a specific session
2. Quickly switch between Anthropic and Ollama
3. See which provider each active session is using

The toggle respects your project configuration — if a project is configured for Ollama only, that's what it will use.

---

## Troubleshooting

### "ANTHROPIC_API_KEY is required for Anthropic provider"

Set your API key:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or add to your shell profile (`~/.zshrc`, `~/.bashrc`).

### "Ollama not responding"

1. Check if Ollama is running: `pgrep ollama`
2. Start it: `ollama serve`
3. Verify the endpoint: `curl http://localhost:11434/api/tags`

See [Ollama Setup Guide](ollama-setup.md) for detailed troubleshooting.

### "Model not found"

Download the model first:
```bash
ollama pull qwen3:8b
ollama list  # Verify it's installed
```

---

## See Also

- [Ollama Setup Guide](ollama-setup.md) — Installation and configuration
- [Configuration Reference](../agent-orchestrator.yaml.example) — Full config example
