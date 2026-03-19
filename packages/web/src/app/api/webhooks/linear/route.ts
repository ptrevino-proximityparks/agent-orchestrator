/**
 * POST /api/webhooks/linear
 *
 * Receives Linear webhooks for issue events.
 * Validates signature, parses payload, and triggers appropriate actions.
 *
 * Events handled:
 * - Issue.update with state change to "Todo" → AutoSpawn agent
 * - Issue.update with state change to "Done" → Merge trigger (auto-merge PR)
 * - Comment.create → Forward human comments to active agent
 *
 * CRITICAL: This endpoint must prevent infinite loops.
 * Bot-generated comments have known prefixes that we skip.
 */

import { type NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getServices } from "@/lib/services";
import {
  createAutoSpawnHandler,
  isBotGeneratedComment,
  handleMergeTrigger,
  handleCommentForward,
  type LinearIssueContext,
} from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Types for Linear webhook payloads
// ---------------------------------------------------------------------------

interface LinearWebhookPayload {
  type: string; // "Issue", "Comment", "IssueLabel", etc.
  action: string; // "create", "update", "remove"
  createdAt: string;
  data: LinearIssueData | LinearCommentData | Record<string, unknown>;
  url?: string;
  organizationId?: string;
  webhookId?: string;
  webhookTimestamp?: number;
}

interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority?: number;
  state?: {
    id: string;
    name: string;
    type: string; // "backlog", "unstarted", "started", "completed", "canceled"
  };
  team?: {
    id: string;
    key: string;
    name: string;
  };
  assignee?: {
    id: string;
    name: string;
    email?: string;
  };
  labels?: Array<{ id: string; name: string }>;
  createdAt?: string;
  updatedAt?: string;
}

