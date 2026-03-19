"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import type { DashboardSession } from "@/lib/types";
import type { SessionStatus, ActivityState } from "@composio/ao-core/types";

// Lazy-load DirectTerminal to avoid SSR issues with xterm.js
const DirectTerminal = dynamic(
  () => import("./DirectTerminal").then((m) => ({ default: m.DirectTerminal })),
  { ssr: false, loading: () => <div style={{ height: 320, background: "#0a0a0f" }} /> },
);

interface TerminalCellProps {
  session: DashboardSession;
}

// Status → color mapping for badges
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  working: { bg: "#1a3a5c", text: "#58a6ff" },
  spawning: { bg: "#1a3a5c", text: "#58a6ff" },
  pr_open: { bg: "#2d1a3e", text: "#a371f7" },
  review_pending: { bg: "#3d2a00", text: "#d29922" },
  in_review: { bg: "#3d2a00", text: "#d29922" },
  ci_failed: { bg: "#3d1a1a", text: "#f85149" },
  changes_requested: { bg: "#3d2a00", text: "#d29922" },
  approved: { bg: "#1a3d2a", text: "#3fb950" },
  mergeable: { bg: "#1a3d2a", text: "#3fb950" },
  merged: { bg: "#2d1a3e", text: "#a371f7" },
  done: { bg: "#1a2d1a", text: "#56d364" },
  errored: { bg: "#3d1a1a", text: "#f85149" },
  needs_input: { bg: "#3d2a00", text: "#d29922" },
  stuck: { bg: "#3d1a1a", text: "#f85149" },
  killed: { bg: "#2a2a2a", text: "#8b949e" },
  terminated: { bg: "#2a2a2a", text: "#8b949e" },
};

// Activity state → dot color
function activityDotColor(activity: ActivityState | null): string {
  switch (activity) {
    case "active":
      return "#3fb950";
    case "ready":
    case "idle":
      return "#58a6ff";
    case "blocked":
    case "waiting_input":
      return "#d29922";
    case "exited":
      return "#8b949e";
    default:
      return "#484f58";
  }
}

function formatStatus(status: SessionStatus): string {
  return status.replace(/_/g, " ");
}

export function TerminalCell({ session }: TerminalCellProps) {
  const statusColor = STATUS_COLORS[session.status] ?? { bg: "#2a2a2a", text: "#8b949e" };
  const dotColor = activityDotColor(session.activity);
  const issueLabel = session.issueLabel ?? session.issueId;

  return (
    <div
      style={{
        background: "#0d1117",
        border: "1px solid #21262d",
        borderRadius: 8,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid #21262d",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "#161b22",
        }}
      >
        {/* Activity dot */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: dotColor,
            flexShrink: 0,
          }}
        />

        {/* Session ID */}
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 13,
            color: "#e6edf3",
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {session.id}
        </span>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Issue badge */}
        {issueLabel && (
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              color: "#58a6ff",
              background: "#1a3a5c",
              padding: "2px 6px",
              borderRadius: 4,
              whiteSpace: "nowrap",
            }}
          >
            {issueLabel}
          </span>
        )}

        {/* Status badge */}
        <span
          style={{
            fontSize: 11,
            color: statusColor.text,
            background: statusColor.bg,
            padding: "2px 8px",
            borderRadius: 4,
            whiteSpace: "nowrap",
            textTransform: "capitalize",
          }}
        >
          {formatStatus(session.status)}
        </span>
      </div>

      {/* Issue title */}
      {session.issueTitle && (
        <div
          style={{
            padding: "4px 12px",
            fontSize: 12,
            color: "#8b949e",
            lineHeight: "1.4",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            borderBottom: "1px solid #21262d",
          }}
        >
          {session.issueTitle}
        </div>
      )}

      {/* Terminal */}
      <div style={{ height: 320 }}>
        <Suspense fallback={<div style={{ height: 320, background: "#0a0a0f" }} />}>
          <DirectTerminal sessionId={session.id} height="320px" />
        </Suspense>
      </div>
    </div>
  );
}
