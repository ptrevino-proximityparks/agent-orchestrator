import { checkOllamaHealth, checkAnthropicApiKey } from "@composio/ao-core";
import { NextResponse } from "next/server";

interface ProviderStatus {
  available: boolean;
  error: string | null;
}

interface ProvidersStatusResponse {
  anthropic: ProviderStatus;
  ollama: ProviderStatus;
}

/**
 * GET /api/providers/status
 *
 * Returns the availability status of each provider.
 * Used by the dashboard to show provider health badges.
 */
export async function GET(): Promise<NextResponse<ProvidersStatusResponse>> {
  // Check Anthropic API key
  let anthropicStatus: ProviderStatus;
  try {
    checkAnthropicApiKey();
    anthropicStatus = { available: true, error: null };
  } catch (err) {
    anthropicStatus = {
      available: false,
      error: err instanceof Error ? err.message : "Missing ANTHROPIC_API_KEY",
    };
  }

  // Check Ollama health
  let ollamaStatus: ProviderStatus;
  try {
    await checkOllamaHealth();
    ollamaStatus = { available: true, error: null };
  } catch (err) {
    ollamaStatus = {
      available: false,
      error: err instanceof Error ? err.message : "Ollama not running",
    };
  }

  return NextResponse.json({
    anthropic: anthropicStatus,
    ollama: ollamaStatus,
  });
}