interface LinearCommentData {
  id: string;
  body: string;
  issueId: string;
  userId?: string;
  user?: {
    id: string;
    name: string;
    isMe?: boolean; // True if the actor is the API key owner
  };
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify Linear webhook signature using HMAC-SHA256.
 * Linear sends the signature in linear-signature header.
 */
function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Payload conversion
// ---------------------------------------------------------------------------

/**
 * Convert Linear webhook issue data to LinearIssueContext.
 */
function toIssueContext(data: LinearIssueData): LinearIssueContext {
  return {
    id: data.id,
    identifier: data.identifier,
    title: data.title,
    description: data.description,
    statusName: data.state?.name,
    statusType: data.state?.type,
    teamKey: data.team?.key,
    teamName: data.team?.name,
    assignee: data.assignee ? { id: data.assignee.id, name: data.assignee.name } : undefined,
    labels: data.labels?.map((l) => l.name),
  };
}

// ---------------------------------------------------------------------------
// Issue identifier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Linear issue identifier from a comment webhook.
 * Comment webhooks provide the issue UUID but not the identifier (e.g., "PRO-123").
 * We try to find the identifier by searching active sessions.
 */
async function resolveIssueIdentifier(
  _issueUUID: string,
  _payload: LinearWebhookPayload,
): Promise<string | null> {
  // The Comment webhook payload may include the issue data in some cases.
  // For now, we search sessions since the issue identifier is stored there.
  const { sessionManager } = await getServices();
  const sessions = await sessionManager.list();

  // Search sessions — the issueId field stores the Linear identifier (e.g., "PRO-123")
  // We can't match by UUID directly, so we look for any session that has
  // a Linear issue and is currently active
  // In practice, the Comment.create webhook doesn't reliably include the identifier,
  // so we check if the payload has an embedded issue reference
  const payloadData = _payload.data as Record<string, unknown>;
  const issueRef = payloadData["issue"] as { id: string; identifier: string } | undefined;

  if (issueRef?.identifier) {
    return issueRef.identifier;
  }

  // Fallback: search sessions that might match this issue UUID
  // Sessions store the identifier (e.g., "PRO-123"), not the UUID
  // If we can't resolve it, return null and the comment will be ignored
  for (const session of sessions) {
    if (session.issueId && session.metadata?.issueUUID === _issueUUID) {
      return session.issueId;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Health-check endpoint
// ---------------------------------------------------------------------------

/**
 * GET /api/webhooks/linear
 *
 * Health-check endpoint to verify webhook configuration.
 * Returns configuration status without exposing secrets.
 */
export async function GET() {
  const webhookSecret = process.env["LINEAR_WEBHOOK_SECRET"];
  const configured = Boolean(webhookSecret);

  return NextResponse.json({
    configured,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Get the webhook secret from environment
  const webhookSecret = process.env["LINEAR_WEBHOOK_SECRET"];
  if (!webhookSecret) {
    console.error("[webhooks/linear] LINEAR_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Get the signature header
  const signature =
    request.headers.get("linear-signature") ?? request.headers.get("x-linear-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing webhook signature" }, { status: 401 });
  }

  // Read raw body for signature verification
  const rawBody = await request.text();

  // Verify signature
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    console.warn("[webhooks/linear] Invalid webhook signature");
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  // Parse JSON body
  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LinearWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  // Log the incoming webhook (for debugging)
  console.log(
    `[webhooks/linear] Received: ${payload.type}.${payload.action}`,
    payload.type === "Issue" ? `(${(payload.data as LinearIssueData).identifier})` : "",
  );

  // Get services
  const { config, registry, sessionManager } = await getServices();

  // Create AutoSpawn handler
  const autoSpawn = createAutoSpawnHandler({ config });
  const actionsDeps = { config, registry };

  // Route to appropriate handler
  let result: { action: string; reason?: string; details?: Record<string, unknown> };

  try {
    switch (`${payload.type}.${payload.action}`) {
      case "Issue.update": {
        const issueData = payload.data as LinearIssueData;
        const issueContext = toIssueContext(issueData);

        // 1. Try auto-spawn (issue → "Todo")
        const spawnResult = await autoSpawn.handleIssueStatusChange(
          issueContext,
          sessionManager,
        );

        if (spawnResult.action === "spawned" || spawnResult.action === "error") {
          result = {
            action: spawnResult.action,
            reason: spawnResult.reason,
            details: spawnResult.details,
          };
          break;
        }

        // 2. Try merge trigger (issue → "Done")
        const mergeResult = await handleMergeTrigger(
          issueContext,
          actionsDeps,
          sessionManager,
        );

        if (mergeResult.action !== "skipped") {
          result = {
            action: mergeResult.action,
            reason: mergeResult.reason,
            details: mergeResult.details,
          };
          break;
        }

        // 3. Neither triggered — report the spawn result
        result = {
          action: spawnResult.action,
          reason: spawnResult.reason,
          details: spawnResult.details,
        };
        break;
      }

      case "Comment.create": {
        const comment = payload.data as LinearCommentData;

        // Skip bot comments to prevent loops
        if (isBotGeneratedComment(comment.body ?? "")) {
          result = { action: "ignored", details: { reason: "bot comment detected" } };
          break;
        }

        // Skip comments from the API key owner (our bot user)
        if (comment.user?.isMe === true) {
          result = { action: "ignored", details: { reason: "comment from API user" } };
          break;
        }

        // Resolve issue identifier for the comment's issue
        const issueIdentifier = await resolveIssueIdentifier(comment.issueId, payload);

        if (!issueIdentifier) {
          result = { action: "ignored", details: { reason: "could not resolve issue identifier" } };
          break;
        }

        // Forward human comment to active agent
        const forwardResult = await handleCommentForward(
          {
            id: comment.id,
            body: comment.body,
            issueId: comment.issueId,
            user: comment.user,
          },
          issueIdentifier,
          actionsDeps,
          sessionManager,
        );

        result = {
          action: forwardResult.action,
          reason: forwardResult.reason,
          details: forwardResult.details,
        };
        break;
      }

      default:
        // Unknown event type — acknowledge but don't process
        result = {
          action: "ignored",
          details: { reason: `unhandled event: ${payload.type}.${payload.action}` },
        };
    }
  } catch (err) {
    // Log error but return 200 to prevent Linear from retrying
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[webhooks/linear] Error processing webhook: ${errorMsg}`);
    result = { action: "error", details: { error: errorMsg } };
  }

  // Always return 200 to acknowledge receipt
  // Linear will retry on non-2xx responses, which we don't want
  return NextResponse.json({
    ok: true,
    event: `${payload.type}.${payload.action}`,
    ...result,
  });
}
