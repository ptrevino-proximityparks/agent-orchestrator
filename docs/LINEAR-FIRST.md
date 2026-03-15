# Linear-First Mode

> Use Linear as the single source of truth for issue tracking with Agent Orchestrator.

## Overview

Linear-first mode transforms Agent Orchestrator from a GitHub-centric system to one where **Linear is the source of truth** for all issue tracking. This enables:

- **Bidirectional sync**: Agent progress automatically updates Linear issues
- **Auto-spawn**: Move an issue to "Todo" in Linear → agent starts automatically
- **Centralized tracking**: All work visible in Linear, not scattered across GitHub
- **Team visibility**: Non-technical stakeholders see progress in Linear

## Quick Start

### 1. Generate Configuration

```bash
# Auto-generate Linear-first config
ao init --auto --tracker linear

# Or manually add to existing config
```

### 2. Set Environment Variables

```bash
# Required: Linear API key
export LINEAR_API_KEY="lin_api_xxxxx"

# Optional: For webhook auto-spawn
export LINEAR_WEBHOOK_SECRET="your-webhook-secret"
```

### 3. Start the Orchestrator

```bash
ao start
```

### 4. Spawn an Agent

```bash
# Spawn agent for a Linear issue
ao spawn my-project INT-123
```

## Configuration

### Global Linear Settings

Add to your `agent-orchestrator.yaml`:

```yaml
linear:
  # Webhook processing (for auto-spawn)
  webhooks:
    enabled: true
    path: /webhooks/linear

  # Map events to Linear status names
  statusMapping:
    agent-spawned: In Progress
    pr-created: In Review
    pr-merged: Done

  # Automatic comments on Linear issues
  comments:
    enabled: true
    prefix: "🤖"

  # Auto-spawn on status change
  autoSpawn:
    enabled: true
    triggerStatus: Todo  # or ["Todo", "Ready"]
```

### Project Configuration

```yaml
projects:
  my-app:
    repo: org/my-app
    path: ~/my-app

    tracker:
      plugin: linear
      # teamKey is auto-detected from issue ID (INT-123 → INT)
      # Or specify explicitly:
      teamKey: INT
```

## Features

### Automatic Status Updates

The orchestrator updates Linear issue status automatically:

| Event | Linear Status |
|-------|--------------|
| Agent spawned | In Progress |
| PR created | In Review |
| PR merged | Done |

Customize the status names in `linear.statusMapping`.

### Automatic Comments

Progress is posted to Linear issues:

```
🤖 Agent spawned (2024-01-15 10:30:00)
Session `myapp-INT-123-abc` started working on this issue.

🤖 Pull Request created (2024-01-15 11:45:00)
**Fix authentication bug**
[View PR](https://github.com/org/repo/pull/42)

🤖 PR Merged (2024-01-15 14:20:00)
Work completed successfully.
```

### Auto-Spawn (Webhooks)

When enabled, moving an issue to "Todo" in Linear automatically spawns an agent:

```
Linear: Issue moved to "Todo"
    ↓
Webhook → Orchestrator
    ↓
Agent spawned for issue
    ↓
Linear: Status → "In Progress"
```

#### Setting Up Webhooks

1. Go to Linear Settings → API → Webhooks
2. Create a new webhook:
   - **URL**: `https://your-domain/api/webhooks/linear`
   - **Events**: Issue updates
3. Copy the signing secret
4. Set `LINEAR_WEBHOOK_SECRET` in your environment

### Sub-Issue Support

For complex tasks, create sub-issues in Linear. The orchestrator:

- Fetches parent/child relationships
- Provides full context to agents
- Can spawn agents for sub-issues independently

## Workflow Example

### 1. Create Issue in Linear

Create an issue in your Linear team (e.g., `INT-456: Add user authentication`).

### 2. Move to Todo (Auto-Spawn)

Move the issue to "Todo" status. If webhooks are configured, an agent spawns automatically.

Or spawn manually:
```bash
ao spawn my-project INT-456
```

### 3. Agent Works

The agent:
- Reads issue context from Linear
- Creates a branch and implements the feature
- Creates a PR referencing the Linear issue

### 4. Status Updates

Linear issue automatically updates:
- "In Progress" → when agent starts
- "In Review" → when PR is created
- "Done" → when PR is merged

### 5. Team Visibility

Your team sees all progress in Linear without checking GitHub.

## API Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | Yes | Linear API key |
| `LINEAR_WEBHOOK_SECRET` | No | Webhook signing secret |

### Configuration Options

#### `linear.webhooks`

```yaml
webhooks:
  enabled: true          # Enable webhook processing
  path: /webhooks/linear # Webhook endpoint path
```

#### `linear.statusMapping`

```yaml
statusMapping:
  agent-spawned: In Progress  # Status when agent starts
  pr-created: In Review       # Status when PR is opened
  pr-merged: Done             # Status when PR is merged
```

#### `linear.comments`

```yaml
comments:
  enabled: true  # Post comments to Linear
  prefix: "🤖"   # Comment prefix for bot messages
```

#### `linear.autoSpawn`

```yaml
autoSpawn:
  enabled: true           # Enable auto-spawn
  triggerStatus: Todo     # Status(es) that trigger spawn
  # triggerStatus: ["Todo", "Ready"]  # Multiple statuses
```

### Tracker Plugin Options

```yaml
tracker:
  plugin: linear
  teamKey: INT            # Team key (auto-detected from issue ID)

  # Override global settings per-project
  autoSpawn:
    enabled: false        # Disable auto-spawn for this project
```

## Loop Prevention

The orchestrator prevents infinite loops:

1. **Bot comments detected**: Comments starting with 🤖 or [bot] are ignored
2. **API user detection**: Comments from the API key owner are skipped
3. **Duplicate session check**: Won't spawn if active session exists for issue

## Troubleshooting

### Agent not updating Linear

1. Check `LINEAR_API_KEY` is set correctly
2. Verify the API key has write permissions
3. Check orchestrator logs for errors

### Webhooks not triggering

1. Verify webhook URL is accessible
2. Check `LINEAR_WEBHOOK_SECRET` matches
3. Confirm webhook is enabled in Linear settings
4. Check orchestrator logs for signature validation errors

### Status not mapping correctly

1. Verify status names match your Linear workflow exactly
2. Status names are case-sensitive
3. Check `linear.statusMapping` configuration

### Auto-spawn not working

1. Confirm `autoSpawn.enabled: true`
2. Verify `triggerStatus` matches your Linear status name
3. Check webhooks are configured and working
4. Ensure no active session exists for the issue

## Migration from GitHub Issues

To migrate from GitHub-centric to Linear-first:

1. **Update tracker config**:
   ```yaml
   tracker:
     plugin: linear  # was: github
   ```

2. **Add global Linear config**:
   ```yaml
   linear:
     statusMapping:
       agent-spawned: In Progress
       # ...
   ```

3. **Update spawn commands**:
   ```bash
   # Before: ao spawn my-project 123
   # After:  ao spawn my-project INT-123
   ```

4. **Set environment variables**:
   ```bash
   export LINEAR_API_KEY="lin_api_xxxxx"
   ```

## See Also

- [Configuration Reference](./SETUP.md)
- [Example Config](../examples/linear-first.yaml)
- [Agent Template](../templates/CLAUDE.md.template)
- [Linear API Documentation](https://developers.linear.app/)
