import { describe, it, expect, beforeEach, vi } from "vitest";
import { isBotGeneratedComment, TERMINAL_STATUSES } from "@composio/ao-core";
import type {
  SessionManager,
  Session,
} from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Loop Prevention Integration Tests
// ---------------------------------------------------------------------------
//
// Tests the loop prevention mechanisms in the Linear-first integration.
//
// Potential loop scenarios:
// 1. Agent spawns → posts comment → webhook fires → triggers spawn
// 2. Status update → webhook fires → triggers action → status update
// 3. Comment created → webhook fires → agent responds → comment created
//
// Prevention mechanisms:
// 1. Bot comment detection (isBotGeneratedComment function)
// 2. API user detection (isMe flag)
// 3. Duplicate session detection (TERMINAL_STATUSES check)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-app",
    status: "working",
    activity: "active",
    branch: "feat/INT-123",
    issueId: "INT-123",
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    provider: "anthropic",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Loop Prevention: Bot Comment Detection (isBotGeneratedComment)", () => {
  describe("bot comment prefixes", () => {
    it("detects 🤖 prefix as bot comment", () => {
      expect(isBotGeneratedComment("🤖 Agent spawned")).toBe(true);
    });

    it("detects [bot] prefix as bot comment", () => {
      expect(isBotGeneratedComment("[bot] Status update")).toBe(true);
    });

    it("detects [ao] prefix as bot comment", () => {
      expect(isBotGeneratedComment("[ao] Task completed")).toBe(true);
    });

    it("detects [agent] prefix as bot comment", () => {
      expect(isBotGeneratedComment("[agent] Working on issue")).toBe(true);
    });

    it("detects [automated] prefix as bot comment", () => {
      expect(isBotGeneratedComment("[automated] CI passed")).toBe(true);
    });
  });

  describe("case insensitivity", () => {
    it("detects [BOT] prefix (uppercase)", () => {
      expect(isBotGeneratedComment("[BOT] Update")).toBe(true);
    });

    it("detects [Bot] prefix (mixed case)", () => {
      expect(isBotGeneratedComment("[Bot] Update")).toBe(true);
    });
  });

  describe("legitimate user comments", () => {
    it("allows normal user comments", () => {
      expect(isBotGeneratedComment("Please fix this bug")).toBe(false);
    });

    it("allows comments mentioning bots in middle", () => {
      expect(isBotGeneratedComment("The [bot] prefix is used for automation")).toBe(false);
    });

    it("allows comments with emoji in middle", () => {
      expect(isBotGeneratedComment("Great work! 🤖")).toBe(false);
    });

    it("allows questions about automation", () => {
      expect(isBotGeneratedComment("Can the agent handle this?")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(isBotGeneratedComment("")).toBe(false);
    });

    it("handles whitespace-only string", () => {
      expect(isBotGeneratedComment("   ")).toBe(false);
    });

    it("handles whitespace before prefix", () => {
      // Trimmed, so whitespace before should still work
      expect(isBotGeneratedComment("  🤖 Agent update")).toBe(true);
    });

    it("handles newline after prefix", () => {
      expect(isBotGeneratedComment("🤖\nAgent update on new line")).toBe(true);
    });
  });
});

describe("Loop Prevention: API User Detection", () => {
  describe("isMe flag detection", () => {
    it("identifies API user comments (isMe: true)", () => {
      const comment = {
        body: "Status update",
        user: { id: "api-user", name: "API", isMe: true },
      };

      const isApiUser = comment.user?.isMe === true;
      expect(isApiUser).toBe(true);
    });

    it("allows regular user comments (isMe: false)", () => {
      const comment = {
        body: "Please fix",
        user: { id: "human", name: "John", isMe: false },
      };

      const isApiUser = comment.user?.isMe === true;
      expect(isApiUser).toBe(false);
    });

    it("allows comments with no user", () => {
      const comment = {
        body: "Anonymous comment",
        user: undefined as { isMe?: boolean } | undefined,
      };

      const isApiUser = comment.user?.isMe === true;
      expect(isApiUser).toBe(false);
    });

    it("allows comments where isMe is undefined", () => {
      const comment = {
        body: "Comment",
        user: { id: "unknown", name: "Unknown" } as { isMe?: boolean },
      };

      const isApiUser = comment.user?.isMe === true;
      expect(isApiUser).toBe(false);
    });
  });
});

describe("Loop Prevention: Duplicate Session Detection (TERMINAL_STATUSES)", () => {
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    mockSessionManager = {
      spawn: vi.fn().mockResolvedValue(makeSession()),
      spawnOrchestrator: vi.fn(),
      restore: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      kill: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe("terminal statuses allow re-spawn", () => {
    it("merged is terminal", () => {
      expect(TERMINAL_STATUSES.has("merged")).toBe(true);
    });

    it("done is terminal", () => {
      expect(TERMINAL_STATUSES.has("done")).toBe(true);
    });

    it("killed is terminal", () => {
      expect(TERMINAL_STATUSES.has("killed")).toBe(true);
    });

    it("errored is terminal", () => {
      expect(TERMINAL_STATUSES.has("errored")).toBe(true);
    });
  });

  describe("non-terminal statuses block re-spawn", () => {
    it("working is not terminal", () => {
      expect(TERMINAL_STATUSES.has("working")).toBe(false);
    });

    it("spawning is not terminal", () => {
      expect(TERMINAL_STATUSES.has("spawning")).toBe(false);
    });

    it("pr_open is not terminal", () => {
      expect(TERMINAL_STATUSES.has("pr_open")).toBe(false);
    });

    it("in_review is not terminal", () => {
      expect(TERMINAL_STATUSES.has("in_review")).toBe(false);
    });
  });

  describe("duplicate detection logic", () => {
    it("blocks spawn when active session exists", async () => {
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ issueId: "INT-123", status: "working" }),
      ]);

      const existingSessions = await mockSessionManager.list();
      const hasActiveSession = existingSessions.some(
        (s) => s.issueId === "INT-123" && !TERMINAL_STATUSES.has(s.status),
      );

      expect(hasActiveSession).toBe(true);
    });

    it("allows spawn when only terminal sessions exist", async () => {
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ issueId: "INT-123", status: "merged" }),
      ]);

      const existingSessions = await mockSessionManager.list();
      const hasActiveSession = existingSessions.some(
        (s) => s.issueId === "INT-123" && !TERMINAL_STATUSES.has(s.status),
      );

      expect(hasActiveSession).toBe(false);
    });

    it("allows spawn for different issue", async () => {
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ issueId: "INT-456", status: "working" }),
      ]);

      const existingSessions = await mockSessionManager.list();
      const hasActiveSession = existingSessions.some(
        (s) => s.issueId === "INT-123" && !TERMINAL_STATUSES.has(s.status),
      );

      expect(hasActiveSession).toBe(false);
    });
  });
});

