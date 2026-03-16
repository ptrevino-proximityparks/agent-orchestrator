/**
 * POST /api/webhooks/linear
 *
 * Receives Linear webhooks for issue events.
 * Validates signature, parses payload, and triggers appropriate actions.
 *
 * Events handled:
 * - Issue.update with state change to "Todo" → AutoSpawn agent
 * - Comment.create → Ignored (to prevent loops)
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
function verifySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
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
    assignee: data.assignee
      ? { id: data.assignee.id, name: data.assignee.name }
      : undefined,
    labels: data.labels?.map((l) => l.name),
  };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Handle Comment.create event.
 * Currently ignored to prevent loops.
 */
function handleCommentCreate(
  comment: LinearCommentData,
): { action: string; details?: Record<string, unknown> } {
  // Skip bot comments to prevent loops
  if (isBotGeneratedComment(comment.body ?? "")) {
    return { action: "ignored", details: { reason: "bot comment detected" } };
  }

  // Check if user is the API key owner (bot user)
  if (comment.user?.isMe === true) {
    return { action: "ignored", details: { reason: "comment from API user" } };
  }

  // Future: Could trigger agent to respond to human comments
  return { action: "ignored", details: { reason: "comment handling not implemented" } };
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Get the webhook secret from environment
  const webhookSecret = process.env["LINEAR_WEBHOOK_SECRET"];
  if (!webhookSecret) {
    console.error("[webhooks/linear] LINEAR_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 500 },
    );
  }

  // Get the signature header
  const signature = request.headers.get("linear-signature")
    ?? request.headers.get("x-linear-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing webhook signature" },
      { status: 401 },
    );
  }

  // Read raw body for signature verification
  const rawBody = await request.text();

  // Verify signature
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    console.warn("[webhooks/linear] Invalid webhook signature");
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 401 },
    );
  }

  // Parse JSON body
  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LinearWebhookPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  // Log the incoming webhook (for debugging)
  console.log(
    `[webhooks/linear] Received: ${payload.type}.${payload.action}`,
    payload.type === "Issue"
      ? `(${(payload.data as LinearIssueData).identifier})`
      : "",
  );

  // Get services
  const { config, sessionManager } = await getServices();

  // Create AutoSpawn handler
  const autoSpawn = createAutoSpawnHandler({ config });

  // Route to appropriate handler
  let result: { action: string; reason?: string; details?: Record<string, unknown> };

  try {
    switch (`${payload.type}.${payload.action}`) {
      case "Issue.update": {
        const issueData = payload.data as LinearIssueData;
        const issueContext = toIssueContext(issueData);
        const spawnResult = await autoSpawn.handleIssueStatusChange(
          issueContext,
          sessionManager,
        );
        result = {
          action: spawnResult.action,
          reason: spawnResult.reason,
          details: spawnResult.details,
        };
        break;
      }

      case "Comment.create":
        result = handleCommentCreate(payload.data as LinearCommentData);
        break;

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
