"use client";

import { useMemo, useState } from "react";
import type { DashboardSession } from "@/lib/types";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { TerminalCell } from "./TerminalCell";
import { DynamicFavicon } from "./DynamicFavicon";

interface TerminalGridProps {
  initialSessions: DashboardSession[];
  orchestratorId?: string | null;
  projectName?: string;
}

const TERMINAL_STATUSES = new Set(["killed", "terminated", "done", "merged", "cleanup"]);

export function TerminalGrid({ initialSessions, orchestratorId, projectName }: TerminalGridProps) {
  const sessions = useSessionEvents(initialSessions);
  const [showCompleted, setShowCompleted] = useState(false);

  const { active, completed } = useMemo(() => {
    const act: DashboardSession[] = [];
    const comp: DashboardSession[] = [];
    for (const s of sessions) {
      if (TERMINAL_STATUSES.has(s.status)) {
        comp.push(s);
      } else {
        act.push(s);
      }
    }
    return { active: act, completed: comp };
  }, [sessions]);

  const activeCount = active.length;
  const totalCount = sessions.length;

  return (
    <div style={{ minHeight: "100vh", background: "#010409" }}>
      <DynamicFavicon sessions={sessions} />

      {/* Header */}
      <header
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid #21262d",
          display: "flex",
          alignItems: "center",
          gap: 16,
          background: "#0d1117",
        }}
      >
        <h1
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "#e6edf3",
            margin: 0,
          }}
        >
          {projectName ?? "Agent Orchestrator"}
        </h1>

        <div style={{ flex: 1 }} />

        {/* Stats */}
        <span style={{ fontSize: 13, color: "#8b949e" }}>
          {activeCount} active
          {completed.length > 0 && ` · ${completed.length} done`}
          {totalCount === 0 && " · no sessions"}
        </span>

        {/* Orchestrator link */}
        {orchestratorId && (
          <a
            href={`/sessions/${orchestratorId}`}
            style={{
              fontSize: 12,
              color: "#a371f7",
              textDecoration: "none",
              padding: "4px 8px",
              background: "#2d1a3e",
              borderRadius: 4,
            }}
          >
            orchestrator
          </a>
        )}
      </header>

      {/* Active sessions grid */}
      {activeCount === 0 && completed.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "60vh",
            color: "#484f58",
            fontSize: 14,
          }}
        >
          No active agent sessions. Create an issue in Linear to get started.
        </div>
      ) : (
        <div style={{ padding: 16 }}>
          {activeCount > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
                gap: 16,
              }}
            >
              {active.map((session) => (
                <TerminalCell key={session.id} session={session} />
              ))}
            </div>
          )}

          {/* Completed sessions (collapsible) */}
          {completed.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <button
                onClick={() => setShowCompleted(!showCompleted)}
                style={{
                  background: "none",
                  border: "1px solid #21262d",
                  color: "#8b949e",
                  fontSize: 13,
                  padding: "6px 12px",
                  borderRadius: 6,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ transform: showCompleted ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }}>
                  ▶
                </span>
                {completed.length} completed session{completed.length !== 1 ? "s" : ""}
              </button>

              {showCompleted && (
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
                    gap: 16,
                    opacity: 0.6,
                  }}
                >
                  {completed.map((session) => (
                    <TerminalCell key={session.id} session={session} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