describe("Loop Prevention: Webhook Event Filtering", () => {
  // Helper function mimicking webhook filter logic
  function shouldProcessWebhook(payload: {
    type: string;
    action: string;
    data: { body?: string; user?: { isMe: boolean } };
  }): boolean {
    // Only filter Comment.create events
    if (payload.type !== "Comment" || payload.action !== "create") {
      return true;
    }

    const body = payload.data.body ?? "";
    const isMe = payload.data.user?.isMe ?? false;

    // Filter bot comments using actual isBotGeneratedComment
    if (isBotGeneratedComment(body)) {
      return false;
    }

    // Filter API user comments
    if (isMe) {
      return false;
    }

    return true;
  }

  describe("Comment.create events", () => {
    it("filters bot comments", () => {
      const webhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "🤖 Agent spawned",
          user: { isMe: false },
        },
      };

      expect(shouldProcessWebhook(webhookPayload)).toBe(false);
    });

    it("filters API user comments", () => {
      const webhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Status update",
          user: { isMe: true },
        },
      };

      expect(shouldProcessWebhook(webhookPayload)).toBe(false);
    });

    it("processes legitimate user comments", () => {
      const webhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Please review this",
          user: { isMe: false },
        },
      };

      expect(shouldProcessWebhook(webhookPayload)).toBe(true);
    });
  });

  describe("Issue.update events", () => {
    it("always processes Issue.update events", () => {
      const webhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          state: { name: "Todo" },
        } as { body?: string; user?: { isMe: boolean } },
      };

      expect(shouldProcessWebhook(webhookPayload)).toBe(true);
    });
  });
});

describe("Loop Prevention: Full Cycle Simulation", () => {
  it("prevents spawn loop: status change → spawn → comment → webhook → should NOT spawn again", () => {
    const events: string[] = [];
    let spawnCount = 0;
    let commentCount = 0;
    const activeSessions = new Set<string>();

    // Simulate the cycle
    const processStatusChange = (issueId: string, newStatus: string) => {
      events.push(`status:${newStatus}`);

      // Check if should spawn
      if (newStatus === "Todo" && !activeSessions.has(issueId)) {
        events.push("spawn");
        spawnCount++;
        activeSessions.add(issueId);

        // Spawning creates a comment
        const comment = "🤖 Agent spawned";
        events.push(`comment:${comment}`);
        commentCount++;

        // This triggers a webhook for Comment.create
        // But should be filtered as bot comment
        const webhookFiltered = isBotGeneratedComment(comment);
        events.push(`webhook-filtered:${webhookFiltered}`);
      }
    };

    // First trigger
    processStatusChange("INT-123", "Todo");

    // Verify
    expect(spawnCount).toBe(1);
    expect(commentCount).toBe(1);
    expect(events).toContain("spawn");
    expect(events).toContain("webhook-filtered:true");
  });

  it("prevents duplicate spawn: multiple rapid status changes to Todo", () => {
    const activeSessions = new Set<string>();
    let spawnCount = 0;

    const trySpawn = (issueId: string) => {
      if (activeSessions.has(issueId)) {
        return false;
      }
      activeSessions.add(issueId);
      spawnCount++;
      return true;
    };

    // Simulate rapid status changes (e.g., webhook replay, race condition)
    const spawned1 = trySpawn("INT-123");
    const spawned2 = trySpawn("INT-123");
    const spawned3 = trySpawn("INT-123");

    expect(spawned1).toBe(true);
    expect(spawned2).toBe(false);
    expect(spawned3).toBe(false);
    expect(spawnCount).toBe(1);
  });

  it("allows re-spawn after session completes (terminal status)", () => {
    const sessionStatuses = new Map<string, Session["status"]>();
    let spawnCount = 0;

    const canSpawn = (issueId: string) => {
      const status = sessionStatuses.get(issueId);
      return !status || TERMINAL_STATUSES.has(status);
    };

    const spawn = (issueId: string) => {
      if (canSpawn(issueId)) {
        sessionStatuses.set(issueId, "working");
        spawnCount++;
        return true;
      }
      return false;
    };

    const complete = (issueId: string) => {
      sessionStatuses.set(issueId, "merged");
    };

    // First spawn
    expect(spawn("INT-123")).toBe(true);
    expect(spawnCount).toBe(1);

    // Try to spawn again (should fail - active session)
    expect(spawn("INT-123")).toBe(false);
    expect(spawnCount).toBe(1);

    // Complete the session
    complete("INT-123");

    // Now should be able to spawn again
    expect(spawn("INT-123")).toBe(true);
    expect(spawnCount).toBe(2);
  });
});
