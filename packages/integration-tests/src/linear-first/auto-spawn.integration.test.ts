import { describe, it, expect, beforeEach, vi } from "vitest";
import { createAutoSpawnHandler } from "@composio/ao-core";
import type {
  OrchestratorConfig,
  ProjectConfig,
  SessionManager,
  Session,
} from "@composio/ao-core";
import type { LinearIssueContext } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test-app",
  repo: "org/test-app",
  path: "/tmp/test-app",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "linear",
    teamId: "team-uuid",
    teamKey: "INT",
  },
};

const config: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
  port: 3000,
  defaults: {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["desktop"],
  },
  projects: { "test-app": project },
  notifiers: {},
  notificationRouting: {
    urgent: ["desktop"],
    action: ["desktop"],
    warning: [],
    info: [],
  },
  reactions: {},
  readyThresholdMs: 300_000,
  linear: {
    autoSpawn: {
      enabled: true,
      triggerStatus: "Todo",
    },
  },
};

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

function makeIssue(overrides: Partial<LinearIssueContext> = {}): LinearIssueContext {
  return {
    id: "issue-uuid",
    identifier: "INT-123",
    title: "Fix login bug",
    statusName: "Todo",
    teamKey: "INT",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoSpawnHandler", () => {
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();

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

  describe("handleIssueStatusChange", () => {
    it("spawns agent when issue moves to trigger status", async () => {
      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ statusName: "Todo" });
      const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

      expect(result.action).toBe("spawned");
      expect(result.session).toBeDefined();
      expect(mockSessionManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: "INT-123",
        }),
      );
    });

    it("does not spawn when autoSpawn is disabled", async () => {
      const configDisabled: OrchestratorConfig = {
        ...config,
        linear: {
          autoSpawn: {
            enabled: false,
            triggerStatus: "Todo",
          },
        },
      };

      const handler = createAutoSpawnHandler({ config: configDisabled });

      const issue = makeIssue({ statusName: "Todo" });
      const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

      expect(result.action).toBe("ignored");
      expect(result.reason).toContain("disabled");
      expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    });

    it("does not spawn when status does not match trigger", async () => {
      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ statusName: "In Progress" }); // Not "Todo"
      const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

      expect(result.action).toBe("ignored");
      expect(result.reason).toContain("status");
      expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    });

    it("does not spawn when active session already exists for issue", async () => {
      // Return an active session for the issue
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ issueId: "INT-123", status: "working" }),
      ]);

      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ statusName: "Todo" });
      const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("active session");
      expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    });

    it("spawns when previous session for issue is terminal", async () => {
      // Return a terminal session for the issue
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ issueId: "INT-123", status: "merged" }),
      ]);

      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ statusName: "Todo" });
      const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

      expect(result.action).toBe("spawned");
      expect(mockSessionManager.spawn).toHaveBeenCalled();
    });

    it("supports multiple trigger statuses", async () => {
      const configMultiple: OrchestratorConfig = {
        ...config,
        linear: {
          autoSpawn: {
            enabled: true,
            triggerStatus: ["Todo", "Ready"],
          },
        },
      };

      const handler = createAutoSpawnHandler({ config: configMultiple });

      // Test "Todo"
      const result1 = await handler.handleIssueStatusChange(
        makeIssue({ identifier: "INT-123", statusName: "Todo" }),
        mockSessionManager,
      );
      expect(result1.action).toBe("spawned");

      vi.clearAllMocks();
      vi.mocked(mockSessionManager.list).mockResolvedValue([]);
      vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession({ id: "test-2" }));

      // Test "Ready"
      const result2 = await handler.handleIssueStatusChange(
        makeIssue({ identifier: "INT-456", statusName: "Ready" }),
        mockSessionManager,
      );
      expect(result2.action).toBe("spawned");
    });

    it("resolves project from teamKey", async () => {
      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ statusName: "Todo", teamKey: "INT" });
      await handler.handleIssueStatusChange(issue, mockSessionManager);

      // Should spawn with correct project
      expect(mockSessionManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "test-app",
        }),
      );
    });

    it("returns ignored when no project found for teamKey", async () => {
      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({
        identifier: "OTHER-123",
        statusName: "Todo",
        teamKey: "OTHER", // No project configured for this team
      });
      const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

      expect(result.action).toBe("ignored");
      expect(result.reason).toContain("project");
      expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    });
  });

  describe("isEnabled", () => {
    it("returns true when autoSpawn is enabled", () => {
      const handler = createAutoSpawnHandler({ config });
      expect(handler.isEnabled()).toBe(true);
    });

    it("returns false when autoSpawn is disabled", () => {
      const configDisabled: OrchestratorConfig = {
        ...config,
        linear: {
          autoSpawn: {
            enabled: false,
            triggerStatus: "Todo",
          },
        },
      };

      const handler = createAutoSpawnHandler({ config: configDisabled });
      expect(handler.isEnabled()).toBe(false);
    });
  });

  describe("findProjectForIssue", () => {
    it("matches project by tracker.teamKey", () => {
      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ teamKey: "INT" });
      const match = handler.findProjectForIssue(issue);

      expect(match).not.toBeNull();
      expect(match?.projectId).toBe("test-app");
    });

    it("extracts teamKey from issue identifier when not provided", () => {
      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({
        identifier: "INT-123", // teamKey should be extracted as "INT"
        teamKey: undefined,
      });
      const match = handler.findProjectForIssue(issue);

      expect(match).not.toBeNull();
      expect(match?.projectId).toBe("test-app");
    });

    it("returns null when no matching project found", () => {
      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ identifier: "OTHER-123", teamKey: "OTHER" });
      const match = handler.findProjectForIssue(issue);

      expect(match).toBeNull();
    });
  });

  describe("error handling", () => {
    it("returns error result when spawn fails", async () => {
      vi.mocked(mockSessionManager.spawn).mockRejectedValue(new Error("Spawn failed"));

      const handler = createAutoSpawnHandler({ config });

      const issue = makeIssue({ statusName: "Todo" });
      const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

      expect(result.action).toBe("error");
      expect(result.reason).toContain("Spawn failed");
    });
  });

  describe("terminal status detection", () => {
    const terminalStatuses = ["merged", "done", "killed", "errored"] as const;

    for (const status of terminalStatuses) {
      it(`considers "${status}" as terminal (allows re-spawn)`, async () => {
        vi.mocked(mockSessionManager.list).mockResolvedValue([
          makeSession({ issueId: "INT-123", status }),
        ]);

        const handler = createAutoSpawnHandler({ config });

        const issue = makeIssue({ statusName: "Todo" });
        const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

        expect(result.action).toBe("spawned");
      });
    }

    const nonTerminalStatuses = ["spawning", "working", "pr_open", "ci_failed", "in_review"] as const;

    for (const status of nonTerminalStatuses) {
      it(`considers "${status}" as non-terminal (blocks re-spawn)`, async () => {
        vi.mocked(mockSessionManager.list).mockResolvedValue([
          makeSession({ issueId: "INT-123", status }),
        ]);

        const handler = createAutoSpawnHandler({ config });

        const issue = makeIssue({ statusName: "Todo" });
        const result = await handler.handleIssueStatusChange(issue, mockSessionManager);

        expect(result.action).toBe("skipped");
        expect(result.reason).toContain("active session");
      });
    }
  });
});
