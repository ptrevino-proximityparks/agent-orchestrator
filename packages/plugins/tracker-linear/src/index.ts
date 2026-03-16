/**
 * tracker-linear plugin — Linear as an issue tracker.
 *
 * Uses the Linear GraphQL API with either:
 * - LINEAR_API_KEY (direct API access)
 * - COMPOSIO_API_KEY (via Composio SDK's LINEAR_RUN_QUERY_OR_MUTATION tool)
 *
 * Auto-detects which key is available and routes accordingly.
 */

import { request } from "node:https";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueWithContext,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  CreateCommentResult,
  IssueRelation,
  IssueRelationType,
  IssueSearchOptions,
  CreateWebhookInput,
  WebhookInfo,
  WebhookResourceType,
  ProjectConfig,
} from "@composio/ao-core";
import type { Composio } from "@composio/core";

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * A function that sends a GraphQL query/mutation and returns the parsed data.
 * Both the direct Linear API and Composio SDK transports implement this.
 */
type GraphQLTransport = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

/** Retry configuration */
interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in ms before first retry (default: 1000) */
  baseDelay: number;
  /** Maximum delay in ms between retries (default: 15000) */
  maxDelay: number;
  /** Jitter factor 0-1 to randomize delays (default: 0.3) */
  jitterFactor: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 15_000,
  jitterFactor: 0.3,
};

/**
 * Active retry config — read at call time so tests can override it.
 * Use setRetryConfig() to change.
 */
let _activeRetryConfig: RetryConfig = DEFAULT_RETRY_CONFIG;

/**
 * Override retry configuration. Useful for testing:
 * - `setRetryConfig({ maxRetries: 0 })` to disable retries
 * - `setRetryConfig({ maxRetries: 3, baseDelay: 0 })` to retry without delays
 * Call with no args to restore defaults.
 */
export function setRetryConfig(config?: Partial<RetryConfig>): void {
  _activeRetryConfig = config ? { ...DEFAULT_RETRY_CONFIG, ...config } : DEFAULT_RETRY_CONFIG;
}

/**
 * Error subclass indicating the failure is transient and safe to retry.
 * Transport layers throw this for: HTTP 429, 5xx, network errors, timeouts.
 */
export class RetryableError extends Error {
  /** Suggested delay (ms) before retrying, e.g. from Retry-After header */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, { cause: options?.cause });
    this.name = "RetryableError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Calculate delay for a retry attempt using exponential backoff with jitter.
 * delay = min(baseDelay * 2^attempt, maxDelay) ± jitter
 */
function calculateRetryDelay(attempt: number, config: RetryConfig, retryAfterMs?: number): number {
  // If the server told us when to retry, respect it (capped at maxDelay)
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, config.maxDelay);
  }

  const exponentialDelay = config.baseDelay * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelay);

  // Add jitter: ±jitterFactor of the delay
  const jitter = cappedDelay * config.jitterFactor * (2 * Math.random() - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Sleep for a given number of milliseconds.
 * Uses a real timer — tests can use vi.useFakeTimers() to control this.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a GraphQL transport with retry logic.
 * Only retries on RetryableError — all other errors propagate immediately.
 * Reads _activeRetryConfig at call time so tests can control behavior.
 */
function withRetry(transport: GraphQLTransport): GraphQLTransport {
  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const config = _activeRetryConfig; // Read at call time for testability
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await transport<T>(query, variables);
      } catch (err: unknown) {
        if (!(err instanceof RetryableError)) {
          throw err; // Non-retryable — propagate immediately
        }

        lastError = err;

        if (attempt < config.maxRetries) {
          const delay = calculateRetryDelay(attempt, config, err.retryAfterMs);
          console.warn(
            `[tracker-linear] Retryable error (attempt ${attempt + 1}/${config.maxRetries}): ${err.message}. Retrying in ${delay}ms...`,
          );
          await sleep(delay);
        }
      }
    }

    // All retries exhausted — throw the last error
    throw lastError!;
  };
}

// ---------------------------------------------------------------------------
// Direct Linear API transport
// ---------------------------------------------------------------------------

const LINEAR_API_URL = "https://api.linear.app/graphql";

function getApiKey(): string {
  const key = process.env["LINEAR_API_KEY"];
  if (!key) {
    throw new Error(
      "LINEAR_API_KEY environment variable is required for the Linear tracker plugin",
    );
  }
  return key;
}

interface LinearResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// Rate limit tracking
// ---------------------------------------------------------------------------

interface RateLimitInfo {
  /** Requests allowed per hour */
  limit: number;
  /** Requests remaining in current window */
  remaining: number;
  /** Unix timestamp (ms) when the window resets */
  resetAt: number;
}

