import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices } from "@/lib/services";
import {
  sessionToDashboard,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { getProjectName } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home() {
  let sessions: DashboardSession[] = [];
  let orchestratorId: string | null = null;
  const projectName = getProjectName();

  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    // Find the orchestrator session
    const orchSession = allSessions.find((s) => s.id.endsWith("-orchestrator"));
    if (orchSession) {
      orchestratorId = orchSession.id;
    }

    // Filter out orchestrator from worker sessions
    const coreSessions = allSessions.filter((s) => !s.id.endsWith("-orchestrator"));
    sessions = coreSessions.map(sessionToDashboard);

    // Enrich metadata (issue labels, issue titles) — cap at 3s
    // No PR enrichment needed — all PR/review management happens through Linear
    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([enrichSessionsMetadata(coreSessions, sessions, config, registry), metaTimeout]);
  } catch {
    // Config not found or services unavailable — show empty dashboard
  }

  return (
    <Dashboard
      initialSessions={sessions}
      orchestratorId={orchestratorId}
      projectName={projectName}
    />
  );
}
