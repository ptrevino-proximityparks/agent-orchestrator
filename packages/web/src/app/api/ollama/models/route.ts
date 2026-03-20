import { NextResponse } from "next/server";

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

interface ModelsResponse {
  available: boolean;
  models: string[];
  error: string | null;
}

/**
 * GET /api/ollama/models
 *
 * Returns available Ollama models from the local Ollama instance.
 * Used by the dashboard provider selector.
 */
export async function GET(): Promise<NextResponse<ModelsResponse>> {
  const endpoint = process.env["OLLAMA_ENDPOINT"] ?? "http://localhost:11434";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json({
        available: false,
        models: [],
        error: `Ollama returned ${response.status}`,
      });
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const models = data.models?.map((m) => m.name) ?? [];

    return NextResponse.json({
      available: true,
      models,
      error: null,
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Ollama connection timeout"
          : err.message
        : "Failed to connect to Ollama";

    return NextResponse.json({
      available: false,
      models: [],
      error: message,
    });
  }
}
