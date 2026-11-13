"use client";

import React from "react";
import { Users, X } from "lucide-react";
import { UserAvatar } from "./UserAvatar";
import { VerifiedEmailBadge } from "./VerifiedEmailBadge";

export interface WorkspaceMemberOverviewItem {
  userId: string;
  displayName: string;
  email: string;
  role: string;
  /** Verified-email flag for the badge (ticket h4vehyus). Absent = unknown = unbadged. */
  emailVerified?: boolean;
}

interface MembersOverviewPanelProps {
  workspaceName: string;
  members: WorkspaceMemberOverviewItem[];
  onClose: () => void;
}

function roleTagColor(role: string): { bg: string; fg: string } {
  if (role === "owner") return { bg: "rgba(37,99,235,0.15)", fg: "#60a5fa" };
  if (role === "admin") return { bg: "rgba(168,85,247,0.15)", fg: "#c084fc" };
  return { bg: "rgba(100,116,139,0.2)", fg: "var(--p-text-f)" };
}

export function MembersOverviewPanel({ workspaceName, members, onClose }: MembersOverviewPanelProps) {
  return (
    <div
      id="members-overview-panel"
      style={{
        width: 320,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--p-border)",
        background: "var(--p-surface)",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--p-border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Users style={{ width: 14, height: 14, color: "var(--p-blue-300)" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--p-text)" }}>Members</span>
            <span style={{ fontSize: 10, color: "var(--p-text-g)" }}>{workspaceName}</span>
          </div>
        </div>
        <button
          id="members-overview-close"
          onClick={onClose}
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            border: "1px solid var(--p-border)",
            background: "var(--p-card)",
            color: "var(--p-text-f)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
          title="Close members"
        >
          <X style={{ width: 12, height: 12 }} />
        </button>
      </div>

      <div style={{ overflowY: "auto", padding: "8px 0" }}>
        {members.length === 0 ? (
          <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--p-text-g)" }}>
            No members found.
          </div>
        ) : (
          members.map((member) => {
            const role = roleTagColor(member.role);
            return (
              <div
                key={member.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "8px 16px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <UserAvatar user={member.displayName} size={24} fontSize={9} />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--p-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                      title={member.displayName}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {member.displayName}
                      </span>
                      {/* Verified-email badge (ticket h4vehyus): shared
                          VerifiedEmailBadge — green check for verified
                          members, muted "unverified" for the rest. The flag
                          arrives via the workspace members query (user
                          columns select emailVerified); absent stays unbadged. */}
                      <VerifiedEmailBadge
                        verified={member.emailVerified ?? null}
                        label={member.displayName}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--p-text-g)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={member.email}
                    >
                      {member.email}
                    </div>
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    borderRadius: 4,
                    padding: "2px 6px",
                    color: role.fg,
                    background: role.bg,
                    flexShrink: 0,
                  }}
                >
                  {member.role}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