/**
 * Last known rate limit state from Linear API headers.
 * Exposed for external monitoring/testing.
 */
let _lastRateLimitInfo: RateLimitInfo | null = null;

/** Get current rate limit info (for monitoring/diagnostics) */
export function getRateLimitInfo(): RateLimitInfo | null {
  return _lastRateLimitInfo;
}

/**
 * Clear all in-memory caches. Exposed for testing.
 * Clears: identifier→UUID cache, workflow state cache, rate limit info, retry config.
 */
export function clearCaches(): void {
  identifierCache.clear();
  workflowStateCache.clear();
  _lastRateLimitInfo = null;
  _activeRetryConfig = DEFAULT_RETRY_CONFIG;
}

/** Threshold (fraction) at which we start warning about rate limits */
const RATE_LIMIT_WARN_THRESHOLD = 0.2; // warn when <20% remaining

/**
 * Parse Linear rate limit headers from an HTTP response.
 * Linear returns: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 */
function parseRateLimitHeaders(headers: Record<string, string | string[] | undefined>): void {
  const limit = headers["x-ratelimit-limit"];
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];

  if (limit && remaining) {
    const limitNum = parseInt(String(limit), 10);
    const remainingNum = parseInt(String(remaining), 10);
    const resetNum = reset ? parseInt(String(reset), 10) * 1000 : Date.now() + 3600_000;

    if (!isNaN(limitNum) && !isNaN(remainingNum)) {
      _lastRateLimitInfo = { limit: limitNum, remaining: remainingNum, resetAt: resetNum };

      const fraction = remainingNum / limitNum;
      if (fraction <= 0) {
        const resetDate = new Date(resetNum).toISOString().slice(11, 19);
        console.error(
          `[tracker-linear] ⚠️ RATE LIMIT EXHAUSTED: 0/${limitNum} requests remaining. Resets at ${resetDate} UTC`,
        );
      } else if (fraction <= RATE_LIMIT_WARN_THRESHOLD) {
        console.warn(
          `[tracker-linear] ⚠️ Rate limit warning: ${remainingNum}/${limitNum} requests remaining (${Math.round(fraction * 100)}%)`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Identifier → UUID cache
// ---------------------------------------------------------------------------

/**
 * In-memory cache of issue identifier (e.g. "INT-1330") → UUID + teamId.
 * Avoids repeated resolution queries — identifiers are stable.
 */
const identifierCache = new Map<string, { uuid: string; teamId: string }>();

function createDirectTransport(): GraphQLTransport {
  return <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const apiKey = getApiKey();
    const body = JSON.stringify({ query, variables });

    return new Promise<T>((resolve, reject) => {
      const url = new URL(LINEAR_API_URL);
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const req = request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: apiKey,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("error", (err: Error) => settle(() => reject(err)));
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            settle(() => {
              try {
                // Parse rate limit headers on every response (safe if headers missing)
                if (res.headers) {
                  parseRateLimitHeaders(
                    res.headers as Record<string, string | string[] | undefined>,
                  );
                }

                const text = Buffer.concat(chunks).toString("utf-8");
                const status = res.statusCode ?? 0;
                if (status === 429) {
                  const retryAfter = res.headers?.["retry-after"];
                  const retryAfterMs = retryAfter ? parseInt(String(retryAfter), 10) * 1000 : undefined;
                  reject(
                    new RetryableError(
                      `Linear API rate limited (HTTP 429). Retry after ${retryAfter ?? "unknown"} seconds`,
                      { retryAfterMs: retryAfterMs && !isNaN(retryAfterMs) ? retryAfterMs : undefined },
                    ),
                  );
                  return;
                }
                if (status >= 500) {
                  reject(
                    new RetryableError(
                      `Linear API server error (HTTP ${status}): ${text.slice(0, 200)}`,
                    ),
                  );
                  return;
                }
                if (status < 200 || status >= 300) {
                  reject(new Error(`Linear API returned HTTP ${status}: ${text.slice(0, 200)}`));
                  return;
                }
                const json: LinearResponse<T> = JSON.parse(text);
                if (json.errors && json.errors.length > 0) {
                  reject(new Error(`Linear API error: ${json.errors[0].message}`));
                  return;
                }
                if (!json.data) {
                  reject(new Error("Linear API returned no data"));
                  return;
                }
                resolve(json.data);
              } catch (err) {
                reject(err);
              }
            });
          });
        },
      );

      req.setTimeout(30_000, () => {
        settle(() => {
          req.destroy();
          reject(new RetryableError("Linear API request timed out after 30s"));
        });
      });

      req.on("error", (err) =>
        settle(() =>
          reject(new RetryableError(`Linear API network error: ${err.message}`, { cause: err })),
        ),
      );
      req.write(body);
      req.end();
    });
  };
}

