/**
 * Configuration loader — reads agent-orchestrator.yaml and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { OrchestratorConfig, ProviderConfig } from "./types.js";
import { generateSessionPrefix } from "./paths.js";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge"]).default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const SCMConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const NotifierConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const ProviderConfigSchema = z.object({
  /** Provider type: 'anthropic' (default) or 'ollama' (local) */
  type: z.enum(["anthropic", "ollama"]).default("anthropic"),
  /** Model name (e.g., 'qwen3:8b' for Ollama) */
  model: z.string().optional(),
  /** API endpoint (only for ollama, defaults to http://localhost:11434) */
  endpoint: z.string().optional(),
});

const AgentSpecificConfigSchema = z
  .object({
    permissions: z.enum(["skip", "default"]).default("skip"),
    model: z.string().optional(),
  })
  .passthrough();

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string(),
  path: z.string(),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  agentConfig: AgentSpecificConfigSchema.default({}),
  reactions: z.record(ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  orchestratorRules: z.string().optional(),
  /** Provider configuration for AI model backend (defaults to anthropic) */
  provider: ProviderConfigSchema.optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("claude-code"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default(["composio", "desktop"]),
});

const LinearConfigSchema = z
  .object({
    webhooks: z
      .object({
        enabled: z.boolean().default(true),
        path: z.string().default("/webhooks/linear"),
      })
      .optional(),
    statusMapping: z
      .object({
        "agent-spawned": z.string().default("In Progress"),
        "pr-created": z.string().default("In Review"),
        "ci-failed": z.string().optional(),
        "review-pending": z.string().optional(),
        "changes-requested": z.string().optional(),
        "review-approved": z.string().optional(),
        "merge-ready": z.string().optional(),
        "pr-merged": z.string().default("Done"),
      })
      .optional(),
    comments: z
      .object({
        enabled: z.boolean().default(true),
        prefix: z.string().default("🤖"),
      })
      .optional(),
    autoSpawn: z
      .object({
        enabled: z.boolean().default(true),
        triggerStatus: z.union([z.string(), z.array(z.string())]).default("Todo"),
      })
      .optional(),
    mergeTrigger: z
      .object({
        enabled: z.boolean().default(false),
        triggerStatus: z.union([z.string(), z.array(z.string())]).default("Done"),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
      })
      .optional(),
    commentForwarding: z
      .object({
        enabled: z.boolean().default(false),
      })
      .optional(),
  })
  .optional();

const OrchestratorConfigSchema = z.object({
  port: z.number().default(3000),
  terminalPort: z.number().optional(),
  directTerminalPort: z.number().optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  defaults: DefaultPluginsSchema.default({}),
  projects: z.record(ProjectConfigSchema),
  notifiers: z.record(NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.array(z.string())).default({
    urgent: ["desktop", "composio"],
    action: ["desktop", "composio"],
    warning: ["composio"],
    info: ["composio"],
  }),
  reactions: z.record(ReactionConfigSchema).default({}),
  linear: LinearConfigSchema,
});

// =============================================================================
// CONFIG LOADING
// =============================================================================

