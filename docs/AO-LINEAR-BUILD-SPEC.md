# AO-LINEAR: Agent Orchestrator Fork — Build Specification for Claude Code

> **This document is the single source of truth for Claude Code.**
> Read it completely before writing any code. Every task is self-contained.
> Do NOT use Linear, the AO dashboard, or any external tool during the build.
> You are transforming an existing open-source repository into a Linear-first fork.

---

## TABLE OF CONTENTS

1. [Project Overview](#1-project-overview)
2. [Upstream Repository Analysis](#2-upstream-repository-analysis)
3. [Target Architecture](#3-target-architecture)
4. [Environment Setup](#4-environment-setup)
5. [Build Phases and Tasks](#5-build-phases-and-tasks)
6. [CLAUDE.md Template for Future Projects](#6-claudemd-template-for-future-projects)
7. [YAML Configuration Schema](#7-yaml-configuration-schema)
8. [Linear API Reference](#8-linear-api-reference)
9. [Linear Workspace Reference Data](#9-linear-workspace-reference-data)
10. [Testing Strategy](#10-testing-strategy)
11. [Conventions and Rules](#11-conventions-and-rules)

---

## 1. PROJECT OVERVIEW

### What we're building

A fork of `ComposioHQ/agent-orchestrator` (https://github.com/ComposioHQ/agent-orchestrator) that transforms the system from a GitHub-centric orchestrator with a web dashboard into a **Linear-centric orchestrator** where:

- **Linear is the single source of truth** — all issue tracking, progress reporting, task decomposition, and status management happens in Linear, not in the AO dashboard.
- **Agents write back to Linear** — every agent spawned by the orchestrator posts comments, creates sub-issues, updates statuses, and links PRs directly to Linear issues.
- **Webhooks enable bidirectional flow** — Linear notifies AO when issues change status (triggering auto-spawn), and AO notifies Linear of every lifecycle event (CI results, PR status, agent progress).
- **The web dashboard becomes optional** — it still works for debugging, but the daily workflow lives entirely in Linear.

### What we're NOT building

- We are NOT building a new orchestrator from scratch. We are extending an existing, tested system (40K lines of TypeScript, 3,288 test cases).
- We are NOT modifying the core orchestration logic (spawn, worktree, tmux, reactions). We are extending the tracker plugin and adding a reporter module.
- We are NOT using this system to build itself. This is a manual Claude Code session transforming the repo.

### Repository name

`ao-linear` — forked from `ComposioHQ/agent-orchestrator`

### Owner

Pedro Treviño (ptrevino@proximityparks.com)

---

## 2. UPSTREAM REPOSITORY ANALYSIS

### Repo structure

The upstream is a **pnpm monorepo** with this structure:

```
agent-orchestrator/
├── packages/
│   ├── core/                    # Core orchestration logic
│   │   └── src/
│   │       ├── types.ts         # ALL plugin interfaces defined here
│   │       ├── orchestrator.ts  # Main orchestrator class
│   │       ├── config.ts        # YAML config parser
│   │       └── events.ts        # Internal event bus
│   ├── cli/                     # CLI tool (ao command)
│   │   └── src/
│   │       ├── commands/        # spawn, status, session, init, etc.
│   │       └── index.ts
│   ├── dashboard/               # Web dashboard (React + Express backend)
│   │   └── src/
│   │       ├── server/          # Express server
│   │       └── client/          # React frontend
│   └── plugins/
│       ├── agent-claude-code/   # Claude Code agent plugin
│       ├── agent-codex/         # Codex agent plugin
│       ├── agent-aider/         # Aider agent plugin
│       ├── runtime-tmux/        # tmux runtime plugin
│       ├── runtime-docker/      # Docker runtime plugin
│       ├── workspace-worktree/  # git worktree workspace plugin
│       ├── tracker-github/      # GitHub Issues tracker plugin
│       ├── tracker-linear/      # Linear tracker plugin ← THIS IS OUR FOCUS
│       ├── scm-github/          # GitHub SCM plugin
│       ├── notifier-desktop/    # Desktop notification plugin
│       ├── notifier-slack/      # Slack notification plugin
│       └── terminal-iterm2/     # iTerm2 terminal plugin
├── examples/                    # Example YAML configs
│   ├── simple-github.yaml
│   ├── linear-project.yaml      # May already exist
│   └── multi-project.yaml
├── scripts/
│   └── setup.sh                 # Installation script
├── CLAUDE.md                    # Code conventions for agents
├── ARCHITECTURE.md              # Architecture documentation
├── SETUP.md                     # Setup guide
├── agent-orchestrator.yaml      # Default config
├── agent-orchestrator.yaml.example
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── tsconfig.base.json
```

### Key technical facts

- **Language:** TypeScript throughout
- **Package manager:** pnpm with workspaces
- **Build:** `pnpm build` compiles all packages
- **Tests:** `pnpm test` runs 3,288+ test cases
- **CLI:** After `npm link -g packages/cli`, the `ao` command is available globally
- **Plugin pattern:** Each plugin implements a TypeScript interface from `packages/core/src/types.ts` and exports a `PluginModule`
- **Event system:** The orchestrator has an internal event bus for lifecycle events (session:spawned, ci:passed, ci:failed, review:changes-requested, etc.)
- **Config:** YAML-based (`agent-orchestrator.yaml`), parsed by `packages/core/src/config.ts`

### The Tracker interface (critical — read this first)

The file `packages/core/src/types.ts` defines the Tracker interface. Before writing any code, you MUST read this file and understand:

1. What methods the Tracker interface requires
2. Which methods `packages/plugins/tracker-linear/` already implements
3. Which methods are stubbed or missing

The Tracker interface likely includes methods like:
- `getIssue(id: string)` — fetch issue details
- `updateIssue(id: string, data: object)` — update issue fields
- `createComment(issueId: string, body: string)` — post a comment
- `getComments(issueId: string)` — list comments
- `createIssue(data: object)` — create new issue (for sub-issues)

**Your first task is to audit this — do not assume the interface shape above is accurate. Read the actual code.**

### The reactions system

Reactions are configured in `agent-orchestrator.yaml` and handled by the orchestrator core. When events happen (CI failure, review comment, PR approved), the orchestrator:

1. Emits an event on the internal event bus
2. Checks the reactions config for what to do
3. Executes the configured action (send-to-agent, notify, etc.)

We need to hook into this event bus to also report these events to Linear.

---

## 3. TARGET ARCHITECTURE

### Data flow after our modifications

```
Pedro
  │
  │ (creates issues via Claude.ai MCP / Linear UI — AFTER build is complete)
  │
  ▼
LINEAR ◄─────────────────────────────────────────────┐
  │                                                    │
  │ Webhooks (issue status changed)                    │ API calls (comments,
  │                                                    │ status updates,
  ▼                                                    │ sub-issues)
AGENT ORCHESTRATOR (ao)                                │
  │                                                    │
  ├── Webhook Receiver (/webhooks/linear)              │
  │     └── Validates signature                        │
  │     └── Parses event → internal event bus          │
  │                                                    │
  ├── Linear Reporter (NEW)                            │
  │     └── Subscribes to ALL orchestrator events      │
  │     └── Posts comments to Linear ──────────────────┘
  │     └── Updates issue statuses
  │     └── Creates sub-issues when agents decompose
  │
  ├── Orchestrator Core (UNCHANGED)
  │     └── spawn, monitor, react, lifecycle
  │
  └── Agents (Claude Code in tmux worktrees)
        └── Each agent has CLAUDE.md with Linear directives
        └── Agents also write to Linear via Linear MCP/API
```

### New components to build

| Component | Location | Purpose |
|-----------|----------|---------|
| Enhanced Linear tracker plugin | `packages/plugins/tracker-linear/` | Full CRUD: comments, sub-issues, status transitions |
| Linear Reporter module | `packages/core/src/linear-reporter.ts` | Event bus → Linear mapping |
| Webhook receiver | `packages/dashboard/src/server/webhooks/` | HTTP endpoint for Linear webhooks |
| Auto-spawn handler | `packages/core/src/auto-spawn.ts` | Webhook → spawn trigger |
| CLAUDE.md template | `templates/CLAUDE.md.template` | Standard agent behavior for Linear integration |
| Enhanced YAML schema | `packages/core/src/config.ts` (extend) | New `linear:` config section |
| Enhanced `ao init` | `packages/cli/src/commands/init.ts` (extend) | `--tracker linear` flag |

### Components we do NOT modify

- `packages/core/src/orchestrator.ts` — core logic stays the same
- `packages/plugins/agent-claude-code/` — agent plugin untouched
- `packages/plugins/runtime-tmux/` — runtime untouched
- `packages/plugins/workspace-worktree/` — workspace untouched
- `packages/plugins/scm-github/` — SCM untouched
- `packages/dashboard/src/client/` — React frontend (optional, not our focus)

---

## 4. ENVIRONMENT SETUP

### Prerequisites

Before starting any code work, verify:

```bash
# Node.js 20+
node --version   # Must be >= 20.0.0

# pnpm
pnpm --version   # Any recent version

# git 2.25+
git --version    # Must be >= 2.25

# tmux
tmux -V

# GitHub CLI (authenticated)
gh auth status
```

### Initial setup sequence

```bash
# 1. Fork the repo on GitHub first (do this manually in the browser)
#    Fork ComposioHQ/agent-orchestrator to your GitHub org/account

# 2. Clone YOUR fork (not the upstream)
git clone https://github.com/YOUR_ORG/agent-orchestrator.git ao-linear
cd ao-linear

# 3. Add upstream remote for future syncing
git remote add upstream https://github.com/ComposioHQ/agent-orchestrator.git

# 4. Create the working branch
git checkout -b feature/linear-first

# 5. Install dependencies
pnpm install

# 6. Build all packages
pnpm build

# 7. Run tests to verify baseline
pnpm test

# 8. Link CLI globally
npm link -g packages/cli

# 9. Verify
ao --version
ao doctor
```

### Environment variables needed

Create a `.env` file in the repo root (already in .gitignore):

```bash
# Required for Linear API calls during development/testing
LINEAR_API_KEY=lin_api_...

# Required for agents (not needed during build, but set it up now)
ANTHROPIC_API_KEY=sk-ant-...

# Required for GitHub operations
GITHUB_TOKEN=ghp_...

# Required for webhook signature verification
LINEAR_WEBHOOK_SECRET=whsec_...
```

---

## 5. BUILD PHASES AND TASKS

### Execution rules for Claude Code

- Execute tasks IN ORDER. Each task builds on the previous.
- After every task: run `pnpm build` and then `pnpm test`.
- If tests fail after your changes, fix them before moving to the next task.
- Commit after each completed task with message format: `feat(linear): [task description]`
- Read the upstream CLAUDE.md for code style conventions BEFORE writing any code.
- When a task says "read file X", actually read it — don't assume its contents.

---

### PHASE 1: AUDIT AND UNDERSTAND

#### Task 1.1: Read and document the Tracker interface

**What to do:**
1. Read `packages/core/src/types.ts` — find the `Tracker` interface
2. Read `packages/plugins/tracker-github/src/index.ts` — understand the reference implementation
3. Read `packages/plugins/tracker-linear/src/index.ts` — understand current Linear implementation
4. Read `packages/core/src/events.ts` (or equivalent) — understand the event bus

**Output:**
Create a file `docs/LINEAR-AUDIT.md` with:
- The full Tracker interface definition (copy it)
- For each method: whether tracker-linear implements it, stubs it, or is missing it
- List of all events emitted by the orchestrator event bus
- Assessment of what's missing for our goals

**Why this matters:**
Every subsequent task depends on understanding what exists. If you skip this and assume, you'll build the wrong thing.

**Acceptance criteria:**
- [ ] `docs/LINEAR-AUDIT.md` exists with complete interface analysis
- [ ] All Tracker methods documented with implementation status
- [ ] Event bus events listed
- [ ] No code changes — this is read-only analysis
- [ ] Committed: `docs(linear): audit tracker interface and event bus`

---

#### Task 1.2: Read and document the reactions system

**What to do:**
1. Find where reactions are configured and handled in the codebase
2. Trace the flow: YAML config → event → handler → action
3. Understand how `send-to-agent` works (how does the orchestrator send a message to an active tmux session?)
4. Understand how `notify` works

**Output:**
Append to `docs/LINEAR-AUDIT.md`:
- Reactions flow diagram (text-based)
- File paths for reaction handling code
- How to hook into the reaction pipeline to add Linear reporting

**Acceptance criteria:**
- [ ] Reactions system fully documented
- [ ] Clear path identified for where to add Linear reporting hooks
- [ ] No code changes
- [ ] Committed: `docs(linear): document reactions system`

---

### PHASE 2: ENHANCE THE LINEAR TRACKER PLUGIN

#### Task 2.1: Implement comment posting

**What to do:**
1. Open `packages/plugins/tracker-linear/src/index.ts`
2. Find or add the `createComment` method
3. Implement it using the Linear GraphQL API

**Implementation details:**

```typescript
async createComment(issueId: string, body: string): Promise<{ id: string }> {
  // Use the Linear GraphQL API
  // Endpoint: https://api.linear.app/graphql
  // Auth: Bearer token from process.env.LINEAR_API_KEY
  //
  // Mutation:
  // mutation CommentCreate($input: CommentCreateInput!) {
  //   commentCreate(input: $input) {
  //     success
  //     comment { id body createdAt }
  //   }
  // }
  //
  // Variables: { input: { issueId, body } }
  //
  // The body supports full markdown.
  // Wrap the call in try/catch — if Linear API fails, log the error
  // but do NOT throw. The orchestrator must not crash because of
  // a Linear API failure.
}
```

**If the Linear SDK (@linear/sdk) is already a dependency**, use it instead of raw GraphQL. Check `packages/plugins/tracker-linear/package.json`. The SDK provides:
```typescript
import { LinearClient } from '@linear/sdk';
const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
await client.createComment({ issueId, body });
```

**Acceptance criteria:**
- [ ] `createComment` method exists and is functional
- [ ] Handles API errors gracefully (log + continue, don't crash)
- [ ] Supports full markdown in body
- [ ] Unit test: mock the Linear API, verify correct payload
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] Committed: `feat(linear): implement comment posting in tracker plugin`

---

#### Task 2.2: Implement sub-issue creation

**What to do:**
1. Add a `createSubIssue` method to the Linear tracker plugin
2. This creates a new Linear issue with a `parentId` linking it to the parent

**Implementation details:**

```typescript
async createSubIssue(params: {
  parentId: string;       // Linear issue ID of the parent
  title: string;
  description: string;
  teamId: string;
  labelIds?: string[];
  projectId?: string;
  priority?: number;      // 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low
}): Promise<{ id: string; identifier: string; url: string }> {
  // Use issueCreate mutation with parentId field
  //
  // mutation IssueCreate($input: IssueCreateInput!) {
  //   issueCreate(input: $input) {
  //     success
  //     issue { id identifier title url }
  //   }
  // }
  //
  // Input: {
  //   teamId: params.teamId,
  //   title: params.title,
  //   description: params.description,
  //   parentId: params.parentId,
  //   stateId: <backlog status ID>,  // Default to Backlog
  //   labelIds: params.labelIds,
  //   projectId: params.projectId,
  //   priority: params.priority ?? 0
  // }
  //
  // Return the created issue's id, identifier (e.g., PP-45), and URL.
}
```

**Acceptance criteria:**
- [ ] `createSubIssue` method exists and is functional
- [ ] Created issues appear nested under the parent in Linear
- [ ] Default status is Backlog
- [ ] Labels are applied if provided
- [ ] Returns { id, identifier, url }
- [ ] Graceful error handling
- [ ] Unit test with mocked API
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): implement sub-issue creation`

---

#### Task 2.3: Implement status transitions

**What to do:**
1. Add `updateIssueStatus` method
2. Define a TypeScript enum/map for status transitions

**Implementation details:**

```typescript
// Define orchestrator events → Linear status mapping
const STATUS_MAP: Record<string, string> = {
  'agent-spawned': 'In Progress',
  'pr-created': 'In Review',
  'pr-merged': 'Done',
  'agent-failed': 'Todo',     // So it can be retried
  'agent-blocked': 'In Review' // With a blocker comment
};

async updateIssueStatus(issueId: string, statusName: string): Promise<void> {
  // First, resolve statusName to a status ID
  // Query the team's workflow states:
  //
  // query WorkflowStates($teamId: String!) {
  //   team(id: $teamId) {
  //     states { nodes { id name type } }
  //   }
  // }
  //
  // Find the state where name matches statusName
  // Then update the issue:
  //
  // mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  //   issueUpdate(id: $id, input: $input) {
  //     success
  //     issue { id state { id name } }
  //   }
  // }
  //
  // Cache the status name→ID mapping after first resolution.
  // Don't query the API every time.
}
```

**Acceptance criteria:**
- [ ] `updateIssueStatus` method works with status names (not IDs)
- [ ] Status ID resolution is cached after first call
- [ ] Invalid status names are logged, not thrown
- [ ] Status map is configurable (will be moved to YAML config in Phase 5)
- [ ] Unit tests for each transition
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): implement status transitions with caching`

---

#### Task 2.4: Implement issue fetching enhancements

**What to do:**
1. Verify `getIssue` returns full issue data including: title, description, status, labels, parent, sub-issues, comments
2. If incomplete, enhance it

**The orchestrator needs rich issue context when spawning agents.** When `ao spawn project PP-45` is called, the agent should receive:
- Full issue description
- All comments (for additional context/instructions)
- Sub-issue list (to know what's already been decomposed)
- Labels (to understand category/priority)

**Acceptance criteria:**
- [ ] `getIssue` returns comprehensive data
- [ ] Returns sub-issues if they exist
- [ ] Returns comments
- [ ] Returns labels and status
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): enhance issue fetching with full context`

---

### PHASE 3: LINEAR REPORTER MODULE

#### Task 3.1: Create the LinearReporter class

**What to do:**
1. Create `packages/core/src/linear-reporter.ts`
2. This class subscribes to the orchestrator's event bus and posts updates to Linear

**Implementation details:**

```typescript
// packages/core/src/linear-reporter.ts

import { EventEmitter } from 'events'; // or whatever the orchestrator uses
// Import the tracker plugin type

interface LinearReporterConfig {
  enabled: boolean;
  includeMetadata: boolean;
  commentPrefix: string; // e.g., "🤖"
  statusMapping: Record<string, string>;
}

export class LinearReporter {
  private tracker: LinearTracker; // The enhanced tracker plugin
  private config: LinearReporterConfig;

  constructor(tracker: LinearTracker, config: LinearReporterConfig) {
    this.tracker = tracker;
    this.config = config;
  }

  /**
   * Subscribe to the orchestrator's event bus.
   * Call this once during orchestrator startup.
   */
  attach(eventBus: EventEmitter): void {
    eventBus.on('session:spawned', (data) => this.onSessionSpawned(data));
    eventBus.on('session:completed', (data) => this.onSessionCompleted(data));
    eventBus.on('session:failed', (data) => this.onSessionFailed(data));
    eventBus.on('ci:passed', (data) => this.onCIPassed(data));
    eventBus.on('ci:failed', (data) => this.onCIFailed(data));
    eventBus.on('review:changes-requested', (data) => this.onChangesRequested(data));
    eventBus.on('review:approved', (data) => this.onApproved(data));
    eventBus.on('pr:created', (data) => this.onPRCreated(data));
    eventBus.on('pr:merged', (data) => this.onPRMerged(data));
  }

  private async onSessionSpawned(data: { issueId: string; sessionId: string }) {
    if (!this.config.enabled) return;

    await this.tracker.createComment(data.issueId,
      `${this.config.commentPrefix} **Agent spawned**\n\n` +
      `Session: \`${data.sessionId}\`\n` +
      `Time: ${new Date().toISOString()}\n\n` +
      `Agent is reading the issue and starting work.\n\n` +
      `---\n*Automated by Agent Orchestrator*`
    );

    await this.tracker.updateIssueStatus(
      data.issueId,
      this.config.statusMapping['agent-spawned'] || 'In Progress'
    );
  }

  private async onCIFailed(data: { issueId: string; sessionId: string; logs: string }) {
    if (!this.config.enabled) return;

    // Truncate logs to avoid huge comments
    const truncatedLogs = data.logs?.substring(0, 500) || 'No logs available';

    await this.tracker.createComment(data.issueId,
      `${this.config.commentPrefix} **CI failed**\n\n` +
      `Session: \`${data.sessionId}\`\n\n` +
      `\`\`\`\n${truncatedLogs}\n\`\`\`\n\n` +
      `Agent is retrying automatically.\n\n` +
      `---\n*Automated by Agent Orchestrator*`
    );
  }

  private async onPRCreated(data: { issueId: string; prUrl: string; prTitle: string }) {
    if (!this.config.enabled) return;

    await this.tracker.createComment(data.issueId,
      `${this.config.commentPrefix} **PR created**\n\n` +
      `[${data.prTitle}](${data.prUrl})\n\n` +
      `---\n*Automated by Agent Orchestrator*`
    );

    await this.tracker.updateIssueStatus(
      data.issueId,
      this.config.statusMapping['pr-created'] || 'In Review'
    );
  }

  private async onPRMerged(data: { issueId: string; prUrl: string }) {
    if (!this.config.enabled) return;

    await this.tracker.createComment(data.issueId,
      `${this.config.commentPrefix} **PR merged — issue complete**\n\n` +
      `[View PR](${data.prUrl})\n\n` +
      `---\n*Automated by Agent Orchestrator*`
    );

    await this.tracker.updateIssueStatus(
      data.issueId,
      this.config.statusMapping['pr-merged'] || 'Done'
    );
  }

  // Implement the remaining event handlers following the same pattern:
  // onSessionCompleted, onSessionFailed, onCIPassed, onChangesRequested, onApproved
  // Each one: posts a comment + optionally updates status
}
```

**IMPORTANT: Match the actual event names from the event bus.** The event names above (`session:spawned`, `ci:failed`, etc.) are guesses based on the architecture. You MUST read the actual event names from your Task 1.2 audit and use those.

**Acceptance criteria:**
- [ ] `linear-reporter.ts` exists in `packages/core/src/`
- [ ] Subscribes to ALL relevant orchestrator lifecycle events
- [ ] Posts formatted markdown comments for each event
- [ ] Updates issue status at the right moments
- [ ] Does NOT crash if Linear API is unreachable
- [ ] Deduplication: does not post duplicate comments for the same event
- [ ] Unit tests with mocked tracker and event bus
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): create LinearReporter event-to-comment module`

---

#### Task 3.2: Integrate LinearReporter into orchestrator startup

**What to do:**
1. Find where the orchestrator initializes (likely `packages/core/src/orchestrator.ts` or the main entry point)
2. After the tracker plugin is loaded, instantiate LinearReporter and attach it to the event bus
3. Only instantiate if the tracker is Linear (don't break GitHub tracker users)

**Implementation details:**

```typescript
// In the orchestrator initialization sequence:

if (config.defaults.tracker === 'linear') {
  const linearReporter = new LinearReporter(tracker, {
    enabled: config.linear?.comments?.enabled ?? true,
    includeMetadata: config.linear?.comments?.includeMetadata ?? true,
    commentPrefix: config.linear?.comments?.prefix ?? '🤖',
    statusMapping: config.linear?.statusMapping ?? {
      'agent-spawned': 'In Progress',
      'pr-created': 'In Review',
      'pr-merged': 'Done',
      'agent-failed': 'Todo',
      'agent-blocked': 'In Review'
    }
  });
  linearReporter.attach(eventBus);
}
```

**Acceptance criteria:**
- [ ] LinearReporter is instantiated when tracker is Linear
- [ ] NOT instantiated for GitHub tracker (backward compatible)
- [ ] Configuration flows from YAML through to LinearReporter
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): integrate LinearReporter into orchestrator startup`

---

### PHASE 4: WEBHOOK RECEIVER

#### Task 4.1: Add webhook endpoint

**What to do:**
1. Find the Express server in `packages/dashboard/src/server/`
2. Add a new route: `POST /webhooks/linear`
3. Implement Linear webhook signature verification
4. Parse the webhook payload and emit events on the orchestrator's event bus

**Implementation details:**

```typescript
// packages/dashboard/src/server/webhooks/linear.ts

import { Router, Request, Response } from 'express';
import crypto from 'crypto';

export function createLinearWebhookRouter(eventBus: EventEmitter): Router {
  const router = Router();

  router.post('/webhooks/linear', express.raw({ type: 'application/json' }), (req: Request, res: Response) => {
    // 1. Verify signature
    const signature = req.headers['linear-signature'] as string;
    const secret = process.env.LINEAR_WEBHOOK_SECRET;

    if (secret && signature) {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(req.body)
        .digest('hex');

      if (signature !== expectedSignature) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // 2. Parse payload
    const payload = JSON.parse(req.body.toString());
    // payload structure:
    // {
    //   action: "create" | "update" | "remove",
    //   type: "Issue" | "Comment" | "IssueLabel",
    //   data: { id, title, state, ... },
    //   updatedFrom: { state: { name: "Backlog" } },  // previous values
    //   url: "https://linear.app/...",
    //   createdAt: "2026-03-14T..."
    // }

    // 3. Emit internal events
    if (payload.type === 'Issue' && payload.action === 'update') {
      const newState = payload.data?.state?.name;
      const oldState = payload.updatedFrom?.state?.name;

      if (newState && newState !== oldState) {
        eventBus.emit('linear:issue-status-changed', {
          issueId: payload.data.id,
          issueIdentifier: payload.data.identifier,
          issueTitle: payload.data.title,
          fromStatus: oldState,
          toStatus: newState,
          url: payload.url
        });
      }
    }

    if (payload.type === 'Comment' && payload.action === 'create') {
      // Check if the comment is from a human (not from our bot)
      // to avoid infinite loops
      const isBot = payload.data?.body?.includes('Automated by Agent Orchestrator');
      if (!isBot) {
        eventBus.emit('linear:comment-added', {
          issueId: payload.data.issueId,
          commentBody: payload.data.body,
          authorName: payload.data.user?.name
        });
      }
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
```

**CRITICAL: Avoid infinite loops.** When LinearReporter posts a comment, Linear sends a webhook for that comment. The webhook handler must detect and ignore bot-generated comments. The check above (`includes('Automated by Agent Orchestrator')`) is the simplest approach. A more robust approach is to track which comments the reporter has posted and ignore webhooks for those IDs.

**Acceptance criteria:**
- [ ] `POST /webhooks/linear` endpoint exists
- [ ] Signature verification works (returns 401 for invalid)
- [ ] Status change events are emitted correctly
- [ ] Comment events are emitted (only human comments, not bot)
- [ ] Infinite loop prevention is in place
- [ ] Unit tests with mock webhook payloads
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): add webhook receiver endpoint`

---

#### Task 4.2: Implement auto-spawn from webhook

**What to do:**
1. Create `packages/core/src/auto-spawn.ts`
2. Listen for `linear:issue-status-changed` events
3. When an issue moves to the configured trigger status (default: "Todo"), auto-spawn an agent

**Implementation details:**

```typescript
// packages/core/src/auto-spawn.ts

export class AutoSpawnHandler {
  private orchestrator: Orchestrator; // reference to spawn method
  private config: AutoSpawnConfig;
  private activeIssues: Set<string> = new Set(); // prevent duplicates

  constructor(orchestrator: Orchestrator, config: AutoSpawnConfig) {
    this.orchestrator = orchestrator;
    this.config = config;
  }

  attach(eventBus: EventEmitter): void {
    if (!this.config.enabled) return;

    eventBus.on('linear:issue-status-changed', async (data) => {
      if (data.toStatus !== this.config.triggerStatus) return;
      if (this.activeIssues.has(data.issueId)) return; // already active

      try {
        // Determine which project this issue belongs to
        const project = this.resolveProject(data);
        if (!project) {
          console.warn(`No project mapping for issue ${data.issueIdentifier}`);
          return;
        }

        this.activeIssues.add(data.issueId);
        await this.orchestrator.spawn(project.name, data.issueIdentifier);
      } catch (error) {
        this.activeIssues.delete(data.issueId);
        console.error(`Auto-spawn failed for ${data.issueIdentifier}:`, error);
      }
    });
  }

  private resolveProject(data: { issueIdentifier: string }): ProjectConfig | null {
    // Match issue to project based on YAML config
    // The config maps Linear team/project to AO project names
    // This needs the enhanced YAML config from Phase 5
    // For now, use a simple lookup
    return null; // TODO: implement after YAML config is enhanced
  }
}
```

**Note:** This task creates the handler structure. Full project resolution depends on the enhanced YAML config (Task 5.1). For now, implement the handler with a TODO for `resolveProject`. The handler should work end-to-end once the config is in place.

**Acceptance criteria:**
- [ ] `auto-spawn.ts` exists
- [ ] Listens for status change events
- [ ] Prevents duplicate spawns for the same issue
- [ ] Skeleton for project resolution (TODO is acceptable here)
- [ ] Unit tests for the event handling logic
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): implement auto-spawn handler from webhook events`

---

### PHASE 5: CONFIGURATION AND CLI

#### Task 5.1: Extend YAML configuration schema

**What to do:**
1. Open `packages/core/src/config.ts`
2. Add TypeScript types for the new `linear:` section
3. Add parsing logic for the new fields
4. Add validation (warn if LINEAR_API_KEY is missing when tracker is linear)

**The new YAML structure:**

```yaml
# These fields are NEW — add to the config parser
linear:
  webhooks:
    enabled: true
    path: /webhooks/linear        # route path
    secret: ${LINEAR_WEBHOOK_SECRET}  # env var reference
  
  statusMapping:
    agent-spawned: In Progress
    pr-created: In Review
    pr-merged: Done
    agent-failed: Todo
    agent-blocked: In Review
  
  comments:
    enabled: true
    includeMetadata: true
    prefix: "🤖"
  
  autoSpawn:
    enabled: true
    triggerStatus: Todo           # which status triggers spawn

# Project-level Linear config
projects:
  my-project:
    repo: owner/repo
    path: ~/projects/repo
    defaultBranch: main
    linear:                       # NEW nested config
      team: ProximityParks        # Linear team name
      project: MY-PROJECT         # Linear project name (optional)
```

**Acceptance criteria:**
- [ ] TypeScript types defined for all new config fields
- [ ] Config parser handles the new `linear:` section
- [ ] Default values are sensible (comments.enabled: true, etc.)
- [ ] Environment variable substitution works for `${LINEAR_WEBHOOK_SECRET}`
- [ ] Validation warns if `LINEAR_API_KEY` is not set when tracker is linear
- [ ] Existing configs without `linear:` section still parse correctly (backward compatible)
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): extend YAML config schema for Linear-first mode`

---

#### Task 5.2: Wire auto-spawn project resolution

**What to do:**
1. Go back to `packages/core/src/auto-spawn.ts`
2. Implement `resolveProject()` using the new YAML config
3. Match Linear issue identifiers to configured projects

**Implementation details:**

The issue identifier (e.g., "PP-45") contains the team prefix. The config maps projects to Linear teams. So:
1. Extract the team prefix from the identifier
2. Find the project whose `linear.team` matches that prefix
3. If multiple projects share the same team, use `linear.project` to disambiguate

**Acceptance criteria:**
- [ ] `resolveProject` works with the enhanced config
- [ ] Handles ambiguous mappings gracefully
- [ ] Full integration test: webhook event → auto-spawn trigger
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): wire auto-spawn project resolution with YAML config`

---

#### Task 5.3: Enhance `ao init` for Linear projects

**What to do:**
1. Open `packages/cli/src/commands/init.ts`
2. Add `--tracker linear` flag
3. When this flag is set, generate the YAML config with the `linear:` section pre-filled
4. Copy the CLAUDE.md template (from Task 6.1) into the project directory
5. Check for `LINEAR_API_KEY` in environment and warn if missing

**Acceptance criteria:**
- [ ] `ao init --tracker linear` produces correct YAML config
- [ ] CLAUDE.md template is copied and customized
- [ ] Warning if LINEAR_API_KEY is not set
- [ ] Default config uses Linear as tracker
- [ ] `pnpm build` && `pnpm test` pass
- [ ] Committed: `feat(linear): enhance ao init with --tracker linear flag`

---

### PHASE 6: TEMPLATES AND DOCUMENTATION

#### Task 6.1: Create CLAUDE.md template for Linear-integrated projects

**What to do:**
Create `templates/CLAUDE.md.template` — this is the file that gets copied into every project that uses `ao init --tracker linear`. It tells agents how to behave.

**The complete template is in Section 6 below. Create the file with that exact content.**

**Acceptance criteria:**
- [ ] `templates/CLAUDE.md.template` exists with full content from Section 6
- [ ] Placeholder markers (`{{PROJECT_NAME}}`, `{{TECH_STACK}}`, etc.) are used for project-specific content
- [ ] Linear integration directives are clear and actionable
- [ ] Committed: `feat(linear): create CLAUDE.md template for Linear-integrated projects`

---

#### Task 6.2: Create example configuration

**What to do:**
1. Create `examples/linear-first.yaml` — a complete example config for Linear-first mode
2. Update `examples/README.md` (if it exists) to document this example

**The complete example is in Section 7 below.**

**Acceptance criteria:**
- [ ] `examples/linear-first.yaml` exists with full content
- [ ] Documented in examples README or inline comments
- [ ] Committed: `feat(linear): add Linear-first example configuration`

---

#### Task 6.3: Update project documentation

**What to do:**
1. Update `README.md` — add a section about Linear-first mode
2. Update `SETUP.md` — add Linear setup instructions
3. Create `docs/LINEAR-FIRST.md` — comprehensive guide for Linear-first usage

**Acceptance criteria:**
- [ ] README mentions Linear-first mode
- [ ] SETUP.md has Linear setup steps
- [ ] `docs/LINEAR-FIRST.md` is a complete user guide
- [ ] Committed: `docs(linear): update documentation for Linear-first mode`

---

### PHASE 7: INTEGRATION TESTING

#### Task 7.1: Create integration test suite

**What to do:**
1. Create `tests/integration/linear/` directory
2. Write integration tests that verify the full loop with mocked Linear API

**Tests to write:**

```
test-linear-comment.ts       — createComment posts correct payload
test-linear-subissue.ts      — createSubIssue creates with parentId
test-linear-status.ts        — updateIssueStatus resolves names to IDs
test-linear-reporter.ts      — events trigger correct comments + status updates
test-linear-webhook.ts       — webhook endpoint validates signature + emits events
test-linear-autospawn.ts     — status change webhook triggers spawn
test-linear-dedup.ts         — duplicate spawns are prevented
test-linear-loop.ts          — bot comments don't trigger infinite loops
test-linear-full-lifecycle.ts — spawn → work → PR → CI → review → merge → done
```

**All tests should use mocked HTTP responses.** Do NOT call the real Linear API in tests.

**Acceptance criteria:**
- [ ] All test files exist
- [ ] Tests cover the full lifecycle
- [ ] Tests use mocks (no real API calls)
- [ ] `pnpm test` passes with all new tests
- [ ] Committed: `test(linear): add integration test suite for Linear-first mode`

---

## 6. CLAUDE.md TEMPLATE FOR FUTURE PROJECTS

This is the content for `templates/CLAUDE.md.template`. Create this file exactly as written in Task 6.1.

```markdown
# {{PROJECT_NAME}} — Agent Development Guide

## Project Context

**Repository:** {{REPO_URL}}
**Tech stack:** {{TECH_STACK}}
**Default branch:** {{DEFAULT_BRANCH}}

## Code Conventions

{{CODE_CONVENTIONS}}

## Linear Integration

You have access to Linear via the MCP server or the Linear API. You MUST use it actively throughout your work. Linear is the single source of truth — the human supervising you reads Linear, not your terminal.

### On Starting Work

When you begin working on an issue, post a comment on it:

```
**Starting work**

Reviewed the issue. Plan:
- [2-3 bullet points of what you'll do]

Files I expect to modify: `path/to/file1.ts`, `path/to/file2.ts`
```

### On Task Decomposition

If the issue requires changes across more than 3 files or involves multiple logical units:
1. Create sub-issues in Linear for each logical unit
2. Each sub-issue needs: title, description with context, and acceptance criteria
3. Post a comment on the parent issue summarizing the decomposition

### On Progress

Post a comment after each significant milestone:

```
**Completed: [what you did]**

Files changed: `path/to/file.ts`
Key decisions: [1-2 sentences explaining non-obvious choices]
```

Keep progress comments concise. 3-5 sentences max. No code blocks unless they illustrate a critical decision.

### On PR Creation

When you create a pull request:
1. Post a comment on the Linear issue with the PR link
2. The orchestrator will automatically update the issue status to "In Review"

```
**PR created**

[PR title](PR URL)

Summary: [2-3 sentences of what the PR accomplishes]
```

### On Blockers

If you encounter something you cannot resolve autonomously:
1. Post a comment with prefix `BLOCKER:`
2. Describe what you tried and why it didn't work
3. Continue working on non-blocked sub-tasks if possible

```
BLOCKER: [description]

Attempted: [what you tried]
Need: [what you need from the human]
```

### General Rules

- Always run tests before creating a PR: `{{TEST_COMMAND}}`
- Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`
- Link the Linear issue in commit messages: `feat: implement auth — PP-45`
- Do NOT modify files outside the scope defined in the issue
- If the issue description is ambiguous, make the best judgment call and document your reasoning in a comment
```

---

## 7. YAML CONFIGURATION SCHEMA

This is the complete reference configuration. Use this as the content for `examples/linear-first.yaml` in Task 6.2.

```yaml
# agent-orchestrator.yaml — Linear-First Configuration
# Complete reference for using Linear as the single source of truth

port: 3000
dataDir: ~/.agent-orchestrator
worktreeDir: ~/.worktrees

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  tracker: linear           # Use Linear instead of GitHub Issues
  notifiers: [desktop]

# Linear-specific configuration
linear:
  # Webhook receiver — accepts events FROM Linear
  webhooks:
    enabled: true
    path: /webhooks/linear
    secret: ${LINEAR_WEBHOOK_SECRET}

  # Maps orchestrator lifecycle events to Linear issue statuses
  statusMapping:
    agent-spawned: In Progress
    pr-created: In Review
    pr-merged: Done
    agent-failed: Todo
    agent-blocked: In Review

  # Controls what comments the orchestrator posts to Linear
  comments:
    enabled: true
    includeMetadata: true     # Include session ID, timestamps
    prefix: "🤖"             # Prefix for bot comments

  # Auto-spawn: automatically start agents when issues change status
  autoSpawn:
    enabled: true
    triggerStatus: Todo       # Moving an issue to "Todo" spawns an agent

# Project configurations
projects:
  jarvis:
    repo: owner/jarvis
    path: ~/projects/jarvis
    defaultBranch: main
    sessionPrefix: jarvis
    linear:
      team: ProximityParks
      project: JARVIS

  index-pp:
    repo: owner/index-pp
    path: ~/projects/index-pp
    defaultBranch: main
    sessionPrefix: idx
    linear:
      team: ProximityParks
      project: INDEX-PP

# Reaction configuration — auto-handle CI and review events
reactions:
  ci-failed:
    auto: true
    action: send-to-agent     # Forward CI logs to agent for fixing
    retries: 2
    linearComment: true       # Also post failure to Linear

  changes-requested:
    auto: true
    action: send-to-agent     # Forward review comments to agent
    escalateAfter: 30m        # Notify human after 30 minutes
    linearComment: true

  approved-and-green:
    auto: false               # Flip to true for auto-merge
    action: notify
    linearComment: true
```

---

## 8. LINEAR API REFERENCE

Quick reference for the Linear GraphQL API calls needed in this project.

### Authentication

All requests to `https://api.linear.app/graphql` use:
```
Authorization: Bearer {LINEAR_API_KEY}
Content-Type: application/json
```

### Create Comment

```graphql
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body createdAt }
  }
}

# Variables:
{ "input": { "issueId": "uuid-here", "body": "Markdown content" } }
```

### Create Issue (sub-issue)

```graphql
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url }
  }
}

# Variables:
{
  "input": {
    "teamId": "uuid",
    "title": "Sub-task title",
    "description": "Markdown description",
    "parentId": "parent-issue-uuid",
    "stateId": "backlog-status-uuid",
    "labelIds": ["label-uuid"],
    "priority": 3
  }
}
```

### Update Issue Status

```graphql
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id state { id name } }
  }
}

# Variables:
{ "id": "issue-uuid", "input": { "stateId": "new-status-uuid" } }
```

### Get Issue (full context)

```graphql
query Issue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    state { id name type }
    labels { nodes { id name color } }
    parent { id identifier title }
    children { nodes { id identifier title state { name } } }
    comments { nodes { id body createdAt user { name } } }
    assignee { id name email }
    project { id name }
    team { id name key }
    priority
    priorityLabel
  }
}
```

### Get Team Workflow States

```graphql
query TeamStates($teamId: String!) {
  team(id: $teamId) {
    states {
      nodes { id name type position }
    }
  }
}
```

### Webhook Payload Structure

Linear webhooks send POST requests with this structure:

```json
{
  "action": "create | update | remove",
  "type": "Issue | Comment | IssueLabel | Reaction",
  "data": {
    "id": "uuid",
    "identifier": "PP-45",
    "title": "Issue title",
    "state": { "id": "uuid", "name": "Todo", "type": "unstarted" },
    "team": { "id": "uuid", "key": "PP" },
    ...
  },
  "updatedFrom": {
    "stateId": "previous-state-uuid",
    "state": { "name": "Backlog" }
  },
  "url": "https://linear.app/proximityparks/issue/PP-45",
  "createdAt": "2026-03-14T10:30:00.000Z"
}
```

### Webhook Signature Verification

Header: `Linear-Signature`
Algorithm: HMAC SHA-256 of the raw request body using the webhook secret

```typescript
const expectedSignature = crypto
  .createHmac('sha256', process.env.LINEAR_WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex');
```

---

## 9. LINEAR WORKSPACE REFERENCE DATA

These are the real IDs from Pedro's Linear workspace. Use them in tests, examples, and documentation.

```yaml
team:
  name: ProximityParks
  id: d74813c3-16ef-4b18-9a66-ebf976ea4ce4

user:
  name: Pedro Treviño Gongora
  id: ef5efcf7-0b30-474c-9a34-fa1ac388bdde
  email: ptrevino@proximityparks.com

statuses:
  - name: Backlog
    id: e2abe3a8-60b1-4aba-8d1f-a786f3dbb372
    type: backlog
  - name: Todo
    id: a0f74d52-0021-42fa-8f95-56f9f88cfafb
    type: unstarted
  - name: In Progress
    id: 93c27041-b427-4e9c-90a4-a61d04c7bf38
    type: started
  - name: In Review
    id: 55e6343a-64a5-4fa1-ad00-9d3b3d31f824
    type: started
  - name: Done
    id: e50a3a2c-5e94-44eb-96aa-5cc040ae8ead
    type: completed
  - name: Canceled
    id: d92f7ec6-a208-4519-a7cf-1f4a5d4a8e4e
    type: canceled
  - name: Duplicate
    id: 80242867-87c5-4957-985d-02a274d88438
    type: canceled

labels:
  - name: Bug
    id: f62131bc-ec77-46fe-9467-39e5bb63002e
    color: "#EB5757"
  - name: Improvement
    id: a7ae1ecc-c43e-4ec6-937d-dfd8d5e42e60
    color: "#4EA7FC"
  - name: Feature
    id: 1307caae-592c-48ba-b4af-2b328e052128
    color: "#BB87FC"
```

---

## 10. TESTING STRATEGY

### Principles

1. **Never call the real Linear API in tests.** Always mock HTTP responses.
2. **Test each component in isolation first**, then integration.
3. **Run the full test suite after every task:** `pnpm test`
4. **Don't break existing tests.** If upstream tests fail after your changes, fix them.

### Mock setup

Create a shared mock for the Linear API:

```typescript
// tests/mocks/linear-api.ts

export function mockLinearAPI() {
  // Return mock responses for each GraphQL operation
  return {
    commentCreate: { success: true, comment: { id: 'mock-comment-id', body: 'test' } },
    issueCreate: { success: true, issue: { id: 'mock-id', identifier: 'PP-99', title: 'Test', url: 'https://linear.app/test' } },
    issueUpdate: { success: true, issue: { id: 'mock-id', state: { id: 'state-id', name: 'In Progress' } } },
    issue: { /* full issue object using reference data from Section 9 */ },
    teamStates: { nodes: [
      { id: 'e2abe3a8...', name: 'Backlog', type: 'backlog' },
      { id: 'a0f74d52...', name: 'Todo', type: 'unstarted' },
      { id: '93c27041...', name: 'In Progress', type: 'started' },
      { id: '55e6343a...', name: 'In Review', type: 'started' },
      { id: 'e50a3a2c...', name: 'Done', type: 'completed' }
    ]}
  };
}
```

### Test files to create

| File | Tests |
|------|-------|
| `tests/integration/linear/comment.test.ts` | createComment posts correct GraphQL payload |
| `tests/integration/linear/subissue.test.ts` | createSubIssue sends parentId correctly |
| `tests/integration/linear/status.test.ts` | updateIssueStatus resolves names, caches |
| `tests/integration/linear/reporter.test.ts` | Events → correct comments + status updates |
| `tests/integration/linear/webhook.test.ts` | Signature validation, event emission |
| `tests/integration/linear/autospawn.test.ts` | Status change → spawn, dedup |
| `tests/integration/linear/loop-prevention.test.ts` | Bot comments don't trigger webhooks |
| `tests/integration/linear/lifecycle.test.ts` | Full spawn → merge → done sequence |

---

## 11. CONVENTIONS AND RULES

### Code style

- Read the upstream `CLAUDE.md` before writing code — follow its conventions
- TypeScript strict mode
- Use `async/await`, not callbacks or raw promises
- Error handling: log and continue, don't throw from reporter/webhook code
- Imports: use the monorepo's existing patterns (check any plugin for reference)

### Commit messages

```
feat(linear): [description]     — new feature
fix(linear): [description]      — bug fix
docs(linear): [description]     — documentation
test(linear): [description]     — tests
refactor(linear): [description] — code restructure
```

### Branch strategy

- Work on `feature/linear-first`
- Commit after each completed task
- Don't squash — we want the full history

### File naming

- Source files: `kebab-case.ts` (e.g., `linear-reporter.ts`, `auto-spawn.ts`)
- Test files: `kebab-case.test.ts`
- Follow existing patterns in the monorepo

### Dependency management

- If you need `@linear/sdk`, add it to `packages/plugins/tracker-linear/package.json`
- Run `pnpm install` after adding dependencies
- Don't add dependencies to the root package.json unless they're truly shared

---

## END OF SPECIFICATION

**Execution checklist for Claude Code:**

```
[ ] Phase 1: Audit (Tasks 1.1, 1.2)
[ ] Phase 2: Tracker plugin (Tasks 2.1, 2.2, 2.3, 2.4)
[ ] Phase 3: Reporter module (Tasks 3.1, 3.2)
[ ] Phase 4: Webhooks (Tasks 4.1, 4.2)
[ ] Phase 5: Config and CLI (Tasks 5.1, 5.2, 5.3)
[ ] Phase 6: Templates and docs (Tasks 6.1, 6.2, 6.3)
[ ] Phase 7: Integration tests (Task 7.1)
```

Each task has explicit acceptance criteria. Check every box before moving on.
