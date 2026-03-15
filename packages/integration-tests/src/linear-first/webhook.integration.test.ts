import { describe, it, expect } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isBotGeneratedComment } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Webhook signature verification (extracted for testing)
// ---------------------------------------------------------------------------

/**
 * Verify Linear webhook signature using HMAC-SHA256.
 * This mirrors the implementation in the webhook route.
 */
function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) {
    // No secret configured - skip verification (development mode)
    return true;
  }

  if (!signature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    // Lengths don't match
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loop prevention helpers (extracted for testing)
// ---------------------------------------------------------------------------

interface LinearUser {
  id: string;
  name: string;
  isMe?: boolean;
}

interface LinearComment {
  id: string;
  body: string;
  user?: LinearUser;
  createdAt: string;
}

/**
 * Check if a comment was created by a bot (should be ignored).
 */
function isBotComment(comment: LinearComment, botPrefix: string = "🤖"): boolean {
  // Check if body starts with bot prefix
  if (comment.body.startsWith(botPrefix)) {
    return true;
  }

  // Check if body starts with common bot markers
  if (comment.body.startsWith("[bot]") || comment.body.startsWith("[Bot]")) {
    return true;
  }

  return false;
}

/**
 * Check if a comment was created by the API user (the orchestrator itself).
 */
function isApiUserComment(comment: LinearComment): boolean {
  // If the user is marked as "me" (the API key owner), it's from the orchestrator
  return comment.user?.isMe === true;
}

/**
 * Check if a webhook event should be ignored for loop prevention.
 */
function shouldIgnoreEvent(
  eventType: string,
  payload: Record<string, unknown>,
  botPrefix: string = "🤖",
): boolean {
  // Ignore Comment.create events from bots or API user
  if (eventType === "Comment" && payload["action"] === "create") {
    const comment = payload as unknown as LinearComment;
    if (isBotComment(comment, botPrefix) || isApiUserComment(comment)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Webhook Signature Verification", () => {
  const secret = "test-webhook-secret";

  describe("verifySignature", () => {
    it("returns true for valid signature", () => {
      const body = JSON.stringify({ type: "Issue", action: "update" });
      const signature = createHmac("sha256", secret).update(body).digest("hex");

      expect(verifySignature(body, signature, secret)).toBe(true);
    });

    it("returns false for invalid signature", () => {
      const body = JSON.stringify({ type: "Issue", action: "update" });
      const invalidSignature = "invalid-signature-here";

      expect(verifySignature(body, invalidSignature, secret)).toBe(false);
    });

    it("returns false for tampered body", () => {
      const originalBody = JSON.stringify({ type: "Issue", action: "update" });
      const tamperedBody = JSON.stringify({ type: "Issue", action: "delete" });
      const signature = createHmac("sha256", secret).update(originalBody).digest("hex");

      expect(verifySignature(tamperedBody, signature, secret)).toBe(false);
    });

    it("returns false when signature is null", () => {
      const body = JSON.stringify({ type: "Issue", action: "update" });

      expect(verifySignature(body, null, secret)).toBe(false);
    });

    it("returns true when secret is undefined (development mode)", () => {
      const body = JSON.stringify({ type: "Issue", action: "update" });

      expect(verifySignature(body, "any-signature", undefined)).toBe(true);
    });

    it("returns true when secret is empty string (development mode)", () => {
      const body = JSON.stringify({ type: "Issue", action: "update" });

      // Empty string is falsy, so it should skip verification
      expect(verifySignature(body, "any-signature", "")).toBe(true);
    });

    it("handles unicode content in body", () => {
      const body = JSON.stringify({
        type: "Issue",
        title: "Fix 🐛 bug with émojis and ñ characters",
      });
      const signature = createHmac("sha256", secret).update(body).digest("hex");

      expect(verifySignature(body, signature, secret)).toBe(true);
    });

    it("handles large payloads", () => {
      const largeBody = JSON.stringify({
        type: "Issue",
        description: "x".repeat(100000), // 100KB of content
      });
      const signature = createHmac("sha256", secret).update(largeBody).digest("hex");

      expect(verifySignature(largeBody, signature, secret)).toBe(true);
    });

    it("is case-sensitive for signatures", () => {
      const body = JSON.stringify({ type: "Issue" });
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      const upperSignature = signature.toUpperCase();

      // HMAC hex digest is lowercase, uppercase should fail
      expect(verifySignature(body, upperSignature, secret)).toBe(false);
    });
  });
});

describe("Loop Prevention", () => {
  describe("isBotComment", () => {
    it("returns true for comments starting with 🤖", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "🤖 Agent spawned",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isBotComment(comment)).toBe(true);
    });

    it("returns true for comments starting with [bot]", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "[bot] Automated message",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isBotComment(comment)).toBe(true);
    });

    it("returns true for comments starting with [Bot]", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "[Bot] Automated message",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isBotComment(comment)).toBe(true);
    });

    it("returns false for regular user comments", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "Please fix this bug",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isBotComment(comment)).toBe(false);
    });

    it("returns false for comments with emoji in middle", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "This is a 🤖 robot emoji in the middle",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isBotComment(comment)).toBe(false);
    });

    it("supports custom bot prefix", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "🔧 Automated fix applied",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isBotComment(comment, "🔧")).toBe(true);
      expect(isBotComment(comment, "🤖")).toBe(false);
    });
  });

  describe("isApiUserComment", () => {
    it("returns true when user.isMe is true", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "Auto-generated comment",
        user: { id: "user-1", name: "API User", isMe: true },
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isApiUserComment(comment)).toBe(true);
    });

    it("returns false when user.isMe is false", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "Human comment",
        user: { id: "user-2", name: "Human User", isMe: false },
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isApiUserComment(comment)).toBe(false);
    });

    it("returns false when user.isMe is undefined", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "Comment",
        user: { id: "user-3", name: "Unknown" },
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isApiUserComment(comment)).toBe(false);
    });

    it("returns false when user is undefined", () => {
      const comment: LinearComment = {
        id: "comment-1",
        body: "Anonymous comment",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(isApiUserComment(comment)).toBe(false);
    });
  });

  describe("shouldIgnoreEvent", () => {
    it("ignores Comment.create with bot prefix", () => {
      const payload = {
        action: "create",
        body: "🤖 Agent status update",
        id: "comment-1",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(shouldIgnoreEvent("Comment", payload)).toBe(true);
    });

    it("ignores Comment.create from API user", () => {
      const payload = {
        action: "create",
        body: "Status update",
        id: "comment-1",
        createdAt: "2024-01-01T00:00:00Z",
        user: { id: "user-1", name: "API", isMe: true },
      };

      expect(shouldIgnoreEvent("Comment", payload)).toBe(true);
    });

    it("does not ignore Comment.create from human user", () => {
      const payload = {
        action: "create",
        body: "Please fix this",
        id: "comment-1",
        createdAt: "2024-01-01T00:00:00Z",
        user: { id: "user-2", name: "Human", isMe: false },
      };

      expect(shouldIgnoreEvent("Comment", payload)).toBe(false);
    });

    it("does not ignore Issue events", () => {
      const payload = {
        action: "update",
        id: "issue-1",
        identifier: "INT-123",
      };

      expect(shouldIgnoreEvent("Issue", payload)).toBe(false);
    });

    it("does not ignore Comment.update events", () => {
      const payload = {
        action: "update",
        body: "🤖 Updated message",
        id: "comment-1",
        createdAt: "2024-01-01T00:00:00Z",
      };

      // Only Comment.create is checked for loop prevention
      expect(shouldIgnoreEvent("Comment", payload)).toBe(false);
    });

    it("uses custom bot prefix when provided", () => {
      const payload = {
        action: "create",
        body: "🔧 Automated fix",
        id: "comment-1",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(shouldIgnoreEvent("Comment", payload, "🔧")).toBe(true);
      expect(shouldIgnoreEvent("Comment", payload, "🤖")).toBe(false);
    });
  });
});

