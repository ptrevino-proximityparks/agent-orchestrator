/**
 * AutoSpawn Handler — Automatic agent spawning from Linear webhooks.
 *
 * This module handles the logic for automatically spawning agent sessions
 * when Linear issues transition to trigger statuses (e.g., "Todo").
 *
 * Key features:
 * - Project resolution from Linear team/issue data
 * - Duplicate session prevention
 * - Configurable trigger statuses
 * - Loop prevention for bot-generated events
 *
 * Configuration in agent-orchestrator.yaml:
 * ```yaml
 * linear:
 *   autoSpawn:
 *     enabled: true
 *     triggerStatus: Todo
 * ```
 */

import {
  type OrchestratorConfig,
  type ProjectConfig,
  type SessionManager,
  type Session,
  TERMINAL_STATUSES,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoSpawnConfig {
  /** Whether auto-spawn is enabled */
  enabled: boolean;
  /** Status names that trigger auto-spawn (case-insensitive) */
  triggerStatuses: string[];
}

export interface LinearIssueContext {
  /** Linear issue UUID */
  id: string;
  /** Linear issue identifier (e.g., "INT-1327") */
  identifier: string;
  /** Issue title */
  title: string;
  /** Issue description */
  description?: string;
  /** Current status name */
  statusName?: string;
  /** Status type (backlog, unstarted, started, completed, canceled) */
  statusType?: string;
  /** Team key (e.g., "INT") */
  teamKey?: string;
  /** Team name */
  teamName?: string;
  /** Assignee info */
  assignee?: {
    id: string;
    name: string;
  };
  /** Labels */
  labels?: string[];
}

export interface AutoSpawnResult {
  /** What action was taken */
  action: "spawned" | "skipped" | "ignored" | "error";
  /** Reason for the action */
  reason: string;
  /** Spawned session (if action is "spawned") */
  session?: Session;
  /** Additional context */
  details?: Record<string, unknown>;
}

export interface AutoSpawnHandler {
  /**
   * Check if auto-spawn is enabled for any project.
   */
  isEnabled(): boolean;

  /**
   * Process an issue status change and potentially spawn an agent.
   */
  handleIssueStatusChange(
    issue: LinearIssueContext,
    sessionManager: SessionManager,
  ): Promise<AutoSpawnResult>;

  /**
   * Find the project that should handle a Linear issue.
   */
  findProjectForIssue(
    issue: LinearIssueContext,
  ): { projectId: string; project: ProjectConfig } | null;
}

export interface AutoSpawnHandlerDeps {
  config: OrchestratorConfig;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_TRIGGER_STATUSES = ["todo", "ready", "ready to start"];

// ---------------------------------------------------------------------------
// Bot detection patterns
// ---------------------------------------------------------------------------

/** Comment body prefixes that indicate bot-generated content */
const BOT_COMMENT_PREFIXES = ["🤖", "[bot]", "[ao]", "[agent]", "[automated]"];

/**
 * Check if a comment body appears to be bot-generated.
 */
export function isBotGeneratedComment(body: string): boolean {
  const trimmed = body.trim().toLowerCase();
  return BOT_COMMENT_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// AutoSpawn factory
// ---------------------------------------------------------------------------

export function createAutoSpawnHandler(deps: AutoSpawnHandlerDeps): AutoSpawnHandler {
  const { config } = deps;

  /**
   * Get AutoSpawn configuration, merging project-level with global defaults.
   */
  function getAutoSpawnConfig(project?: ProjectConfig): AutoSpawnConfig {
    // Check project-level config
    const trackerConfig = (project?.tracker as Record<string, unknown> | undefined) ?? {};
    const autoSpawnConfig = (trackerConfig["autoSpawn"] as Record<string, unknown> | undefined) ?? {};

    // Extract settings with defaults
    const enabled = (autoSpawnConfig["enabled"] as boolean | undefined) ?? true;
    const triggerStatus = autoSpawnConfig["triggerStatus"] as string | string[] | undefined;

    // Normalize trigger statuses to array
    let triggerStatuses: string[];
    if (Array.isArray(triggerStatus)) {
      triggerStatuses = triggerStatus.map((s) => s.toLowerCase());
    } else if (typeof triggerStatus === "string") {
      triggerStatuses = [triggerStatus.toLowerCase()];
    } else {
      triggerStatuses = DEFAULT_TRIGGER_STATUSES;
    }

    return {
      enabled,
      triggerStatuses,
    };
  }

  /**
   * Find a project that's configured for the given Linear team.
   */
  function findProjectForTeam(
    teamKey: string,
  ): { projectId: string; project: ProjectConfig } | null {
    for (const [projectId, project] of Object.entries(config.projects)) {
      if (project.tracker?.plugin !== "linear") {
        continue;
      }

      const trackerConfig = project.tracker as Record<string, unknown>;

      // Match by team key (extracted from issue identifier)
      const configTeamKey = trackerConfig["teamKey"] as string | undefined;
      if (configTeamKey?.toLowerCase() === teamKey.toLowerCase()) {
        return { projectId, project };
      }

      // Match by team name
      const configTeam = trackerConfig["team"] as string | undefined;
      if (configTeam?.toLowerCase() === teamKey.toLowerCase()) {
        return { projectId, project };
      }
    }

    return null;
  }

  return {
    isEnabled(): boolean {
      // Check if any project has auto-spawn enabled
      for (const project of Object.values(config.projects)) {
        if (project.tracker?.plugin !== "linear") {
          continue;
        }

        const autoSpawnConfig = getAutoSpawnConfig(project);
        if (autoSpawnConfig.enabled) {
          return true;
        }
      }

      return false;
    },

    findProjectForIssue(
      issue: LinearIssueContext,
    ): { projectId: string; project: ProjectConfig } | null {
      // Try to find by team key first
      if (issue.teamKey) {
        const match = findProjectForTeam(issue.teamKey);
        if (match) {
          return match;
        }
      }

      // Try to extract team key from identifier (e.g., "INT-1327" → "INT")
      const identifierMatch = issue.identifier.match(/^([A-Z]+)-\d+$/);
      if (identifierMatch) {
        const teamKey = identifierMatch[1];
        const match = findProjectForTeam(teamKey);
        if (match) {
          return match;
        }
      }

      // Try by team name
      if (issue.teamName) {
        const match = findProjectForTeam(issue.teamName);
        if (match) {
          return match;
        }
      }

      return null;
    },

    async handleIssueStatusChange(
      issue: LinearIssueContext,
      sessionManager: SessionManager,
    ): Promise<AutoSpawnResult> {
      // Find the project for this issue
      const projectMatch = this.findProjectForIssue(issue);
      if (!projectMatch) {
        return {
          action: "ignored",
          reason: "no matching project found",
          details: {
            teamKey: issue.teamKey,
            identifier: issue.identifier,
          },
        };
      }

      const { projectId, project } = projectMatch;

      // Check if auto-spawn is enabled for this project
      const autoSpawnConfig = getAutoSpawnConfig(project);
      if (!autoSpawnConfig.enabled) {
        return {
          action: "ignored",
          reason: "auto-spawn disabled for project",
          details: { projectId },
        };
      }

      // Check if the status is a trigger status
      const statusName = issue.statusName?.toLowerCase() ?? "";
      const isTriggerStatus = autoSpawnConfig.triggerStatuses.some(
        (trigger) => statusName === trigger || statusName.includes(trigger),
      );

      if (!isTriggerStatus) {
        return {
          action: "ignored",
          reason: "status is not a spawn trigger",
          details: {
            statusName: issue.statusName,
            triggerStatuses: autoSpawnConfig.triggerStatuses,
          },
        };
      }

      // Check for existing active session
      const existingSessions = await sessionManager.list();
      const activeSession = existingSessions.find(
        (s) =>
          s.issueId === issue.identifier &&
          !TERMINAL_STATUSES.has(s.status),
      );

      if (activeSession) {
        return {
          action: "skipped",
          reason: "active session already exists",
          details: {
            existingSessionId: activeSession.id,
            issueId: issue.identifier,
          },
        };
      }

      // Spawn a new session
      try {
        const session = await sessionManager.spawn({
          projectId,
          issueId: issue.identifier,
        });

        return {
          action: "spawned",
          reason: "auto-spawn triggered by status change",
          session,
          details: {
            projectId,
            issueId: issue.identifier,
            issueTitle: issue.title,
            triggerStatus: issue.statusName,
          },
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          action: "error",
          reason: `spawn failed: ${errorMsg}`,
          details: {
            projectId,
            issueId: issue.identifier,
          },
        };
      }
    },
  };
}
