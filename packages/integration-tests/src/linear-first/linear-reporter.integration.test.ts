import { describe, it, expect, beforeEach, vi } from "vitest";
import { createLinearReporter } from "@composio/ao-core";
import type {
  OrchestratorConfig,
  ProjectConfig,
  PluginRegistry,
  Tracker,
  OrchestratorEvent,
} from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Mock tracker
// ---------------------------------------------------------------------------

const mockTracker: Tracker = {
  name: "linear",
  getIssue: vi.fn(),
  isCompleted: vi.fn(),
  issueUrl: vi.fn(),
  branchName: vi.fn(),
  generatePrompt: vi.fn(),
  createComment: vi.fn().mockResolvedValue({ id: "comment-1", body: "", createdAt: "" }),
  updateIssueStatus: vi.fn().mockResolvedValue(undefined),
};

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
    statusMapping: {
      "agent-spawned": "In Progress",
      "pr-created": "In Review",
      "pr-merged": "Done",
    },
    comments: {
      enabled: true,
      prefix: "🤖",
    },
  },
};

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn().mockImplementation((slot: string, name?: string) => {
    if (slot === "tracker" && name === "linear") return mockTracker;
    return null;
  }),
  list: vi.fn().mockReturnValue([]),
  loadBuiltins: vi.fn(),
  loadFromConfig: vi.fn(),
};

function makeEvent(
  type: OrchestratorEvent["type"],
  data: Record<string, unknown> = {},
): OrchestratorEvent {
  return {
    type,
    timestamp: new Date(),
    sessionId: "test-1",
    projectId: "test-app",
    data,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinearReporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("reportEvent - session.spawned", () => {
    it("creates comment and updates status to In Progress", async () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("session.spawned");
      await reporter.reportEvent(event, "INT-123", project);

      // Should create a comment
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("🤖"),
        project,
      );
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("Agent spawned"),
        project,
      );

      // Should update status
      expect(mockTracker.updateIssueStatus).toHaveBeenCalledWith(
        "INT-123",
        "In Progress",
        project,
      );
    });

    it("skips reporting when comments are disabled", async () => {
      const configNoComments: OrchestratorConfig = {
        ...config,
        linear: {
          ...config.linear,
          comments: { enabled: false },
        },
      };

      const reporter = createLinearReporter({
        config: configNoComments,
        registry: mockRegistry,
      });

      const event = makeEvent("session.spawned");
      await reporter.reportEvent(event, "INT-123", project);

      expect(mockTracker.createComment).not.toHaveBeenCalled();
      // Status should still be updated
      expect(mockTracker.updateIssueStatus).toHaveBeenCalled();
    });
  });

  describe("reportEvent - pr.created", () => {
    it("creates comment with PR link and updates status to In Review", async () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("pr.created", {
        prUrl: "https://github.com/org/repo/pull/42",
        prTitle: "Fix INT-123",
      });
      await reporter.reportEvent(event, "INT-123", project);

      // Should create a comment with PR link
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("Pull Request created"),
        project,
      );
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("https://github.com/org/repo/pull/42"),
        project,
      );

      // Should update status
      expect(mockTracker.updateIssueStatus).toHaveBeenCalledWith(
        "INT-123",
        "In Review",
        project,
      );
    });
  });

  describe("reportEvent - pr.merged", () => {
    it("creates comment and updates status to Done", async () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("pr.merged", {
        prUrl: "https://github.com/org/repo/pull/42",
      });
      await reporter.reportEvent(event, "INT-123", project);

      // Should create a comment
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("PR Merged"),
        project,
      );

      // Should update status
      expect(mockTracker.updateIssueStatus).toHaveBeenCalledWith(
        "INT-123",
        "Done",
        project,
      );
    });
  });

  describe("reportEvent - ci.failing", () => {
    it("creates comment about CI failure without status change", async () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("ci.failing", {
        failedChecks: ["lint", "tests"],
      });
      await reporter.reportEvent(event, "INT-123", project);

      // Should create a comment
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("CI Failed"),
        project,
      );
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("lint"),
        project,
      );
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("tests"),
        project,
      );

      // Should NOT update status (CI failure is informational)
      expect(mockTracker.updateIssueStatus).not.toHaveBeenCalled();
    });
  });

  describe("reportEvent - session.stuck", () => {
    it("creates warning comment about stuck session", async () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("session.stuck");
      await reporter.reportEvent(event, "INT-123", project);

      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("⚠️"),
        project,
      );
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("stuck"),
        project,
      );
    });
  });

  describe("reportEvent - session.needs_input", () => {
    it("creates urgent comment about agent needing input", async () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("session.needs_input");
      await reporter.reportEvent(event, "INT-123", project);

      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("⏸️"),
        project,
      );
      expect(mockTracker.createComment).toHaveBeenCalledWith(
        "INT-123",
        expect.stringContaining("Waiting for input"),
        project,
      );
    });
  });

  describe("isEnabled", () => {
    it("returns true for Linear tracker projects", () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      expect(reporter.isEnabled(project)).toBe(true);
    });

    it("returns false for non-Linear tracker projects", () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const githubProject: ProjectConfig = {
        ...project,
        tracker: { plugin: "github" },
      };

      expect(reporter.isEnabled(githubProject)).toBe(false);
    });
  });

  describe("config merging", () => {
    it("uses project-level config override when available", async () => {
      const projectWithOverride: ProjectConfig = {
        ...project,
        tracker: {
          ...project.tracker,
          plugin: "linear",
          statusMapping: {
            "session.spawned": "Working",
          },
        },
      };

      const configWithProject: OrchestratorConfig = {
        ...config,
        projects: { "test-app": projectWithOverride },
      };

      const reporter = createLinearReporter({
        config: configWithProject,
        registry: mockRegistry,
      });

      const event = makeEvent("session.spawned");
      await reporter.reportEvent(event, "INT-123", projectWithOverride);

      // Should use project-level status mapping
      expect(mockTracker.updateIssueStatus).toHaveBeenCalledWith(
        "INT-123",
        "Working",
        projectWithOverride,
      );
    });
  });

  describe("error handling", () => {
    it("continues gracefully when createComment fails", async () => {
      vi.mocked(mockTracker.createComment).mockRejectedValueOnce(new Error("API error"));

      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("session.spawned");

      // Should not throw
      await expect(reporter.reportEvent(event, "INT-123", project)).resolves.not.toThrow();

      // Status update should still be attempted
      expect(mockTracker.updateIssueStatus).toHaveBeenCalled();
    });

    it("continues gracefully when updateIssueStatus fails", async () => {
      vi.mocked(mockTracker.updateIssueStatus).mockRejectedValueOnce(new Error("API error"));

      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      const event = makeEvent("session.spawned");

      // Should not throw
      await expect(reporter.reportEvent(event, "INT-123", project)).resolves.not.toThrow();
    });
  });

  describe("non-reporting events", () => {
    it("does not comment on unknown event types", async () => {
      const reporter = createLinearReporter({
        config,
        registry: mockRegistry,
      });

      // Use a valid event type that doesn't have special handling
      const event = makeEvent("webhook.received" as OrchestratorEvent["type"]);
      await reporter.reportEvent(event, "INT-123", project);

      expect(mockTracker.createComment).not.toHaveBeenCalled();
      expect(mockTracker.updateIssueStatus).not.toHaveBeenCalled();
    });
  });
});