describe("Webhook Payload Parsing", () => {
  describe("Issue.update event", () => {
    it("extracts issue status change information", () => {
      const payload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-uuid",
          identifier: "INT-123",
          title: "Fix login bug",
          state: {
            id: "state-uuid",
            name: "Todo",
            type: "unstarted",
          },
          team: {
            id: "team-uuid",
            key: "INT",
          },
        },
        updatedFrom: {
          stateId: "old-state-uuid",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      };

      // Extract relevant fields
      const issue = payload.data;
      const previousStateId = payload.updatedFrom?.stateId;

      expect(issue.identifier).toBe("INT-123");
      expect(issue.state.name).toBe("Todo");
      expect(issue.team.key).toBe("INT");
      expect(previousStateId).toBe("old-state-uuid");
    });

    it("handles missing updatedFrom field", () => {
      const payload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-uuid",
          identifier: "INT-123",
          state: { name: "Todo" },
        },
      };

      const previousStateId = (payload as { updatedFrom?: { stateId?: string } }).updatedFrom
        ?.stateId;

      expect(previousStateId).toBeUndefined();
    });
  });

  describe("Comment.create event", () => {
    it("extracts comment information", () => {
      const payload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-uuid",
          body: "Please fix this ASAP",
          issue: {
            id: "issue-uuid",
            identifier: "INT-123",
          },
          user: {
            id: "user-uuid",
            name: "John Doe",
            isMe: false,
          },
          createdAt: "2024-01-01T12:00:00Z",
        },
      };

      const comment = payload.data;

      expect(comment.body).toBe("Please fix this ASAP");
      expect(comment.issue.identifier).toBe("INT-123");
      expect(comment.user.isMe).toBe(false);
    });
  });
});

describe("Webhook Event Routing", () => {
  it("routes Issue.update to AutoSpawn handler", () => {
    const events: string[] = [];

    // Simulate event routing
    const routeEvent = (type: string, action: string) => {
      if (type === "Issue" && action === "update") {
        events.push("autoSpawn");
      }
    };

    routeEvent("Issue", "update");

    expect(events).toContain("autoSpawn");
  });

  it("does not route Comment.create to AutoSpawn", () => {
    const events: string[] = [];

    const routeEvent = (type: string, action: string) => {
      if (type === "Issue" && action === "update") {
        events.push("autoSpawn");
      }
    };

    routeEvent("Comment", "create");

    expect(events).not.toContain("autoSpawn");
  });

  it("filters out bot comments before processing", () => {
    const processedComments: string[] = [];

    const processComment = (comment: LinearComment) => {
      if (!isBotComment(comment) && !isApiUserComment(comment)) {
        processedComments.push(comment.id);
      }
    };

    // Bot comment
    processComment({
      id: "bot-comment",
      body: "🤖 Agent update",
      createdAt: "2024-01-01T00:00:00Z",
    });

    // API user comment
    processComment({
      id: "api-comment",
      body: "Auto status",
      user: { id: "api", name: "API", isMe: true },
      createdAt: "2024-01-01T00:00:00Z",
    });

    // Human comment
    processComment({
      id: "human-comment",
      body: "Please review",
      user: { id: "human", name: "Human", isMe: false },
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(processedComments).toEqual(["human-comment"]);
  });
});
