import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock node:https
// ---------------------------------------------------------------------------

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("node:https", () => ({
  request: requestMock,
}));

import { create, manifest, clearCaches, RetryableError, setRetryConfig } from "../src/index.js";
import type { ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/integrator",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "linear",
    teamId: "team-uuid-1",
    workspaceSlug: "acme",
  },
};

const projectNoSlug: ProjectConfig = {
  ...project,
  tracker: { plugin: "linear", teamId: "team-uuid-1" },
};

const sampleIssueNode = {
  id: "uuid-123",
  identifier: "INT-123",
  title: "Fix login bug",
  description: "Users can't log in with SSO",
  url: "https://linear.app/acme/issue/INT-123",
  priority: 2,
  state: { name: "In Progress", type: "started" },
  labels: { nodes: [{ name: "bug" }, { name: "high-priority" }] },
  assignee: { name: "Alice Smith", displayName: "Alice" },
  team: { key: "INT" },
};

/** Extended version with fields used by generatePrompt's enriched query */
const sampleIssueNodeEnriched = {
  ...sampleIssueNode,
  dueDate: null as string | null,
  estimate: null as number | null,
  project: null as { name: string; state: string } | null,
  cycle: null as { name: string | null; number: number; startsAt: string; endsAt: string } | null,
  parent: null as { identifier: string; title: string } | null,
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Queue a successful Linear API response.
 * Each call to linearQuery() will consume the next queued response.
 */
function mockLinearAPI(responseData: unknown, statusCode = 200) {
  const body = JSON.stringify({ data: responseData });

  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

/** Queue a Linear API error response (GraphQL errors array). */
function mockLinearError(message: string) {
  const body = JSON.stringify({ errors: [{ message }] });

  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

/** Queue an HTTP-level error (non-200 status). */
function mockHTTPError(statusCode: number, body: string, headers: Record<string, string> = {}) {
  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode, headers });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-linear plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    clearCaches(); // Clear identifier→UUID, workflow state, rate limit, and retry config
    // Disable retries for all tests by default — retry-specific tests re-enable
    setRetryConfig({ maxRetries: 0 });
    savedApiKey = process.env["LINEAR_API_KEY"];
    process.env["LINEAR_API_KEY"] = "lin_api_test_key";
    tracker = create();
  });

  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env["LINEAR_API_KEY"];
    } else {
      process.env["LINEAR_API_KEY"] = savedApiKey;
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("linear");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("linear");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockLinearAPI({ issue: sampleIssueNode });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue).toEqual({
        id: "INT-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://linear.app/acme/issue/INT-123",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "Alice",
        priority: 2,
      });
    });

    it("maps completed state to closed", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, state: { name: "Done", type: "completed" } },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps canceled state to cancelled", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, state: { name: "Canceled", type: "canceled" } },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.state).toBe("cancelled");
    });

    it("maps backlog/triage/unstarted to open", async () => {
      for (const type of ["backlog", "triage", "unstarted"]) {
        mockLinearAPI({
          issue: { ...sampleIssueNode, state: { name: type, type } },
        });
        const issue = await tracker.getIssue("INT-123", project);
        expect(issue.state).toBe("open");
      }
    });

    it("handles null description", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, description: null },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.description).toBe("");
    });

    it("handles null assignee", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, assignee: null },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("uses assignee name as fallback when displayName is missing", async () => {
      mockLinearAPI({
        issue: {
          ...sampleIssueNode,
          assignee: { name: "Alice Smith", displayName: undefined },
        },
      });
      const issue = await tracker.getIssue("INT-123", project);
      // undefined displayName falls through to name via ??
      expect(issue.assignee).toBe("Alice Smith");
    });

    it("handles empty labels", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, labels: { nodes: [] } },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.labels).toEqual([]);
    });

    it("propagates API errors", async () => {
      mockLinearError("Issue not found");
      await expect(tracker.getIssue("INT-999", project)).rejects.toThrow(
        "Linear API error: Issue not found",
      );
    });

    it("throws when LINEAR_API_KEY is missing", async () => {
      delete process.env["LINEAR_API_KEY"];
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "LINEAR_API_KEY environment variable is required",
      );
    });

    it("throws on HTTP errors", async () => {
      mockHTTPError(500, "Internal Server Error");
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API server error (HTTP 500)",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for completed state", async () => {
      mockLinearAPI({ issue: { state: { type: "completed" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(true);
    });

    it("returns true for canceled state", async () => {
      mockLinearAPI({ issue: { state: { type: "canceled" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(true);
    });

    it("returns false for started state", async () => {
      mockLinearAPI({ issue: { state: { type: "started" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(false);
    });

    it("returns false for unstarted state", async () => {
      mockLinearAPI({ issue: { state: { type: "unstarted" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL with workspace slug", () => {
      expect(tracker.issueUrl("INT-123", project)).toBe("https://linear.app/acme/issue/INT-123");
    });

    it("generates fallback URL without workspace slug", () => {
      expect(tracker.issueUrl("INT-123", projectNoSlug)).toBe("https://linear.app/issue/INT-123");
    });

    it("generates fallback URL when no tracker config", () => {
      const noTracker: ProjectConfig = { ...project, tracker: undefined };
      expect(tracker.issueUrl("INT-123", noTracker)).toBe("https://linear.app/issue/INT-123");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/ prefix branch name", () => {
      expect(tracker.branchName("INT-123", project)).toBe("feat/INT-123");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title, URL, and description", async () => {
      mockLinearAPI({ issue: sampleIssueNodeEnriched });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("INT-123");
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://linear.app/acme/issue/INT-123");
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("includes labels when present", async () => {
      mockLinearAPI({ issue: sampleIssueNodeEnriched });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("bug, high-priority");
    });

    it("includes priority", async () => {
      mockLinearAPI({ issue: sampleIssueNodeEnriched });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("High");
    });

    it("maps priority numbers to names", async () => {
      const priorities: Record<number, string> = {
        0: "No priority",
        1: "Urgent",
        2: "High",
        3: "Normal",
        4: "Low",
      };
      for (const [num, name] of Object.entries(priorities)) {
        clearCaches(); // Clear identifier cache between iterations
        mockLinearAPI({
          issue: { ...sampleIssueNodeEnriched, priority: Number(num) },
        });
        const prompt = await tracker.generatePrompt("INT-123", project);
        expect(prompt).toContain(name);
      }
    });

    it("omits description section when empty", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNodeEnriched, description: null },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).not.toContain("## Description");
    });

    it("omits labels line when no labels", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNodeEnriched, labels: { nodes: [] } },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("includes project name when present", async () => {
      mockLinearAPI({
        issue: {
          ...sampleIssueNodeEnriched,
          project: { name: "Q1 Release", state: "started" },
        },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("Project: Q1 Release (started)");
    });

    it("includes cycle info when present", async () => {
      mockLinearAPI({
        issue: {
          ...sampleIssueNodeEnriched,
          cycle: { name: "Sprint 5", number: 5, startsAt: "2026-03-01", endsAt: "2026-03-15" },
        },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("Cycle: Sprint 5 (ends 2026-03-15)");
    });

    it("includes due date when present", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNodeEnriched, dueDate: "2026-03-20" },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("Due date: 2026-03-20");
    });

    it("includes parent issue when present", async () => {
      mockLinearAPI({
        issue: {
          ...sampleIssueNodeEnriched,
          parent: { identifier: "INT-100", title: "Epic: Auth Improvements" },
        },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("Parent issue: INT-100");
    });

    it("includes estimate when present", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNodeEnriched, estimate: 3 },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("Estimate: 3 points");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockLinearAPI({
        issues: {
          nodes: [sampleIssueNode, { ...sampleIssueNode, identifier: "INT-456", title: "Another" }],
        },
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("INT-123");
      expect(issues[1].id).toBe("INT-456");
    });

    it("passes state filter for open issues", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ state: "open" }, project);

      // Verify the request body contains the correct filter
      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.state).toEqual({
        type: { nin: ["completed", "canceled"] },
      });
    });

    it("passes state filter for closed issues", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ state: "closed" }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.state).toEqual({
        type: { in: ["completed", "canceled"] },
      });
    });

    it("defaults to open state when no state specified", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({}, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.state).toEqual({
        type: { nin: ["completed", "canceled"] },
      });
    });

    it("passes assignee filter", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ assignee: "Alice" }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.assignee).toEqual({
        displayName: { eq: "Alice" },
      });
    });

    it("passes labels filter", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.labels).toEqual({
        name: { in: ["bug", "urgent"] },
      });
    });

    it("passes team filter from project config", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({}, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.team).toEqual({
        id: { eq: "team-uuid-1" },
      });
    });

    it("respects custom limit", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ limit: 5 }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.first).toBe(5);
    });

    it("defaults limit to 30", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({}, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.first).toBe(30);
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    const workflowStates = {
      workflowStates: {
        nodes: [
          { id: "state-1", name: "Todo", type: "unstarted" },
          { id: "state-2", name: "In Progress", type: "started" },
          { id: "state-3", name: "Done", type: "completed" },
        ],
      },
    };

    it("changes state to closed (completed)", async () => {
      // 1st: resolve identifier to UUID (cached after this)
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2nd: fetch workflow states (via getWorkflowStates, cached after this)
      mockLinearAPI(workflowStates);
      // 3rd: consolidated issueUpdate mutation
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "closed" }, project);
      expect(requestMock).toHaveBeenCalledTimes(3);
    });

    it("changes state to open (unstarted) — uses consolidated input", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI(workflowStates);
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "open" }, project);

      // Verify the mutation uses consolidated $input with stateId
      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.input.stateId).toBe("state-1");
    });

    it("changes state to in_progress (started)", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI(workflowStates);
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "in_progress" }, project);

      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.input.stateId).toBe("state-2");
    });

    it("throws when target workflow state is not found", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // Return states without "completed"
      mockLinearAPI({
        workflowStates: {
          nodes: [{ id: "state-1", name: "Todo", type: "unstarted" }],
        },
      });

      await expect(tracker.updateIssue!("INT-123", { state: "closed" }, project)).rejects.toThrow(
        'No workflow state of type "completed"',
      );
    });

    it("adds a comment (no issueUpdate needed)", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI({ commentCreate: { success: true } });

      await tracker.updateIssue!("INT-123", { comment: "Working on this" }, project);
      expect(requestMock).toHaveBeenCalledTimes(2);

      // Verify comment body
      const writeCall = requestMock.mock.results[1].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.body).toBe("Working on this");
    });

    it("handles state change + comment together (1 issueUpdate + 1 commentCreate)", async () => {
      // 1: resolve identifier
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2: workflow states
      mockLinearAPI(workflowStates);
      // 3: consolidated issueUpdate (state)
      mockLinearAPI({ issueUpdate: { success: true } });
      // 4: commentCreate
      mockLinearAPI({ commentCreate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "closed", comment: "Done!" }, project);
      expect(requestMock).toHaveBeenCalledTimes(4);
    });

    it("updates assignee by resolving display name to ID — consolidated", async () => {
      // 1: resolve identifier
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2: user lookup (in parallel via Promise.all)
      mockLinearAPI({
        users: { nodes: [{ id: "user-1", displayName: "Alice", name: "Alice Smith" }] },
      });
      // 3: consolidated issueUpdate (assignee)
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { assignee: "Alice" }, project);
      expect(requestMock).toHaveBeenCalledTimes(3);

      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.input.assigneeId).toBe("user-1");
    });

    it("updates labels additively (merges with existing) — consolidated", async () => {
      // 1: resolve identifier
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2-3: fetch existing labels + team labels (in parallel via Promise.all)
      mockLinearAPI({ issue: { labels: { nodes: [{ id: "label-existing" }] } } });
      mockLinearAPI({
        issueLabels: {
          nodes: [
            { id: "label-1", name: "bug" },
            { id: "label-2", name: "urgent" },
          ],
        },
      });
      // 4: consolidated issueUpdate (labels)
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { labels: ["bug", "urgent"] }, project);
      expect(requestMock).toHaveBeenCalledTimes(4);

      const writeCall = requestMock.mock.results[3].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      // Should include existing + new labels via consolidated input
      expect(body.variables.input.labelIds).toEqual(
        expect.arrayContaining(["label-existing", "label-1", "label-2"]),
      );
      expect(body.variables.input.labelIds).toHaveLength(3);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates a basic issue", async () => {
      mockLinearAPI({
        issueCreate: { success: true, issue: sampleIssueNode },
      });

      const issue = await tracker.createIssue!(
        { title: "Fix login bug", description: "Desc" },
        project,
      );
      expect(issue).toMatchObject({
        id: "INT-123",
        title: "Fix login bug",
        state: "in_progress",
      });
    });

    it("passes priority to mutation", async () => {
      mockLinearAPI({
        issueCreate: { success: true, issue: sampleIssueNode },
      });

      await tracker.createIssue!({ title: "Bug", description: "", priority: 1 }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.priority).toBe(1);
    });

    it("resolves assignee by display name after creation", async () => {
      // 1: create issue
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, assignee: null },
        },
      });
      // 2: look up user by display name
      mockLinearAPI({
        users: { nodes: [{ id: "user-1", displayName: "Alice", name: "Alice Smith" }] },
      });
      // 3: issueUpdate to assign
      mockLinearAPI({ issueUpdate: { success: true } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "Alice" },
        project,
      );
      expect(issue.assignee).toBe("Alice");
      expect(requestMock).toHaveBeenCalledTimes(3);
    });

    it("skips assignee when user not found", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, assignee: null },
        },
      });
      // User lookup returns empty
      mockLinearAPI({ users: { nodes: [] } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "Unknown" },
        project,
      );
      expect(issue.assignee).toBeUndefined();
      // Only 2 calls: create + user lookup (no update since user not found)
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("adds labels after creation", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, labels: { nodes: [] } },
        },
      });
      // Label lookup
      mockLinearAPI({
        issueLabels: {
          nodes: [
            { id: "label-1", name: "bug" },
            { id: "label-2", name: "urgent" },
            { id: "label-3", name: "other" },
          ],
        },
      });
      // issueUpdate to set labels
      mockLinearAPI({ issueUpdate: { success: true } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug", "urgent"] },
        project,
      );
      expect(issue.labels).toEqual(["bug", "urgent"]);

      // Verify label IDs sent
      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.labelIds).toEqual(["label-1", "label-2"]);
    });

    it("only reflects actually-applied labels when some don't exist", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, labels: { nodes: [] } },
        },
      });
      // Only "bug" exists in Linear; "nonexistent" does not
      mockLinearAPI({
        issueLabels: {
          nodes: [{ id: "label-1", name: "bug" }],
        },
      });
      mockLinearAPI({ issueUpdate: { success: true } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug", "nonexistent"] },
        project,
      );
      // Should only include the label that was actually found and applied
      expect(issue.labels).toEqual(["bug"]);
    });

    it("throws when teamId is missing from config", async () => {
      const noTeam: ProjectConfig = {
        ...project,
        tracker: { plugin: "linear" },
      };
      await expect(tracker.createIssue!({ title: "Bug", description: "" }, noTeam)).rejects.toThrow(
        "teamId",
      );
    });

    it("handles assignee error gracefully (best-effort)", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, assignee: null },
        },
      });
      // User lookup fails
      mockLinearError("Internal error");

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "Alice" },
        project,
      );
      // Should still return the issue without assignee
      expect(issue).toMatchObject({ id: "INT-123" });
      expect(issue.assignee).toBeUndefined();
    });

    it("handles label error gracefully (best-effort)", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, labels: { nodes: [] } },
        },
      });
      // Label lookup fails
      mockLinearError("Internal error");

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug"] },
        project,
      );
      // Should still return the issue without labels
      expect(issue).toMatchObject({ id: "INT-123" });
      expect(issue.labels).toEqual([]);
    });
  });

  // ---- createComment -------------------------------------------------------

  describe("createComment", () => {
    it("creates a comment and returns its ID", async () => {
      // 1: resolve identifier to UUID
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2: create comment
      mockLinearAPI({
        commentCreate: {
          success: true,
          comment: {
            id: "comment-1",
            body: "Test comment",
            createdAt: "2024-01-01T00:00:00Z",
          },
        },
      });

      const result = await tracker.createComment!("INT-123", "Test comment", project);
      expect(result.id).toBe("comment-1");
      expect(result.body).toBe("Test comment");
      expect(result.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("supports full markdown in comment body", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI({
        commentCreate: {
          success: true,
          comment: {
            id: "comment-2",
            body: "## Heading\n\n- Item 1\n- Item 2\n\n```js\nconst x = 1;\n```",
            createdAt: "2024-01-01T00:00:00Z",
          },
        },
      });

      const markdownBody = "## Heading\n\n- Item 1\n- Item 2\n\n```js\nconst x = 1;\n```";
      const result = await tracker.createComment!("INT-123", markdownBody, project);
      expect(result.id).toBe("comment-2");

      // Verify the mutation received the markdown body
      const writeCall = requestMock.mock.results[1].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.body).toBe(markdownBody);
    });

    it("handles issue resolution error gracefully (does not throw)", async () => {
      mockLinearError("Issue not found");

      // Should NOT throw — returns empty ID instead
      const result = await tracker.createComment!("INT-999", "Test", project);
      expect(result.id).toBe("");
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("handles commentCreate failure gracefully (does not throw)", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearError("Rate limit exceeded");

      // Should NOT throw — returns empty ID instead
      const result = await tracker.createComment!("INT-123", "Test", project);
      expect(result.id).toBe("");
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("handles success=false response gracefully", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI({
        commentCreate: {
          success: false,
          comment: null,
        },
      });

      const result = await tracker.createComment!("INT-123", "Test", project);
      expect(result.id).toBe("");
    });

    it("sends correct GraphQL mutation", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI({
        commentCreate: {
          success: true,
          comment: { id: "comment-1", body: "Test", createdAt: "2024-01-01T00:00:00Z" },
        },
      });

      await tracker.createComment!("INT-123", "My comment", project);

      // Verify second request (commentCreate) has correct variables
      const writeCall = requestMock.mock.results[1].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.issueId).toBe("uuid-123");
      expect(body.variables.body).toBe("My comment");
      expect(body.query).toContain("commentCreate");
    });
  });

  // ---- linearQuery error handling ----------------------------------------

  describe("linearQuery error handling", () => {
    it("throws on missing LINEAR_API_KEY", async () => {
      delete process.env["LINEAR_API_KEY"];
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow("LINEAR_API_KEY");
    });

    it("throws on GraphQL errors", async () => {
      mockLinearError("You do not have access");
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API error: You do not have access",
      );
    });

    it("throws on HTTP error status", async () => {
      mockHTTPError(401, "Unauthorized");
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API returned HTTP 401",
      );
    });

    it("throws on empty data response", async () => {
      const body = JSON.stringify({ data: null });
      requestMock.mockImplementationOnce(
        (
          _opts: Record<string, unknown>,
          callback: (res: EventEmitter & { statusCode: number }) => void,
        ) => {
          const req = Object.assign(new EventEmitter(), {
            write: vi.fn(),
            end: vi.fn(() => {
              const res = Object.assign(new EventEmitter(), { statusCode: 200 });
              callback(res);
              process.nextTick(() => {
                res.emit("data", Buffer.from(body));
                res.emit("end");
              });
            }),
            destroy: vi.fn(),
            setTimeout: vi.fn(),
          });
          return req;
        },
      );

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API returned no data",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Issue relations
  // ---------------------------------------------------------------------------

  describe("getIssueRelations", () => {
    it("returns outward and inverse relations", async () => {
      mockLinearAPI({
        issue: {
          identifier: "INT-123",
          title: "Fix login bug",
          relations: {
            nodes: [
              {
                id: "rel-1",
                type: "blocks",
                relatedIssue: { identifier: "INT-200", title: "Deploy auth" },
              },
              {
                id: "rel-2",
                type: "related",
                relatedIssue: { identifier: "INT-300", title: "Update docs" },
              },
            ],
          },
          inverseRelations: {
            nodes: [
              {
                id: "rel-3",
                type: "blocks",
                issue: { identifier: "INT-50", title: "Setup DB" },
              },
            ],
          },
        },
      });

      const relations = await tracker.getIssueRelations!("INT-123", project);
      expect(relations).toHaveLength(3);

      // Outward: INT-123 blocks INT-200
      expect(relations[0]).toEqual({
        id: "rel-1",
        type: "blocks",
        from: "INT-123",
        to: "INT-200",
        fromTitle: "Fix login bug",
        toTitle: "Deploy auth",
      });

      // Outward: INT-123 related INT-300
      expect(relations[1]).toEqual({
        id: "rel-2",
        type: "related",
        from: "INT-123",
        to: "INT-300",
        fromTitle: "Fix login bug",
        toTitle: "Update docs",
      });

      // Inverse: INT-50 blocks INT-123
      expect(relations[2]).toEqual({
        id: "rel-3",
        type: "blocks",
        from: "INT-50",
        to: "INT-123",
        fromTitle: "Setup DB",
        toTitle: "Fix login bug",
      });
    });

    it("returns empty array when no relations exist", async () => {
      mockLinearAPI({
        issue: {
          identifier: "INT-123",
          title: "Fix login bug",
          relations: { nodes: [] },
          inverseRelations: { nodes: [] },
        },
      });

      const relations = await tracker.getIssueRelations!("INT-123", project);
      expect(relations).toEqual([]);
    });

    it("maps 'similar' type to 'related'", async () => {
      mockLinearAPI({
        issue: {
          identifier: "INT-123",
          title: "Fix login bug",
          relations: {
            nodes: [
              {
                id: "rel-1",
                type: "similar",
                relatedIssue: { identifier: "INT-456", title: "Similar issue" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      });

      const relations = await tracker.getIssueRelations!("INT-123", project);
      expect(relations).toHaveLength(1);
      expect(relations[0].type).toBe("related");
    });

    it("skips unknown relation types", async () => {
      mockLinearAPI({
        issue: {
          identifier: "INT-123",
          title: "Fix login bug",
          relations: {
            nodes: [
              {
                id: "rel-1",
                type: "unknown_future_type",
                relatedIssue: { identifier: "INT-456", title: "Other" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      });

      const relations = await tracker.getIssueRelations!("INT-123", project);
      expect(relations).toEqual([]);
    });

    it("handles duplicate relation type", async () => {
      mockLinearAPI({
        issue: {
          identifier: "INT-123",
          title: "Fix login bug",
          relations: {
            nodes: [
              {
                id: "rel-1",
                type: "duplicate",
                relatedIssue: { identifier: "INT-456", title: "Same bug" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      });

      const relations = await tracker.getIssueRelations!("INT-123", project);
      expect(relations).toHaveLength(1);
      expect(relations[0].type).toBe("duplicate");
    });
  });

  describe("createIssueRelation", () => {
    it("creates a blocks relation", async () => {
      mockLinearAPI({
        issueRelationCreate: {
          success: true,
          issueRelation: {
            id: "rel-new-1",
            type: "blocks",
            issue: { identifier: "INT-123", title: "Fix login" },
            relatedIssue: { identifier: "INT-456", title: "Deploy" },
          },
        },
      });

      const rel = await tracker.createIssueRelation!("INT-123", "INT-456", "blocks", project);

      expect(rel).toEqual({
        id: "rel-new-1",
        type: "blocks",
        from: "INT-123",
        to: "INT-456",
        fromTitle: "Fix login",
        toTitle: "Deploy",
      });
    });

    it("creates a related relation", async () => {
      mockLinearAPI({
        issueRelationCreate: {
          success: true,
          issueRelation: {
            id: "rel-new-2",
            type: "related",
            issue: { identifier: "INT-100", title: "Auth" },
            relatedIssue: { identifier: "INT-200", title: "Docs" },
          },
        },
      });

      const rel = await tracker.createIssueRelation!("INT-100", "INT-200", "related", project);
      expect(rel.type).toBe("related");
      expect(rel.from).toBe("INT-100");
      expect(rel.to).toBe("INT-200");
    });

    it("sends mutation with correct issueId and relatedIssueId", async () => {
      mockLinearAPI({
        issueRelationCreate: {
          success: true,
          issueRelation: {
            id: "rel-1",
            type: "duplicate",
            issue: { identifier: "INT-10", title: "Original" },
            relatedIssue: { identifier: "INT-20", title: "Dup" },
          },
        },
      });

      const rel = await tracker.createIssueRelation!("INT-10", "INT-20", "duplicate", project);

      expect(rel.id).toBe("rel-1");
      expect(rel.type).toBe("duplicate");
      expect(rel.from).toBe("INT-10");
      expect(rel.to).toBe("INT-20");
      expect(requestMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteIssueRelation", () => {
    it("deletes a relation by ID", async () => {
      mockLinearAPI({
        issueRelationDelete: {
          success: true,
        },
      });

      await expect(
        tracker.deleteIssueRelation!("rel-to-delete", project),
      ).resolves.toBeUndefined();
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("propagates errors", async () => {
      mockLinearError("Relation not found");

      await expect(
        tracker.deleteIssueRelation!("bad-id", project),
      ).rejects.toThrow("Relation not found");
    });
  });

  // ---------------------------------------------------------------------------
  // searchIssues
  // ---------------------------------------------------------------------------

  describe("searchIssues", () => {
    it("returns matching issues from full-text search", async () => {
      mockLinearAPI({
        issueSearch: {
          nodes: [sampleIssueNode],
        },
      });

      const results = await tracker.searchIssues!("login bug", project);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: "INT-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://linear.app/acme/issue/INT-123",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "Alice",
        priority: 2,
      });
    });

    it("returns empty array when no matches", async () => {
      mockLinearAPI({
        issueSearch: { nodes: [] },
      });

      const results = await tracker.searchIssues!("nonexistent query", project);
      expect(results).toEqual([]);
    });

    it("respects limit option", async () => {
      mockLinearAPI({
        issueSearch: { nodes: [sampleIssueNode] },
      });

      const results = await tracker.searchIssues!("test", project, { limit: 5 });
      expect(results).toHaveLength(1);
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("filters by team when teamId is in project config", async () => {
      mockLinearAPI({
        issueSearch: { nodes: [sampleIssueNode] },
      });

      await tracker.searchIssues!("auth", project);
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("excludes completed/canceled by default", async () => {
      mockLinearAPI({
        issueSearch: { nodes: [] },
      });

      await tracker.searchIssues!("closed stuff", project);
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("includes archived when option is set", async () => {
      mockLinearAPI({
        issueSearch: { nodes: [sampleIssueNode] },
      });

      await tracker.searchIssues!("old issue", project, { includeArchived: true });
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("handles multiple results", async () => {
      const secondIssue = {
        ...sampleIssueNode,
        id: "uuid-456",
        identifier: "INT-456",
        title: "Another login issue",
        url: "https://linear.app/acme/issue/INT-456",
      };

      mockLinearAPI({
        issueSearch: {
          nodes: [sampleIssueNode, secondIssue],
        },
      });

      const results = await tracker.searchIssues!("login", project);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("INT-123");
      expect(results[1].id).toBe("INT-456");
    });

    it("propagates API errors", async () => {
      mockLinearError("Search failed");

      await expect(
        tracker.searchIssues!("test", project),
      ).rejects.toThrow("Search failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Retry with exponential backoff
  // ---------------------------------------------------------------------------

  describe("retry with exponential backoff", () => {
    beforeEach(() => {
      // Enable retries with zero delay for fast tests
      setRetryConfig({ maxRetries: 3, baseDelay: 0, maxDelay: 0, jitterFactor: 0 });
    });

    it("retries on HTTP 429 and succeeds on second attempt", async () => {
      // First call: 429 rate limited
      mockHTTPError(429, "rate limited");
      // Second call: success
      mockLinearAPI({ issue: sampleIssueNode });

      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.id).toBe("INT-123");
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("retries on HTTP 500 server error", async () => {
      // First call: 500
      mockHTTPError(500, "Internal Server Error");
      // Second call: success
      mockLinearAPI({ issue: sampleIssueNode });

      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.id).toBe("INT-123");
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("retries on HTTP 502 bad gateway", async () => {
      mockHTTPError(502, "Bad Gateway");
      mockLinearAPI({ issue: sampleIssueNode });

      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.id).toBe("INT-123");
    });

    it("retries on HTTP 503 service unavailable", async () => {
      mockHTTPError(503, "Service Unavailable");
      mockLinearAPI({ issue: sampleIssueNode });

      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.id).toBe("INT-123");
    });

    it("retries on network errors", async () => {
      // First call: network error
      requestMock.mockImplementationOnce(
        (_opts: Record<string, unknown>, _callback: unknown) => {
          const req = Object.assign(new EventEmitter(), {
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
            setTimeout: vi.fn(),
          });
          process.nextTick(() => req.emit("error", new Error("ECONNRESET")));
          return req;
        },
      );
      // Second call: success
      mockLinearAPI({ issue: sampleIssueNode });

      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.id).toBe("INT-123");
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on HTTP 401 (non-retryable)", async () => {
      mockHTTPError(401, "Unauthorized");

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API returned HTTP 401",
      );
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on HTTP 400 (non-retryable)", async () => {
      mockHTTPError(400, "Bad Request");

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API returned HTTP 400",
      );
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on GraphQL errors (non-retryable)", async () => {
      mockLinearError("Entity not found");

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Entity not found",
      );
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("exhausts retries and throws the last error", async () => {
      // 4 calls: 1 initial + 3 retries, all fail with 500
      mockHTTPError(500, "fail 1");
      mockHTTPError(500, "fail 2");
      mockHTTPError(500, "fail 3");
      mockHTTPError(500, "fail 4");

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API server error (HTTP 500)",
      );
      // 1 initial + 3 retries = 4 total attempts
      expect(requestMock).toHaveBeenCalledTimes(4);
    });

    it("recovers after multiple retries", async () => {
      // Fail twice, succeed on third attempt
      mockHTTPError(500, "fail 1");
      mockHTTPError(502, "fail 2");
      mockLinearAPI({ issue: sampleIssueNode });

      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.id).toBe("INT-123");
      expect(requestMock).toHaveBeenCalledTimes(3);
    });

    it("HTTP 429 produces a RetryableError with retryAfterMs from header", async () => {
      // Mock a 429 with Retry-After header, then succeed
      const body429 = JSON.stringify({ errors: [{ message: "rate limited" }] });
      requestMock.mockImplementationOnce(
        (
          _opts: Record<string, unknown>,
          callback: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void,
        ) => {
          const req = Object.assign(new EventEmitter(), {
            write: vi.fn(),
            end: vi.fn(() => {
              const res = Object.assign(new EventEmitter(), {
                statusCode: 429,
                headers: { "retry-after": "5" },
              });
              callback(res);
              process.nextTick(() => {
                res.emit("data", Buffer.from(body429));
                res.emit("end");
              });
            }),
            destroy: vi.fn(),
            setTimeout: vi.fn(),
          });
          return req;
        },
      );
      // Second call succeeds
      mockLinearAPI({ issue: sampleIssueNode });

      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.id).toBe("INT-123");
    });
  });

  // ---- Webhook Management ------------------------------------------------

  describe("webhook management", () => {
    const sampleWebhookNode = {
      id: "wh-uuid-1",
      url: "https://myserver.com/webhooks/linear",
      enabled: true,
      resourceTypes: ["Issue", "Comment", "IssueLabel"],
      label: "ao-orchestrator",
      createdAt: "2026-03-16T00:00:00.000Z",
      team: { id: "team-uuid-1" },
    };

    describe("createWebhook", () => {
      it("creates a webhook with default resource types", async () => {
        mockLinearAPI({
          webhookCreate: {
            success: true,
            webhook: sampleWebhookNode,
          },
        });

        const result = await tracker.createWebhook!(
          { url: "https://myserver.com/webhooks/linear" },
          project,
        );

        expect(result).toEqual({
          id: "wh-uuid-1",
          url: "https://myserver.com/webhooks/linear",
          enabled: true,
          resourceTypes: ["Issue", "Comment", "IssueLabel"],
          teamId: "team-uuid-1",
          label: "ao-orchestrator",
          createdAt: "2026-03-16T00:00:00.000Z",
        });
      });

      it("passes custom resource types and label", async () => {
        mockLinearAPI({
          webhookCreate: {
            success: true,
            webhook: {
              ...sampleWebhookNode,
              resourceTypes: ["Issue", "Project"],
              label: "custom-label",
            },
          },
        });

        const result = await tracker.createWebhook!(
          {
            url: "https://myserver.com/webhooks/linear",
            resourceTypes: ["Issue", "Project"],
            label: "custom-label",
          },
          project,
        );

        expect(result.resourceTypes).toEqual(["Issue", "Project"]);
        expect(result.label).toBe("custom-label");
      });

      it("uses teamId from project config when not provided", async () => {
        mockLinearAPI({
          webhookCreate: {
            success: true,
            webhook: sampleWebhookNode,
          },
        });

        await tracker.createWebhook!(
          { url: "https://myserver.com/webhooks/linear" },
          project,
        );

        // Verify the mutation was called (request was made)
        expect(requestMock).toHaveBeenCalledTimes(1);
        // Verify the request body includes teamId
        const call = requestMock.mock.calls[0];
        const req = call[1]; // callback
        // The write fn receives the body
        const returnedReq = requestMock.mock.results[0].value;
        const writeCall = returnedReq.write.mock.calls[0][0] as string;
        const parsed = JSON.parse(writeCall);
        expect(parsed.variables.input.teamId).toBe("team-uuid-1");
      });

      it("allows explicit teamId override", async () => {
        mockLinearAPI({
          webhookCreate: {
            success: true,
            webhook: {
              ...sampleWebhookNode,
              team: { id: "other-team" },
            },
          },
        });

        const result = await tracker.createWebhook!(
          {
            url: "https://myserver.com/webhooks/linear",
            teamId: "other-team",
          },
          project,
        );

        expect(result.teamId).toBe("other-team");
      });

      it("creates global webhook when no teamId", async () => {
        mockLinearAPI({
          webhookCreate: {
            success: true,
            webhook: {
              ...sampleWebhookNode,
              team: null,
            },
          },
        });

        const projectNoTeam: ProjectConfig = {
          ...project,
          tracker: { plugin: "linear" },
        };

        const result = await tracker.createWebhook!(
          { url: "https://myserver.com/webhooks/linear" },
          projectNoTeam,
        );

        expect(result.teamId).toBeUndefined();
      });

      it("includes secret when provided", async () => {
        mockLinearAPI({
          webhookCreate: {
            success: true,
            webhook: sampleWebhookNode,
          },
        });

        await tracker.createWebhook!(
          {
            url: "https://myserver.com/webhooks/linear",
            secret: "my-signing-secret",
          },
          project,
        );

        const returnedReq = requestMock.mock.results[0].value;
        const writeCall = returnedReq.write.mock.calls[0][0] as string;
        const parsed = JSON.parse(writeCall);
        expect(parsed.variables.input.secret).toBe("my-signing-secret");
      });

      it("throws on GraphQL error", async () => {
        mockLinearError("Insufficient permissions");

        await expect(
          tracker.createWebhook!(
            { url: "https://myserver.com/webhooks/linear" },
            project,
          ),
        ).rejects.toThrow("Insufficient permissions");
      });
    });

    describe("deleteWebhook", () => {
      it("deletes a webhook by ID", async () => {
        mockLinearAPI({
          webhookDelete: { success: true },
        });

        await expect(
          tracker.deleteWebhook!("wh-uuid-1", project),
        ).resolves.toBeUndefined();

        expect(requestMock).toHaveBeenCalledTimes(1);
      });

      it("sends correct mutation variables", async () => {
        mockLinearAPI({
          webhookDelete: { success: true },
        });

        await tracker.deleteWebhook!("wh-uuid-99", project);

        const returnedReq = requestMock.mock.results[0].value;
        const writeCall = returnedReq.write.mock.calls[0][0] as string;
        const parsed = JSON.parse(writeCall);
        expect(parsed.variables.id).toBe("wh-uuid-99");
      });

      it("throws on GraphQL error", async () => {
        mockLinearError("Webhook not found");

        await expect(
          tracker.deleteWebhook!("wh-nonexistent", project),
        ).rejects.toThrow("Webhook not found");
      });
    });

    describe("listWebhooks", () => {
      it("returns all webhooks for the team", async () => {
        mockLinearAPI({
          webhooks: {
            nodes: [
              sampleWebhookNode,
              {
                ...sampleWebhookNode,
                id: "wh-uuid-2",
                url: "https://other.com/hook",
                label: "other-service",
              },
            ],
          },
        });

        const result = await tracker.listWebhooks!(project);

        expect(result).toHaveLength(2);
        expect(result[0].id).toBe("wh-uuid-1");
        expect(result[1].id).toBe("wh-uuid-2");
      });

      it("filters webhooks by team when teamId in project config", async () => {
        mockLinearAPI({
          webhooks: {
            nodes: [
              sampleWebhookNode, // team-uuid-1 — matches
              {
                ...sampleWebhookNode,
                id: "wh-uuid-other",
                team: { id: "other-team-uuid" }, // different team
              },
              {
                ...sampleWebhookNode,
                id: "wh-uuid-global",
                team: null, // global webhook — included
              },
            ],
          },
        });

        const result = await tracker.listWebhooks!(project);

        expect(result).toHaveLength(2);
        expect(result.map((w) => w.id)).toEqual(["wh-uuid-1", "wh-uuid-global"]);
      });

      it("returns all webhooks when no teamId", async () => {
        mockLinearAPI({
          webhooks: {
            nodes: [
              sampleWebhookNode,
              {
                ...sampleWebhookNode,
                id: "wh-uuid-other",
                team: { id: "other-team-uuid" },
              },
            ],
          },
        });

        const projectNoTeam: ProjectConfig = {
          ...project,
          tracker: { plugin: "linear" },
        };

        const result = await tracker.listWebhooks!(projectNoTeam);

        expect(result).toHaveLength(2);
      });

      it("handles empty webhook list", async () => {
        mockLinearAPI({
          webhooks: { nodes: [] },
        });

        const result = await tracker.listWebhooks!(project);

        expect(result).toHaveLength(0);
      });

      it("maps webhook fields correctly", async () => {
        mockLinearAPI({
          webhooks: {
            nodes: [
              {
                id: "wh-mapped",
                url: "https://test.com/hook",
                enabled: false,
                resourceTypes: ["Issue"],
                label: "test-label",
                createdAt: "2026-01-01T00:00:00.000Z",
                team: null,
              },
            ],
          },
        });

        const result = await tracker.listWebhooks!(project);

        expect(result[0]).toEqual({
          id: "wh-mapped",
          url: "https://test.com/hook",
          enabled: false,
          resourceTypes: ["Issue"],
          teamId: undefined,
          label: "test-label",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      });

      it("throws on GraphQL error", async () => {
        mockLinearError("Rate limited");

        await expect(tracker.listWebhooks!(project)).rejects.toThrow(
          "Rate limited",
        );
      });
    });
  });
});
