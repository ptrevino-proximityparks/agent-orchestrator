"use client";

import type { DashboardSession } from "@/lib/types";
import { TerminalGrid } from "./TerminalGrid";

interface DashboardProps {
  initialSessions: DashboardSession[];
  orchestratorId?: string | null;
  projectName?: string;
}

/**
 * Dashboard — Terminal-only viewer for agent sessions.
 *
 * Shows a grid of live terminals, one per active agent session.
 * Each cell displays: agent name, issue being solved, issue state, and terminal.
 * All review/approval/merge actions happen through Linear, not here.
 */
export function Dashboard({ initialSessions, orchestratorId, projectName }: DashboardProps) {
  return (
    <TerminalGrid
      initialSessions={initialSessions}
      orchestratorId={orchestratorId}
      projectName={projectName}
    />
  );
}
