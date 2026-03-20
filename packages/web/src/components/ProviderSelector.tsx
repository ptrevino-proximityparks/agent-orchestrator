"use client";

import { useState, useEffect, useCallback } from "react";

export type ProviderType = "anthropic" | "ollama";

export interface ProviderConfig {
  type: ProviderType;
  model?: string; // Only used for Ollama
}

interface ProviderSelectorProps {
  value: ProviderConfig;
  onChange: (config: ProviderConfig) => void;
}

interface OllamaModelsResponse {
  available: boolean;
  models: string[];
  error: string | null;
}

interface ProviderStatusResponse {
  anthropic: { available: boolean; error: string | null };
  ollama: { available: boolean; error: string | null };
}

const STORAGE_KEY = "ao-provider-config";

/**
 * Load provider config from localStorage.
 * Falls back to Anthropic if not set or invalid.
 */
export function loadProviderConfig(): ProviderConfig {
  if (typeof window === "undefined") {
    return { type: "anthropic" };
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ProviderConfig;
      if (parsed.type === "anthropic" || parsed.type === "ollama") {
        return parsed;
      }
    }
  } catch {
    // Invalid JSON, use default
  }
  return { type: "anthropic" };
}

/**
 * Save provider config to localStorage.
 */
export function saveProviderConfig(config: ProviderConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function ProviderSelector({ value, onChange }: ProviderSelectorProps) {
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null);
  const [anthropicAvailable, setAnthropicAvailable] = useState<boolean | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [anthropicError, setAnthropicError] = useState<string | null>(null);

  // Fetch provider status on mount
  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch("/api/providers/status");
        if (response.ok) {
          const data = (await response.json()) as ProviderStatusResponse;
          setAnthropicAvailable(data.anthropic.available);
          setAnthropicError(data.anthropic.error);
          setOllamaAvailable(data.ollama.available);
          setOllamaError(data.ollama.error);
        }
      } catch {
        // Status check failed, continue without status
      }
    }
    fetchStatus();
  }, []);

  // Fetch Ollama models when Ollama is selected or available
  useEffect(() => {
    async function fetchModels() {
      try {
        const response = await fetch("/api/ollama/models");
        if (response.ok) {
          const data = (await response.json()) as OllamaModelsResponse;
          setOllamaModels(data.models);
          setOllamaAvailable(data.available);
          if (data.error) {
            setOllamaError(data.error);
          }
        }
      } catch {
        setOllamaAvailable(false);
        setOllamaError("Failed to fetch models");
      }
    }

    if (value.type === "ollama" || ollamaAvailable) {
      fetchModels();
    }
  }, [value.type, ollamaAvailable]);

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newType = e.target.value as ProviderType;
      const newConfig: ProviderConfig =
        newType === "ollama"
          ? { type: "ollama", model: ollamaModels[0] ?? "llama3:8b" }
          : { type: "anthropic" };
      saveProviderConfig(newConfig);
      onChange(newConfig);
    },
    [ollamaModels, onChange],
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newConfig: ProviderConfig = { type: "ollama", model: e.target.value };
      saveProviderConfig(newConfig);
      onChange(newConfig);
    },
    [onChange],
  );

  const anthropicDisabled = anthropicAvailable === false;
  const ollamaDisabled = ollamaAvailable === false;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
      }}
    >
      {/* Provider status indicators */}
      <div style={{ display: "flex", gap: 6, marginRight: 4 }}>
        <span
          title={anthropicAvailable ? "Anthropic available" : anthropicError ?? "Checking..."}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor:
              anthropicAvailable === null
                ? "#484f58"
                : anthropicAvailable
                  ? "#3fb950"
                  : "#f85149",
          }}
        />
        <span
          title={ollamaAvailable ? "Ollama available" : ollamaError ?? "Checking..."}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor:
              ollamaAvailable === null ? "#484f58" : ollamaAvailable ? "#3fb950" : "#f85149",
          }}
        />
      </div>

      {/* Provider dropdown */}
      <select
        value={value.type}
        onChange={handleProviderChange}
        style={{
          background: "#21262d",
          color: "#e6edf3",
          border: "1px solid #30363d",
          borderRadius: 6,
          padding: "4px 8px",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        <option value="anthropic" disabled={anthropicDisabled}>
          {anthropicDisabled ? "Anthropic (unavailable)" : "Anthropic"}
        </option>
        <option value="ollama" disabled={ollamaDisabled}>
          {ollamaDisabled ? "Ollama (unavailable)" : "Ollama (local)"}
        </option>
      </select>

      {/* Model dropdown (only for Ollama) */}
      {value.type === "ollama" && (
        <select
          value={value.model ?? ""}
          onChange={handleModelChange}
          style={{
            background: "#21262d",
            color: "#e6edf3",
            border: "1px solid #30363d",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 13,
            cursor: "pointer",
            maxWidth: 140,
          }}
        >
          {ollamaModels.length === 0 ? (
            <option value="">No models</option>
          ) : (
            ollamaModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))
          )}
        </select>
      )}
    </div>
  );
}
