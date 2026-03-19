/**
 * Linear Actions — Handle human decisions from Linear webhooks.
 *
 * This module processes Linear events that represent human decisions:
 * - Merge trigger: when issue status changes to a "done" state, auto-merge the PR
 * - Comment forwarding: when a human comments on a Linear issue, forward to active agent
 *
 * Configuration in agent-orchestrator.yaml:
 * ```yaml
 * linear:
 *   mergeTrigger:
 *     enabled: true
 *     triggerStatus: "Done"
 *     mergeMethod: squash
 *   commentForwarding:
 *     enabled: true
 * ```
 */

import {
  TERMINAL_STATUSES,
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
  type ProjectConfig,
  type SCM,
  type LinearActionResult,
  type MergeMethod,
} from "./types.js";
import type { LinearIssueContext } from "./auto-spawn.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeTriggerConfig {
  enabled: boolean;
  triggerStatuses: string[];
  mergeMethod: MergeMethod;
}

export interface LinearActionsDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
}

export interface LinearCommentContext {
  id: string;
  body: string;
  issueId: string;
  user?: {
    id: string;
    name: string;
    isMe?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getMergeTriggerConfig(
  config: OrchestratorConfig,
  project?: ProjectConfig,
): MergeTriggerConfig {
  const globalMergeTrigger = config.linear?.mergeTrigger ?? {};

  // Project-level overrides
  const trackerConfig = (project?.tracker as Record<string, unknown> | undefined) ?? {};
  const projectMergeTrigger = (trackerConfig["mergeTrigger"] as Record<string, unknown> | undefined) ?? {};

  const enabled =
    (projectMergeTrigger["enabled"] as boolean | undefined) ??
    globalMergeTrigger.enabled ??
    false;

  const triggerStatus =
    (projectMergeTrigger["triggerStatus"] as string | string[] | undefined) ??
    globalMergeTrigger.triggerStatus ??
    "Done";

  let triggerStatuses: string[];
  if (Array.isArray(triggerStatus)) {
    triggerStatuses = triggerStatus.map((s) => s.toLowerCase());
  } else if (typeof triggerStatus === "string") {
    triggerStatuses = [triggerStatus.toLowerCase()];
  } else {
    triggerStatuses = ["done"];
  }

  const mergeMethod =
    (projectMergeTrigger["mergeMethod"] as MergeMethod | undefined) ??
    globalMergeTrigger.mergeMethod ??
    "squash";

  return { enabled, triggerStatuses, mergeMethod };
}

function isCommentForwardingEnabled(
  config: OrchestratorConfig,
  project?: ProjectConfig,
): boolean {
  const trackerConfig = (project?.tracker as Record<string, unknown> | undefined) ?? {};
  const projectForwarding = (trackerConfig["commentForwarding"] as Record<string, unknown> | undefined) ?? {};

  return (
    (projectForwarding["enabled"] as boolean | undefined) ??
    config.linear?.commentForwarding?.enabled ??
    false
  );
}

// ---------------------------------------------------------------------------
// Merge trigger handler
// ---------------------------------------------------------------------------

/**
 * Handle a Linear issue status change that might trigger a PR merge.
 *
 * When a human changes the issue status to a "merge trigger" status (e.g., "Done"),
 * find the associated session and merge its PR.
 *
 * Loop prevention: if the session is already in a terminal state (merged, killed, done),
 * the merge is skipped. This prevents infinite loops when the orchestrator's own
 * merge completion event updates the issue status back to "Done".
 */
export async function handleMergeTrigger(
  issue: LinearIssueContext,
  deps: LinearActionsDeps,
  sessionManager: SessionManager,
): Promise<LinearActionResult> {
  const { config, registry } = deps;

  // Find the project for this issue (reuse auto-spawn's project resolution)
  const projectMatch = findProjectForIssue(issue, config);
  if (!projectMatch) {
    return { action: "skipped", reason: "no matching project found" };
  }

  const { projectId, project } = projectMatch;

  // Check if merge trigger is enabled
  const mergeTriggerConfig = getMergeTriggerConfig(config, project);
  if (!mergeTriggerConfig.enabled) {
    return { action: "skipped", reason: "merge trigger disabled" };
  }

  // Check if the status is a trigger status
  const statusName = issue.statusName?.toLowerCase() ?? "";
  const isTrigger = mergeTriggerConfig.triggerStatuses.some(
    (trigger) => statusName === trigger || statusName.includes(trigger),
  );

  if (!isTrigger) {
    return {
      action: "skipped",
      reason: "status is not a merge trigger",
      details: { statusName: issue.statusName, triggers: mergeTriggerConfig.triggerStatuses },
    };
  }

  // Find active session for this issue
  const sessions = await sessionManager.list();
  const session = sessions.find(
    (s) => s.issueId === issue.identifier && s.projectId === projectId,
  );

  if (!session) {
    return {
      action: "skipped",
      reason: "no session found for issue",
      details: { issueId: issue.identifier },
    };
  }

  // Loop prevention: skip if session is already in a terminal state
  if (TERMINAL_STATUSES.has(session.status)) {
    return {
      action: "skipped",
      reason: "session already in terminal state",
      details: { sessionId: session.id, status: session.status },
    };
  }

  // Also skip if already merged or merging
  if (session.status === "merged" || session.status === "mergeable") {
    return {
      action: "skipped",
      reason: `session already ${session.status}`,
      details: { sessionId: session.id },
    };
  }

  // Check if session has a PR
  if (!session.pr) {
    return {
      action: "skipped",
      reason: "session has no PR",
      details: { sessionId: session.id },
    };
  }

  // Get SCM plugin
  const scm = registry.get<SCM>("scm", project.scm?.plugin ?? "github");
  if (!scm) {
    return { action: "failed", reason: "no SCM plugin available" };
  }

  // Check PR state
  try {
    const prState = await scm.getPRState(session.pr);
    if (prState !== "open") {
      return {
        action: "skipped",
        reason: `PR is ${prState}, not open`,
        details: { prNumber: session.pr.number },
      };
    }

    // Check mergeability
    const mergeability = await scm.getMergeability(session.pr);
    if (!mergeability.mergeable) {
      console.log(
        `[linear-actions] PR #${session.pr.number} not mergeable: ${mergeability.blockers.join(", ")}`,
      );
      return {
        action: "failed",
        reason: "PR is not mergeable",
        details: {
          prNumber: session.pr.number,
          blockers: mergeability.blockers,
        },
      };
    }

    // Merge the PR
    await scm.mergePR(session.pr, mergeTriggerConfig.mergeMethod);

    console.log(
      `[linear-actions] Merged PR #${session.pr.number} (${mergeTriggerConfig.mergeMethod}) triggered by Linear issue ${issue.identifier}`,
    );

    return {
      action: "merged",
      reason: "merge triggered by Linear status change",
      details: {
        prNumber: session.pr.number,
        mergeMethod: mergeTriggerConfig.mergeMethod,
        issueId: issue.identifier,
        triggerStatus: issue.statusName,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[linear-actions] Merge failed for PR #${session.pr.number}: ${errorMsg}`);
    return {
      action: "failed",
      reason: `merge failed: ${errorMsg}`,
      details: { prNumber: session.pr.number },
    };
  }
}

// ---------------------------------------------------------------------------
// Comment forwarding handler
// ---------------------------------------------------------------------------

/**
 * Forward a human comment from a Linear issue to the active agent session.
 *
 * Skips bot comments (already filtered upstream) and forwards the text
 * to the agent via sessionManager.send().
 */
export async function handleCommentForward(
  comment: LinearCommentContext,
  issueIdentifier: string,
  deps: LinearActionsDeps,
  sessionManager: SessionManager,
): Promise<LinearActionResult> {
  const { config } = deps;

  // Find project for this issue — we need to resolve the identifier from the issueId
  // The webhook gives us the issue UUID, but sessions store the identifier (e.g., "PRO-123")
  // We'll search all sessions for a match
  const sessions = await sessionManager.list();
  const session = sessions.find(
    (s) => s.issueId === issueIdentifier && !TERMINAL_STATUSES.has(s.status),
  );

  if (!session) {
    return {
      action: "skipped",
      reason: "no active session found for issue",
      details: { issueIdentifier },
    };
  }

  // Check if comment forwarding is enabled for this project
  const project = config.projects[session.projectId];
  if (!project || !isCommentForwardingEnabled(config, project)) {
    return {
      action: "skipped",
      reason: "comment forwarding disabled",
      details: { projectId: session.projectId },
    };
  }

  // Forward the comment to the agent
  const userName = comment.user?.name ?? "Unknown";
  const message = `[Linear comment from ${userName}]: ${comment.body}`;

  try {
    await sessionManager.send(session.id, message);

    console.log(
      `[linear-actions] Forwarded comment to session ${session.id} (issue ${issueIdentifier})`,
    );

    return {
      action: "forwarded",
      reason: "comment forwarded to agent",
      details: {
        sessionId: session.id,
        issueIdentifier,
        commentUser: userName,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[linear-actions] Failed to forward comment to session ${session.id}: ${errorMsg}`,
    );
    return {
      action: "failed",
      reason: `forward failed: ${errorMsg}`,
      details: { sessionId: session.id },
    };
  }
}

// ---------------------------------------------------------------------------
// Project resolution (shared with auto-spawn)
// ---------------------------------------------------------------------------

function findProjectForIssue(
  issue: LinearIssueContext,
  config: OrchestratorConfig,
): { projectId: string; project: ProjectConfig } | null {
  // Try team key from issue context
  if (issue.teamKey) {
    const match = findProjectForTeam(issue.teamKey, config);
    if (match) return match;
  }

  // Try extracting team key from identifier (e.g., "PRO-123" → "PRO")
  const identifierMatch = issue.identifier.match(/^([A-Z]+)-\d+$/);
  if (identifierMatch) {
    const teamKey = identifierMatch[1];
    const match = findProjectForTeam(teamKey, config);
    if (match) return match;
  }

  // Try team name
  if (issue.teamName) {
    const match = findProjectForTeam(issue.teamName, config);
    if (match) return match;
  }

  return null;
}

function findProjectForTeam(
  teamKey: string,
  config: OrchestratorConfig,
): { projectId: string; project: ProjectConfig } | null {
  for (const [projectId, project] of Object.entries(config.projects)) {
    if (project.tracker?.plugin !== "linear") continue;

    const trackerConfig = project.tracker as Record<string, unknown>;
    const configTeamKey = trackerConfig["teamKey"] as string | undefined;
    if (configTeamKey?.toLowerCase() === teamKey.toLowerCase()) {
      return { projectId, project };
    }

    const configTeam = trackerConfig["team"] as string | undefined;
    if (configTeam?.toLowerCase() === teamKey.toLowerCase()) {
      return { projectId, project };
    }
  }
  return null;
}