// ---------------------------------------------------------------------------
// Composio SDK transport
// ---------------------------------------------------------------------------

type ComposioTools = Composio["tools"];

function createComposioTransport(apiKey: string, entityId: string): GraphQLTransport {
  // Lazy-load the Composio client — cached as a promise so the constructor
  // is called only once, even under concurrent requests.
  let clientPromise: Promise<ComposioTools> | undefined;

  function getClient(): Promise<ComposioTools> {
    if (!clientPromise) {
      clientPromise = (async () => {
        try {
          const { Composio } = await import("@composio/core");
          const client = new Composio({ apiKey });
          return client.tools;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("Cannot find module") ||
            msg.includes("Cannot find package") ||
            msg.includes("ERR_MODULE_NOT_FOUND")
          ) {
            throw new Error(
              "Composio SDK (@composio/core) is not installed. " +
                "Install it with: pnpm add @composio/core",
              { cause: err },
            );
          }
          throw err;
        }
      })();
    }
    return clientPromise;
  }

  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const tools = await getClient();

    const resultPromise = tools.execute("LINEAR_RUN_QUERY_OR_MUTATION", {
      entityId,
      arguments: {
        query_or_mutation: query,
        variables: variables ? JSON.stringify(variables) : "{}",
      },
    });

    // Apply 30s timeout for parity with the direct transport
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RetryableError("Composio Linear API request timed out after 30s"));
      }, 30_000);
    });

    // Whichever promise loses the race is left without a handler.
    // Attach no-op .catch() to both so the loser doesn't trigger an
    // unhandled promise rejection. This does not affect Promise.race —
    // it still propagates the winning rejection normally.
    resultPromise.catch(() => {});
    timeoutPromise.catch(() => {});

    try {
      let result: Awaited<typeof resultPromise>;
      try {
        result = await Promise.race([resultPromise, timeoutPromise]);
      } catch (err: unknown) {
        // Timeouts are already RetryableError; network/SDK failures should be too
        if (err instanceof RetryableError) throw err;
        throw new RetryableError(
          `Composio transport error: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (!result.successful) {
        throw new Error(`Composio Linear API error: ${result.error ?? "unknown error"}`);
      }

      if (!result.data) {
        throw new Error("Composio Linear API returned no data");
      }

      return result.data as T;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Types for Linear responses
// ---------------------------------------------------------------------------

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  state: {
    name: string;
    type: string; // "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"
  };
  labels: {
    nodes: Array<{ name: string }>;
  };
  assignee: {
    name: string;
    displayName: string;
  } | null;
  team: {
    key: string;
  };
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapLinearState(stateType: string): Issue["state"] {
  switch (stateType) {
    case "completed":
      return "closed";
    case "canceled":
      return "cancelled";
    case "started":
      return "in_progress";
    default:
      // triage, backlog, unstarted
      return "open";
  }
}

/**
 * Map Linear's relation type string to our IssueRelationType.
 * Linear has "similar" which we map to "related". Returns null for unknown types.
 */
function mapRelationType(type: string): IssueRelationType | null {
  switch (type) {
    case "blocks":
      return "blocks";
    case "duplicate":
      return "duplicate";
    case "related":
    case "similar":
      return "related";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Issue fields fragment
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  state { name type }
  labels { nodes { name } }
  assignee { name displayName }
  team { key }
`;

// ---------------------------------------------------------------------------
// Workflow state cache
// ---------------------------------------------------------------------------

/**
 * In-memory cache of workflow states per team.
 * Key: teamId, Value: Map of state name → state ID
 * This avoids repeated GraphQL queries for status transitions.
 */
const workflowStateCache = new Map<string, Map<string, string>>();

/**
 * Get workflow states for a team, using cache if available.
 */
async function getWorkflowStates(
  query: GraphQLTransport,
  teamId: string,
): Promise<Map<string, string>> {
  const cached = workflowStateCache.get(teamId);
  if (cached) {
    return cached;
  }

  const data = await query<{
    workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
  }>(
    `query($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }`,
    { teamId },
  );

  const stateMap = new Map<string, string>();
  for (const state of data.workflowStates.nodes) {
    stateMap.set(state.name, state.id);
    // Also map by type for fallback (e.g., "completed" → id)
    stateMap.set(`__type__${state.type}`, state.id);
  }

  workflowStateCache.set(teamId, stateMap);
  return stateMap;
}

// ---------------------------------------------------------------------------
// Identifier → UUID resolution (cached)
// ---------------------------------------------------------------------------

/**
 * Resolve a Linear issue identifier (e.g. "INT-1330") to its UUID and teamId.
 * Results are cached in-memory since identifiers are immutable.
 */
async function resolveIssueUuid(
  gql: GraphQLTransport,
  identifier: string,
): Promise<{ uuid: string; teamId: string }> {
  const cached = identifierCache.get(identifier);
  if (cached) {
    return cached;
  }

  const data = await gql<{
    issue: { id: string; team: { id: string } };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        id
        team { id }
      }
    }`,
    { id: identifier },
  );

  const result = { uuid: data.issue.id, teamId: data.issue.team.id };
  identifierCache.set(identifier, result);
  return result;
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createLinearTracker(query: GraphQLTransport): Tracker {
  return {
    name: "linear",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const data = await query<{ issue: LinearIssueNode }>(
        `query($id: String!) {
          issue(id: $id) {
            ${ISSUE_FIELDS}
          }
        }`,
        { id: identifier },
      );

      const node = data.issue;
      return {
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
      };
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const data = await query<{ issue: { state: { type: string } } }>(
        `query($id: String!) {
          issue(id: $id) {
            state { type }
          }
        }`,
        { id: identifier },
      );

      const stateType = data.issue.state.type;
      return stateType === "completed" || stateType === "canceled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const slug = project.tracker?.["workspaceSlug"] as string | undefined;
      if (slug) {
        return `https://linear.app/${slug}/issue/${identifier}`;
      }
      // Fallback: Linear also supports /issue/ URLs that redirect,
      // but they require authentication
      return `https://linear.app/issue/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract identifier from Linear URL
      // Examples:
      //   https://linear.app/composio/issue/INT-1327
      //   https://linear.app/issue/INT-1327
      const match = url.match(/\/issue\/([A-Z]+-\d+)/);
      if (match) {
        return match[1];
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // Linear convention: feat/INT-1330
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, _project: ProjectConfig): Promise<string> {
      // Use enriched query to get project, cycle, and dueDate context
      const data = await query<{
        issue: LinearIssueNode & {
          dueDate: string | null;
          estimate: number | null;
          project?: { name: string; state: string };
          cycle?: { name: string | null; number: number; startsAt: string; endsAt: string };
          parent?: { identifier: string; title: string };
        };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            ${ISSUE_FIELDS}
            dueDate
            estimate
            project { name state }
            cycle { name number startsAt endsAt }
            parent { identifier title }
          }
        }`,
        { id: identifier },
      );

      const node = data.issue;
      const issue: Issue = {
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
      };

      // Also populate the identifier cache while we have the data
      identifierCache.set(identifier, { uuid: node.id, teamId: node.team.key });

      const lines = [
        `You are working on Linear ticket ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      // Contextual metadata
      if (node.parent) {
        lines.push(`Parent issue: ${node.parent.identifier} — ${node.parent.title}`);
      }

      if (node.project) {
        lines.push(`Project: ${node.project.name} (${node.project.state})`);
      }

      if (node.cycle) {
        const cycleName = node.cycle.name ?? `Cycle ${node.cycle.number}`;
        const endsAt = node.cycle.endsAt.slice(0, 10); // YYYY-MM-DD
        lines.push(`Cycle: ${cycleName} (ends ${endsAt})`);
      }

      if (node.dueDate) {
        lines.push(`Due date: ${node.dueDate}`);
      }

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          0: "No priority",
          1: "Urgent",
          2: "High",
          3: "Normal",
          4: "Low",
        };
        lines.push(`Priority: ${priorityNames[issue.priority] ?? String(issue.priority)}`);
      }

      if (node.estimate !== null && node.estimate !== undefined) {
        lines.push(`Estimate: ${node.estimate} points`);
      }

      if (issue.description) {
        lines.push("", "## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this ticket. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      // Build filter object using GraphQL variables to prevent injection
      const filter: Record<string, unknown> = {};
      const variables: Record<string, unknown> = {};

      if (filters.state === "closed") {
        filter["state"] = { type: { in: ["completed", "canceled"] } };
      } else if (filters.state !== "all") {
        // Default to open (exclude completed/canceled) to match tracker-github
        filter["state"] = { type: { nin: ["completed", "canceled"] } };
      }

      if (filters.assignee) {
        filter["assignee"] = { displayName: { eq: filters.assignee } };
      }

      if (filters.labels && filters.labels.length > 0) {
        filter["labels"] = { name: { in: filters.labels } };
      }

      // Add team filter if available from project config
      const teamId = project.tracker?.["teamId"];
      if (teamId) {
        filter["team"] = { id: { eq: teamId } };
      }

      variables["filter"] = Object.keys(filter).length > 0 ? filter : undefined;
      variables["first"] = filters.limit ?? 30;

      const data = await query<{
        issues: { nodes: LinearIssueNode[] };
      }>(
        `query($filter: IssueFilter, $first: Int!) {
          issues(filter: $filter, first: $first) {
            nodes {
              ${ISSUE_FIELDS}
            }
          }
        }`,
        variables,
      );

      return data.issues.nodes.map((node) => ({
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      // Resolve identifier → UUID + teamId (cached)
      const { uuid: issueUuid, teamId } = await resolveIssueUuid(query, identifier);

      // Build a single issueUpdate input object to consolidate mutations.
      // We resolve stateId, assigneeId, and labelIds in parallel where possible,
      // then send ONE issueUpdate mutation instead of up to 3 separate ones.
      const issueInput: Record<string, unknown> = {};

      // Resolve all needed data in parallel
      const [stateId, assigneeId, labelIds] = await Promise.all([
        // Resolve state → stateId
        update.state
          ? (async () => {
              const stateMap = await getWorkflowStates(query, teamId);
              const targetType =
                update.state === "closed"
                  ? "completed"
                  : update.state === "open"
                    ? "unstarted"
                    : "started";
              const id = stateMap.get(`__type__${targetType}`);
              if (!id) {
                throw new Error(
                  `No workflow state of type "${targetType}" found for team ${teamId}`,
                );
              }
              return id;
            })()
          : Promise.resolve(null),

        // Resolve assignee → assigneeId
        update.assignee
          ? (async () => {
              const usersData = await query<{
                users: { nodes: Array<{ id: string; displayName: string; name: string }> };
              }>(
                `query($filter: UserFilter) {
                  users(filter: $filter) {
                    nodes { id displayName name }
                  }
                }`,
                { filter: { displayName: { eq: update.assignee } } },
              );
              return usersData.users.nodes[0]?.id ?? null;
            })()
          : Promise.resolve(null),

        // Resolve labels → labelIds (merge with existing)
        update.labels && update.labels.length > 0
          ? (async () => {
              // Fetch existing labels and team labels in parallel
              const [existingData, labelsData] = await Promise.all([
                query<{
                  issue: { labels: { nodes: Array<{ id: string }> } };
                }>(
                  `query($id: String!) {
                    issue(id: $id) {
                      labels { nodes { id } }
                    }
                  }`,
                  { id: issueUuid },
                ),
                query<{
                  issueLabels: { nodes: Array<{ id: string; name: string }> };
                }>(
                  `query($teamId: ID) {
                    issueLabels(filter: { team: { id: { eq: $teamId } } }) {
                      nodes { id name }
                    }
                  }`,
                  { teamId },
                ),
              ]);

              const existingIds = new Set(existingData.issue.labels.nodes.map((l) => l.id));
              const labelMap = new Map(labelsData.issueLabels.nodes.map((l) => [l.name, l.id]));
              for (const name of update.labels ?? []) {
                const id = labelMap.get(name);
                if (id) existingIds.add(id);
              }
              return [...existingIds];
            })()
          : Promise.resolve(null),
      ]);

      // Build consolidated input
      if (stateId) issueInput["stateId"] = stateId;
      if (assigneeId) issueInput["assigneeId"] = assigneeId;
      if (labelIds) issueInput["labelIds"] = labelIds;

      // Send ONE issueUpdate mutation if there's anything to update
      if (Object.keys(issueInput).length > 0) {
        await query(
          `mutation($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
            }
          }`,
          { id: issueUuid, input: issueInput },
        );
      }

      // Handle comment separately (commentCreate is a different mutation)
      if (update.comment) {
        await query(
          `mutation($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
            }
          }`,
          { issueId: issueUuid, body: update.comment },
        );
      }
    },

    async createComment(
      identifier: string,
      body: string,
      _project: ProjectConfig,
    ): Promise<CreateCommentResult> {
      // Resolve identifier to UUID (cached)
      let issueUuid: string;
      try {
        const { uuid } = await resolveIssueUuid(query, identifier);
        issueUuid = uuid;
      } catch (err) {
        // Log error but don't crash — orchestrator must continue
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tracker-linear] Failed to resolve issue ${identifier}: ${msg}`);
        // Return a placeholder result so caller knows the comment wasn't created
        return { id: "" };
      }

      // Create the comment via GraphQL mutation
      try {
        const data = await query<{
          commentCreate: {
            success: boolean;
            comment: {
              id: string;
              body: string;
              createdAt: string;
            };
          };
        }>(
          `mutation($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment {
                id
                body
                createdAt
              }
            }
          }`,
          { issueId: issueUuid, body },
        );

        if (!data.commentCreate.success) {
          console.error(`[tracker-linear] commentCreate returned success=false for ${identifier}`);
          return { id: "" };
        }

        return {
          id: data.commentCreate.comment.id,
          body: data.commentCreate.comment.body,
          createdAt: data.commentCreate.comment.createdAt,
        };
      } catch (err) {
        // Log error but don't crash — the orchestrator must not fail
        // because of a Linear API failure
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tracker-linear] Failed to create comment on ${identifier}: ${msg}`);
        return { id: "" };
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const teamId = project.tracker?.["teamId"];
      if (!teamId) {
        throw new Error("Linear tracker requires 'teamId' in project tracker config");
      }

      const variables: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? "",
        teamId,
      };

      if (input.priority !== undefined) {
        variables["priority"] = input.priority;
      }

      // Support for sub-issues via parentId
      if (input.parentId) {
        variables["parentId"] = input.parentId;
      }

      const data = await query<{
        issueCreate: {
          success: boolean;
          issue: LinearIssueNode;
        };
      }>(
        `mutation($title: String!, $description: String!, $teamId: String!, $priority: Int, $parentId: String) {
          issueCreate(input: {
            title: $title,
            description: $description,
            teamId: $teamId,
            priority: $priority,
            parentId: $parentId
          }) {
            success
            issue {
              ${ISSUE_FIELDS}
            }
          }
        }`,
        variables,
      );

      const node = data.issueCreate.issue;
      const issue: Issue = {
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
      };

      // Assign after creation (Linear's issueCreate uses assigneeId, not display name)
      if (input.assignee) {
        try {
          const usersData = await query<{
            users: { nodes: Array<{ id: string; displayName: string; name: string }> };
          }>(
            `query($filter: UserFilter) {
              users(filter: $filter) {
                nodes { id displayName name }
              }
            }`,
            { filter: { displayName: { eq: input.assignee } } },
          );

          const user = usersData.users.nodes[0];
          if (user) {
            await query(
              `mutation($id: String!, $assigneeId: String!) {
                issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
                  success
                }
              }`,
              { id: node.id, assigneeId: user.id },
            );
            issue.assignee = input.assignee;
          }
        } catch {
          // Assignee is best-effort
        }
      }

      // Add labels after creation (Linear's issueCreate doesn't accept label names directly)
      if (input.labels && input.labels.length > 0) {
        try {
          // Look up label IDs by name for the team
          const labelsData = await query<{
            issueLabels: { nodes: Array<{ id: string; name: string }> };
          }>(
            `query($teamId: ID) {
              issueLabels(filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name }
              }
            }`,
            { teamId },
          );

          const labelMap = new Map(labelsData.issueLabels.nodes.map((l) => [l.name, l.id]));
          const appliedLabels: string[] = [];
          const labelIds: string[] = [];
          for (const name of input.labels) {
            const id = labelMap.get(name);
            if (id) {
              labelIds.push(id);
              appliedLabels.push(name);
            }
          }

          if (labelIds.length > 0) {
            await query(
              `mutation($id: String!, $labelIds: [String!]!) {
                issueUpdate(id: $id, input: { labelIds: $labelIds }) {
                  success
                }
              }`,
              { id: node.id, labelIds },
            );
            // Reflect only the labels that actually exist in Linear
            issue.labels = appliedLabels;
          }
        } catch {
          // Labels are best-effort; don't fail the whole creation
        }
      }

      return issue;
    },

    async updateIssueStatus(
      identifier: string,
      statusName: string,
      _project: ProjectConfig,
    ): Promise<void> {
      // Resolve identifier to UUID and get team ID (cached)
      const { uuid: issueUuid, teamId } = await resolveIssueUuid(query, identifier);

      // Get workflow states from cache (or fetch and cache)
      const stateMap = await getWorkflowStates(query, teamId);

      // Look up the state ID by name
      const stateId = stateMap.get(statusName);
      if (!stateId) {
        const availableStates = [...stateMap.keys()].filter((k) => !k.startsWith("__type__"));
        throw new Error(
          `Status "${statusName}" not found for team. Available: ${availableStates.join(", ")}`,
        );
      }

      // Update the issue status
      await query(
        `mutation($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) {
            success
          }
        }`,
        { id: issueUuid, stateId },
      );
    },

    async getIssueWithContext(
      identifier: string,
      _project: ProjectConfig,
    ): Promise<IssueWithContext> {
      const data = await query<{
        issue: LinearIssueNode & {
          parent?: {
            id: string;
            identifier: string;
            title: string;
          };
          children: {
            nodes: Array<{
              id: string;
              identifier: string;
              title: string;
              state: { name: string };
            }>;
          };
          comments: {
            nodes: Array<{
              id: string;
              body: string;
              createdAt: string;
              user: { name: string; displayName: string } | null;
            }>;
          };
          project?: {
            name: string;
          };
        };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            ${ISSUE_FIELDS}
            parent {
              id
              identifier
              title
            }
            children {
              nodes {
                id
                identifier
                title
                state { name }
              }
            }
            comments(first: 20) {
              nodes {
                id
                body
                createdAt
                user { name displayName }
              }
            }
            project {
              name
            }
          }
        }`,
        { id: identifier },
      );

      const node = data.issue;
      return {
        // Base Issue fields
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,

        // Extended context fields
        parent: node.parent
          ? {
              id: node.parent.id,
              identifier: node.parent.identifier,
              title: node.parent.title,
            }
          : undefined,

        children: node.children.nodes.map((child) => ({
          id: child.id,
          identifier: child.identifier,
          title: child.title,
          state: child.state.name,
        })),

        comments: node.comments.nodes.map((comment) => ({
          id: comment.id,
          body: comment.body,
          author: comment.user?.displayName ?? comment.user?.name ?? "Unknown",
          createdAt: comment.createdAt,
        })),

        projectName: node.project?.name,
        teamKey: node.team.key,
      };
    },

    async getIssueRelations(
      identifier: string,
      _project: ProjectConfig,
    ): Promise<IssueRelation[]> {
      const data = await query<{
        issue: {
          identifier: string;
          title: string;
          relations: {
            nodes: Array<{
              id: string;
              type: string;
              relatedIssue: { identifier: string; title: string };
            }>;
          };
          inverseRelations: {
            nodes: Array<{
              id: string;
              type: string;
              issue: { identifier: string; title: string };
            }>;
          };
        };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            identifier
            title
            relations {
              nodes {
                id
                type
                relatedIssue { identifier title }
              }
            }
            inverseRelations {
              nodes {
                id
                type
                issue { identifier title }
              }
            }
          }
        }`,
        { id: identifier },
      );

      const node = data.issue;
      const results: IssueRelation[] = [];

      // Outward relations: this issue → relatedIssue
      for (const rel of node.relations.nodes) {
        const type = mapRelationType(rel.type);
        if (type) {
          results.push({
            id: rel.id,
            type,
            from: node.identifier,
            to: rel.relatedIssue.identifier,
            fromTitle: node.title,
            toTitle: rel.relatedIssue.title,
          });
        }
      }

      // Inverse relations: issue → this issue (flip direction)
      for (const rel of node.inverseRelations.nodes) {
        const type = mapRelationType(rel.type);
        if (type) {
          // For "blocks" inverse: the other issue blocks this one
          results.push({
            id: rel.id,
            type,
            from: rel.issue.identifier,
            to: node.identifier,
            fromTitle: rel.issue.title,
            toTitle: node.title,
          });
        }
      }

      return results;
    },

    async createIssueRelation(
      from: string,
      to: string,
      type: IssueRelationType,
      _project: ProjectConfig,
    ): Promise<IssueRelation> {
      const data = await query<{
        issueRelationCreate: {
          success: boolean;
          issueRelation: {
            id: string;
            type: string;
            issue: { identifier: string; title: string };
            relatedIssue: { identifier: string; title: string };
          };
        };
      }>(
        `mutation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
          issueRelationCreate(input: {
            issueId: $issueId,
            relatedIssueId: $relatedIssueId,
            type: $type
          }) {
            success
            issueRelation {
              id
              type
              issue { identifier title }
              relatedIssue { identifier title }
            }
          }
        }`,
        { issueId: from, relatedIssueId: to, type },
      );

      const rel = data.issueRelationCreate.issueRelation;
      return {
        id: rel.id,
        type: mapRelationType(rel.type) ?? "related",
        from: rel.issue.identifier,
        to: rel.relatedIssue.identifier,
        fromTitle: rel.issue.title,
        toTitle: rel.relatedIssue.title,
      };
    },

    async deleteIssueRelation(
      relationId: string,
      _project: ProjectConfig,
    ): Promise<void> {
      await query(
        `mutation($id: String!) {
          issueRelationDelete(id: $id) {
            success
          }
        }`,
        { id: relationId },
      );
    },

    async searchIssues(
      searchQuery: string,
      project: ProjectConfig,
      options?: IssueSearchOptions,
    ): Promise<Issue[]> {
      const limit = options?.limit ?? 20;
      const includeArchived = options?.includeArchived ?? false;

      // Build optional team filter
      const teamId = project.tracker?.["teamId"];
      const filter: Record<string, unknown> = {};
      if (teamId) {
        filter["team"] = { id: { eq: teamId } };
      }
      if (!includeArchived) {
        filter["state"] = { type: { nin: ["completed", "canceled"] } };
      }

      const data = await query<{
        issueSearch: {
          nodes: LinearIssueNode[];
        };
      }>(
        `query($query: String!, $first: Int, $filter: IssueFilter, $includeArchived: Boolean) {
          issueSearch(query: $query, first: $first, filter: $filter, includeArchived: $includeArchived) {
            nodes {
              ${ISSUE_FIELDS}
            }
          }
        }`,
        {
          query: searchQuery,
          first: limit,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
          includeArchived,
        },
      );

      return data.issueSearch.nodes.map((node) => ({
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
      }));
    },

    // --- Webhook Management ---

    async createWebhook(
      input: CreateWebhookInput,
      project: ProjectConfig,
    ): Promise<WebhookInfo> {
      const resourceTypes = input.resourceTypes ?? ["Issue", "Comment", "IssueLabel"];
      const label = input.label ?? "ao-orchestrator";
      const enabled = input.enabled ?? true;

      // Build mutation input — only include teamId if scoped
      const teamId = input.teamId ?? project.tracker?.["teamId"];
      const mutationInput: Record<string, unknown> = {
        url: input.url,
        resourceTypes,
        label,
        enabled,
      };
      if (teamId) {
        mutationInput["teamId"] = teamId;
      }
      if (input.secret) {
        mutationInput["secret"] = input.secret;
      }

      const data = await query<{
        webhookCreate: {
          success: boolean;
          webhook: {
            id: string;
            url: string;
            enabled: boolean;
            resourceTypes: WebhookResourceType[];
            label: string;
            createdAt: string;
            team: { id: string } | null;
          };
        };
      }>(
        `mutation($input: WebhookCreateInput!) {
          webhookCreate(input: $input) {
            success
            webhook {
              id
              url
              enabled
              resourceTypes
              label
              createdAt
              team { id }
            }
          }
        }`,
        { input: mutationInput },
      );

      const wh = data.webhookCreate.webhook;
      return {
        id: wh.id,
        url: wh.url,
        enabled: wh.enabled,
        resourceTypes: wh.resourceTypes,
        teamId: wh.team?.id,
        label: wh.label,
        createdAt: wh.createdAt,
      };
    },

    async deleteWebhook(
      webhookId: string,
      _project: ProjectConfig,
    ): Promise<void> {
      await query(
        `mutation($id: String!) {
          webhookDelete(id: $id) {
            success
          }
        }`,
        { id: webhookId },
      );
    },

    async listWebhooks(project: ProjectConfig): Promise<WebhookInfo[]> {
      const teamId = project.tracker?.["teamId"];

      const data = await query<{
        webhooks: {
          nodes: Array<{
            id: string;
            url: string;
            enabled: boolean;
            resourceTypes: WebhookResourceType[];
            label: string;
            createdAt: string;
            team: { id: string } | null;
          }>;
        };
      }>(
        `query {
          webhooks {
            nodes {
              id
              url
              enabled
              resourceTypes
              label
              createdAt
              team { id }
            }
          }
        }`,
      );

      let webhooks = data.webhooks.nodes;

      // If project has a teamId, filter to only that team's webhooks + global ones
      if (teamId) {
        webhooks = webhooks.filter(
          (wh) => !wh.team || wh.team.id === teamId,
        );
      }

      return webhooks.map((wh) => ({
        id: wh.id,
        url: wh.url,
        enabled: wh.enabled,
        resourceTypes: wh.resourceTypes,
        teamId: wh.team?.id,
        label: wh.label,
        createdAt: wh.createdAt,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "linear",
  slot: "tracker" as const,
  description: "Tracker plugin: Linear issue tracker",
  version: "0.1.0",
};

export function create(): Tracker {
  // Prioritize direct Linear API transport — only fall back to Composio
  // if LINEAR_API_KEY is not set and COMPOSIO_API_KEY is available.
  // All transports are wrapped with retry + exponential backoff.
  const linearKey = process.env["LINEAR_API_KEY"];
  if (linearKey) {
    return createLinearTracker(withRetry(createDirectTransport()));
  }
  const composioKey = process.env["COMPOSIO_API_KEY"];
  if (composioKey) {
    const entityId = process.env["COMPOSIO_ENTITY_ID"] ?? "default";
    return createLinearTracker(withRetry(createComposioTransport(composioKey, entityId)));
  }
  // No key found — createDirectTransport will throw a clear error
  return createLinearTracker(withRetry(createDirectTransport()));
}

export default { manifest, create } satisfies PluginModule<Tracker>;
