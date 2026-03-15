/**
 * Linear Reporter — Reports orchestrator events to Linear issues.
 *
 * For Linear-first workflows, this module posts comments and updates
 * issue statuses in Linear based on orchestrator events.
 *
 * Events handled:
 * - session.spawned → comment + status "In Progress"
 * - session.working → comment when transitioning from spawn
 * - ci.failing → comment with CI failure info
 * - pr.created → comment with PR link + status "In Review"
 * - pr.merged / merge.completed → comment + status "Done"
 *
 * Configuration in agent-orchestrator.yaml:
 * ```yaml
 * linear:
 *   comments:
 *     enabled: true
 *     prefix: "🤖"
 *   statusMapping:
 *     agent-spawned: "In Progress"
 *     pr-created: "In Review"
 *     pr-merged: "Done"
 * ```
 */

import type {
  OrchestratorConfig,
  OrchestratorEvent,
  PluginRegistry,
  Tracker,
  ProjectConfig,
  EventType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinearReporterConfig {
  /** Whether commenting is enabled */
  commentsEnabled: boolean;
  /** Prefix for all comments (e.g., "🤖") */
  commentPrefix: string;
  /** Whether status updates are enabled */
  statusUpdatesEnabled: boolean;
  /** Mapping from event type to Linear status name */
  statusMapping: Record<string, string>;
}

export interface LinearReporterDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
}

export interface LinearReporter {
  /**
   * Report an orchestrator event to Linear.
   * Posts a comment and/or updates issue status based on configuration.
   */
  reportEvent(event: OrchestratorEvent, issueId: string, project: ProjectConfig): Promise<void>;

