import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import type { ProviderConfig } from "@composio/ao-core";

/** Validate provider config from request body */
function validateProviderConfig(provider: unknown): ProviderConfig | undefined {
  if (provider === undefined || provider === null) {
    return undefined;
  }

  if (typeof provider !== "object") {
    return undefined;
  }

  const p = provider as Record<string, unknown>;
  if (p.type !== "anthropic" && p.type !== "ollama") {
    return undefined;
  }

  if (p.type === "anthropic") {
    return { type: "anthropic" };
  }

  // Ollama provider
  return {
    type: "ollama",
    model: typeof p.model === "string" ? p.model : undefined,
    endpoint: typeof p.endpoint === "string" ? p.endpoint : undefined,
  };
}

/** POST /api/spawn — Spawn a new session */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  if (body.issueId !== undefined && body.issueId !== null) {
    const issueErr = validateIdentifier(body.issueId, "issueId");
    if (issueErr) {
      return NextResponse.json({ error: issueErr }, { status: 400 });
    }
  }

  // Validate and parse provider config (optional)
  const provider = validateProviderConfig(body.provider);

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.spawn({
      projectId: body.projectId as string,
      issueId: (body.issueId as string) ?? undefined,
      provider,
    });

    return NextResponse.json({ session: sessionToDashboard(session) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
    );
  }
}