/** Expand ~ to home directory */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = expandHome(project.path);
  }

  return config;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // Derive session prefix from project path basename if not set
    if (!project.sessionPrefix) {
      const projectId = basename(project.path);
      project.sessionPrefix = generateSessionPrefix(projectId);
    }

    // Infer SCM from repo if not set
    if (!project.scm && project.repo.includes("/")) {
      project.scm = { plugin: "github" };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker) {
      project.tracker = { plugin: "github" };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate project IDs (basenames)
  const projectIds = new Set<string>();
  const projectIdToPaths: Record<string, string[]> = {};

  for (const [_configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);

    if (!projectIdToPaths[projectId]) {
      projectIdToPaths[projectId] = [];
    }
    projectIdToPaths[projectId].push(project.path);

    if (projectIds.has(projectId)) {
      const paths = projectIdToPaths[projectId].join(", ");
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Multiple projects have the same directory basename:\n` +
          `  ${paths}\n\n` +
          `To fix this, ensure each project path has a unique directory name.\n` +
          `Alternatively, you can use the config key as a unique identifier.`,
      );
    }
    projectIds.add(projectId);
  }

  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);
    const prefix = project.sessionPrefix || generateSessionPrefix(projectId);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      const firstProject = config.projects[firstProjectKey];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${configKey}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${firstProject?.path}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${configKey}:\n` +
          `    path: ${project.path}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = configKey;
  }
}

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      message:
        "CI is failing on your PR. Run `gh pr checks` to see the failures, fix them, and push.",
      retries: 2,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.",
      escalateAfter: "30m",
    },
    "bugbot-comments": {
      auto: true,
      action: "send-to-agent",
      message: "Automated review comments found on your PR. Fix the issues flagged by the bot.",
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: "Your branch has merge conflicts. Rebase on the default branch and resolve them.",
      escalateAfter: "15m",
    },
    "approved-and-green": {
      auto: false,
      action: "notify",
      priority: "action",
      message: "PR is ready to merge",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      threshold: "10m",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
  };

  // Merge defaults with user-specified reactions (user wins)
  config.reactions = { ...defaults, ...config.reactions };

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. AO_CONFIG_PATH environment variable (if set)
 * 2. Search up directory tree from CWD (like git)
 * 3. Explicit startDir (if provided)
 * 4. Home directory locations
 */
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  if (process.env["AO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["AO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Search up directory tree from CWD (like git)
  const searchUpTree = (dir: string): string | null => {
    const configFiles = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];

    for (const filename of configFiles) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      // Reached root
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  // 3. Check explicit startDir if provided
  if (startDir) {
    const files = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
    for (const filename of files) {
      const path = resolve(startDir, filename);
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 4. Check home directory locations
  const homePaths = [
    resolve(homedir(), ".agent-orchestrator.yaml"),
    resolve(homedir(), ".agent-orchestrator.yml"),
    resolve(homedir(), ".config", "agent-orchestrator", "config.yaml"),
  ];

  for (const path of homePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): OrchestratorConfig {
  // Priority: 1. Explicit param, 2. Search (including AO_CONFIG_PATH env var)
  // findConfigFile handles AO_CONFIG_PATH validation, so delegate to it
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return config;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: OrchestratorConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown): OrchestratorConfig {
  const validated = OrchestratorConfigSchema.parse(raw);

  let config = validated as OrchestratorConfig;
  config = expandPaths(config);
  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);

  // Validate project uniqueness and prefix collisions
  validateProjectUniqueness(config);

  return config;
}

/** Get the default config (useful for `ao init`) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig({
    projects: {},
  });
}

// =============================================================================
// PROVIDER HELPERS
// =============================================================================

/**
 * Check if ANTHROPIC_API_KEY is set in the environment.
 * Called before spawning sessions that use the Anthropic provider.
 *
 * @throws Error if ANTHROPIC_API_KEY is not set or empty
 */
export function checkAnthropicApiKey(): void {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for Anthropic provider.\n" +
        "Set it with: export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "Or use provider.type: ollama for local models.",
    );
  }
}

/**
 * Check if Ollama is available at the specified endpoint.
 * Fetches /api/tags to verify Ollama is responding.
 *
 * @param endpoint - Ollama API endpoint (defaults to http://localhost:11434)
 * @throws Error if Ollama is not responding
 */
export async function checkOllamaHealth(endpoint: string = "http://localhost:11434"): Promise<void> {
  const url = `${endpoint}/api/tags`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Ollama returned status ${response.status}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Ollama not responding at ${endpoint} (timeout after 5s)`, { cause: err });
    }
    throw new Error(`Ollama not available at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Get environment variables for a provider configuration.
 * Claude Code natively supports Ollama via these env vars.
 *
 * @param provider - Provider configuration (anthropic or ollama)
 * @returns Environment variables to set for the agent process
 */
export function getProviderEnvVars(provider: ProviderConfig | undefined): Record<string, string> {
  if (!provider || provider.type === "anthropic") {
    // Anthropic uses system defaults (ANTHROPIC_API_KEY from environment)
    return {};
  }

  if (provider.type === "ollama") {
    return {
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: provider.endpoint ?? "http://localhost:11434",
      // If a specific model is configured, set it as default
      ...(provider.model ? { ANTHROPIC_MODEL: provider.model } : {}),
    };
  }

  // Future provider types can be added here
  return {};
}