  /**
   * Check if Linear reporting is enabled for a project.
   */
  isEnabled(project: ProjectConfig): boolean;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_STATUS_MAPPING: Record<string, string> = {
  "session.spawned": "In Progress",
  "session.working": "In Progress",
  "pr.created": "In Review",
  "pr.merged": "Done",
  "merge.completed": "Done",
};

const DEFAULT_COMMENT_PREFIX = "🤖";

// ---------------------------------------------------------------------------
// Event to comment message mapping
// ---------------------------------------------------------------------------

function formatCommentForEvent(
  event: OrchestratorEvent,
  prefix: string,
): string | null {
  const timestamp = event.timestamp.toISOString().slice(0, 19).replace("T", " ");

  switch (event.type) {
    case "session.spawned":
      return `${prefix} **Agent spawned** (${timestamp})\n\nSession \`${event.sessionId}\` started working on this issue.`;

    case "session.working":
      return `${prefix} **Agent working** (${timestamp})\n\nSession \`${event.sessionId}\` is actively processing.`;

    case "pr.created": {
      const prUrl = event.data["prUrl"] as string | undefined;
      const prTitle = event.data["prTitle"] as string | undefined;
      if (prUrl) {
        return `${prefix} **Pull Request created** (${timestamp})\n\n${prTitle ? `**${prTitle}**\n\n` : ""}[View PR](${prUrl})`;
      }
      return `${prefix} **Pull Request created** (${timestamp})\n\nSession \`${event.sessionId}\` created a PR.`;
    }

    case "ci.failing": {
      const failedChecks = event.data["failedChecks"] as string[] | undefined;
      let msg = `${prefix} **CI Failed** (${timestamp})\n\nSession \`${event.sessionId}\` encountered CI failures.`;
      if (failedChecks && failedChecks.length > 0) {
        msg += `\n\n**Failed checks:**\n${failedChecks.map((c) => `- ${c}`).join("\n")}`;
      }
      return msg;
    }

    case "review.changes_requested": {
      const reviewer = event.data["reviewer"] as string | undefined;
      let msg = `${prefix} **Changes requested** (${timestamp})`;
      if (reviewer) {
        msg += `\n\nReviewer **${reviewer}** requested changes.`;
      }
      return msg;
    }

    case "review.approved": {
      const reviewer = event.data["reviewer"] as string | undefined;
      let msg = `${prefix} **PR Approved** (${timestamp})`;
      if (reviewer) {
        msg += `\n\nApproved by **${reviewer}**.`;
      }
      return msg;
    }

    case "merge.ready":
      return `${prefix} **Ready to merge** (${timestamp})\n\nAll checks passed and PR is approved.`;

    case "pr.merged":
    case "merge.completed": {
      const prUrl = event.data["prUrl"] as string | undefined;
      let msg = `${prefix} **PR Merged** (${timestamp})\n\nWork completed successfully.`;
      if (prUrl) {
        msg += `\n\n[View merged PR](${prUrl})`;
      }
      return msg;
    }

    case "session.stuck":
      return `${prefix} **⚠️ Agent stuck** (${timestamp})\n\nSession \`${event.sessionId}\` appears to be stuck and may need attention.`;

    case "session.needs_input":
      return `${prefix} **⏸️ Waiting for input** (${timestamp})\n\nSession \`${event.sessionId}\` is waiting for human input.`;

    case "session.errored": {
      const errorMsg = event.data["error"] as string | undefined;
      let msg = `${prefix} **❌ Session error** (${timestamp})`;
      if (errorMsg) {
        msg += `\n\n\`\`\`\n${errorMsg.slice(0, 500)}\n\`\`\``;
      }
      return msg;
    }

    case "session.killed":
      return `${prefix} **Session terminated** (${timestamp})\n\nSession \`${event.sessionId}\` was terminated.`;

    default:
      // Don't comment on unknown event types
      return null;
  }
}

// ---------------------------------------------------------------------------
// Events that should trigger status updates
// ---------------------------------------------------------------------------

const STATUS_UPDATE_EVENTS: Set<EventType> = new Set([
  "session.spawned",
  "session.working",
  "pr.created",
  "pr.merged",
  "merge.completed",
]);

// ---------------------------------------------------------------------------
// LinearReporter factory
// ---------------------------------------------------------------------------

export function createLinearReporter(deps: LinearReporterDeps): LinearReporter {
  const { config, registry } = deps;

  /**
   * Extract Linear reporter configuration from project config.
   * Note: Global linear config will be added in Phase 5 when YAML schema is extended.
   */
  function getReporterConfig(project: ProjectConfig): LinearReporterConfig {
    // Check for linear-specific config in project tracker config
    const linearConfig = (project.tracker as Record<string, unknown> | undefined) ?? {};

    // Extract nested configurations
    const commentsConfig = (linearConfig["comments"] ?? {}) as Record<string, unknown>;
    const statusConfig = (linearConfig["statusMapping"] ?? {}) as Record<string, string>;

    return {
      commentsEnabled: (commentsConfig["enabled"] as boolean | undefined) ?? true,
      commentPrefix: (commentsConfig["prefix"] as string | undefined) ?? DEFAULT_COMMENT_PREFIX,
      statusUpdatesEnabled: (linearConfig["statusUpdates"] as boolean | undefined) ?? true,
      statusMapping: { ...DEFAULT_STATUS_MAPPING, ...statusConfig },
    };
  }

  /**
   * Get the Linear tracker plugin if available.
   */
  function getLinearTracker(project: ProjectConfig): Tracker | null {
    const trackerPlugin = project.tracker?.plugin;
    if (trackerPlugin !== "linear") {
      return null;
    }
    return registry.get<Tracker>("tracker", "linear");
  }

  return {
    isEnabled(project: ProjectConfig): boolean {
      return project.tracker?.plugin === "linear";
    },

    async reportEvent(
      event: OrchestratorEvent,
      issueId: string,
      project: ProjectConfig,
    ): Promise<void> {
      const tracker = getLinearTracker(project);
      if (!tracker) {
        return;
      }

      const reporterConfig = getReporterConfig(project);

      // Post comment if enabled
      if (reporterConfig.commentsEnabled && tracker.createComment) {
        const commentBody = formatCommentForEvent(event, reporterConfig.commentPrefix);
        if (commentBody) {
          try {
            await tracker.createComment(issueId, commentBody, project);
          } catch (err) {
            // Log but don't fail — reporting is best-effort
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[linear-reporter] Failed to post comment to ${issueId}: ${msg}`);
          }
        }
      }

      // Update status if enabled and this event type triggers status updates
      if (
        reporterConfig.statusUpdatesEnabled &&
        STATUS_UPDATE_EVENTS.has(event.type) &&
        tracker.updateIssueStatus
      ) {
        const targetStatus = reporterConfig.statusMapping[event.type];
        if (targetStatus) {
          try {
            await tracker.updateIssueStatus(issueId, targetStatus, project);
          } catch (err) {
            // Log but don't fail — reporting is best-effort
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[linear-reporter] Failed to update status to "${targetStatus}" for ${issueId}: ${msg}`,
            );
          }
        }
      }
    },
  };
}
