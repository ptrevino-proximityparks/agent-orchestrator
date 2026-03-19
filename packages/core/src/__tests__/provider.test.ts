/**
 * Unit tests for provider configuration and environment variable generation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProviderEnvVars, checkOllamaHealth } from "../config.js";
import type { ProviderConfig } from "../types.js";

describe("getProviderEnvVars", () => {
  describe("anthropic provider", () => {
    it("returns empty object for anthropic provider (uses system defaults)", () => {
      const provider: ProviderConfig = { type: "anthropic" };
      const envVars = getProviderEnvVars(provider);
      expect(envVars).toEqual({});
    });

    it("returns empty object when provider is undefined", () => {
      const envVars = getProviderEnvVars(undefined);
      expect(envVars).toEqual({});
    });
  });

  describe("ollama provider", () => {
    it("returns correct env vars for ollama with default endpoint", () => {
      const provider: ProviderConfig = { type: "ollama" };
      const envVars = getProviderEnvVars(provider);

      expect(envVars).toEqual({
        ANTHROPIC_AUTH_TOKEN: "ollama",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: "http://localhost:11434",
      });
    });

    it("returns correct env vars for ollama with custom endpoint", () => {
      const provider: ProviderConfig = {
        type: "ollama",
        endpoint: "http://my-server:8080",
      };
      const envVars = getProviderEnvVars(provider);

      expect(envVars).toEqual({
        ANTHROPIC_AUTH_TOKEN: "ollama",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: "http://my-server:8080",
      });
    });

    it("includes ANTHROPIC_MODEL when model is specified", () => {
      const provider: ProviderConfig = {
        type: "ollama",
        model: "qwen3:8b",
      };
      const envVars = getProviderEnvVars(provider);

      expect(envVars).toEqual({
        ANTHROPIC_AUTH_TOKEN: "ollama",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: "http://localhost:11434",
        ANTHROPIC_MODEL: "qwen3:8b",
      });
    });

    it("includes both model and custom endpoint", () => {
      const provider: ProviderConfig = {
        type: "ollama",
        model: "llama3:70b",
        endpoint: "http://gpu-server:11434",
      };
      const envVars = getProviderEnvVars(provider);

      expect(envVars).toEqual({
        ANTHROPIC_AUTH_TOKEN: "ollama",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: "http://gpu-server:11434",
        ANTHROPIC_MODEL: "llama3:70b",
      });
    });
  });
});

describe("Provider Config Schema (via validateConfig)", () => {
  it("parses provider config in project correctly", async () => {
    // Dynamic import to avoid circular deps in test
    const { validateConfig } = await import("../config.js");

    const config = {
      projects: {
        "test-project": {
          path: "/test/project",
          repo: "org/repo",
          defaultBranch: "main",
          provider: {
            type: "ollama",
            model: "qwen3:8b",
            endpoint: "http://localhost:11434",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects["test-project"]?.provider).toEqual({
      type: "ollama",
      model: "qwen3:8b",
      endpoint: "http://localhost:11434",
    });
  });

  it("defaults provider type to anthropic when not specified", async () => {
    const { validateConfig } = await import("../config.js");

    const config = {
      projects: {
        "test-project": {
          path: "/test/project",
          repo: "org/repo",
          defaultBranch: "main",
          provider: {},
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects["test-project"]?.provider?.type).toBe("anthropic");
  });

  it("allows project without provider config (undefined)", async () => {
    const { validateConfig } = await import("../config.js");

    const config = {
      projects: {
        "test-project": {
          path: "/test/project",
          repo: "org/repo",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects["test-project"]?.provider).toBeUndefined();
  });
});

describe("checkOllamaHealth", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("succeeds when Ollama returns 200", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    // Should not throw
    await expect(checkOllamaHealth()).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("succeeds with custom endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    await expect(checkOllamaHealth("http://gpu-server:8080")).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      "http://gpu-server:8080/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws clear error on non-200 response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(checkOllamaHealth()).rejects.toThrow("Ollama returned status 500");
  });

  it("throws clear error on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(checkOllamaHealth()).rejects.toThrow(
      "Ollama not available at http://localhost:11434: ECONNREFUSED",
    );
  });

  it("throws timeout error when Ollama does not respond", async () => {
    // Create an AbortError to simulate timeout
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    global.fetch = vi.fn().mockRejectedValue(abortError);

    await expect(checkOllamaHealth()).rejects.toThrow(
      "Ollama not responding at http://localhost:11434 (timeout after 5s)",
    );
  });

  it("includes custom endpoint in error messages", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    await expect(checkOllamaHealth("http://custom:9999")).rejects.toThrow(
      "Ollama not available at http://custom:9999: Connection refused",
    );
  });
});
