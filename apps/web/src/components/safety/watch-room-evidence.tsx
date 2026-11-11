// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, StatusBadge } from "@commonair/ui";
import * as React from "react";
import { t } from "../../i18n/index.ts";

export interface WatchRoomEvidenceProps {
  reportId: string;
  /**
   * `Report.evidence` of a `watch_room` report: the room's messages (author ids, body, time) and
   * members (ids, joined and left), copied at report time. Authors are shown by username through
   * the user lookup, never stored in the report.
   */
  evidence: Record<string, unknown>;
  /** Usernames for ids (the staff user lookup); ids without one show as an unknown account. */
  lookup?: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

export interface EvidenceMessage {
  id: string;
  userId: string;
  body: string;
  at: string;
}
export interface EvidenceMember {
  userId: string;
  host: boolean;
  joinedAt: string;
  leftAt: string | null;
}
export interface ParsedEvidence {
  members: EvidenceMember[];
  messages: EvidenceMessage[];
  truncated: boolean;
  kept: number;
}

const str = (v: unknown): v is string => typeof v === "string";

/** Read the evidence defensively (it is stored jsonb); null when it is not a room transcript. */
export function parseRoomEvidence(evidence: Record<string, unknown>): ParsedEvidence | null {
  const { members, messages, truncated } = evidence;
  if (!Array.isArray(members) || !Array.isArray(messages)) return null;
  const ms: EvidenceMessage[] = [];
  for (const m of messages as unknown[]) {
    if (typeof m !== "object" || m === null) continue;
    const r = m as Record<string, unknown>;
    if (str(r["id"]) && str(r["userId"]) && str(r["body"]) && str(r["at"]))
      ms.push({ id: r["id"], userId: r["userId"], body: r["body"], at: r["at"] });
  }
  const mb: EvidenceMember[] = [];
  for (const m of members as unknown[]) {
    if (typeof m !== "object" || m === null) continue;
    const r = m as Record<string, unknown>;
    if (str(r["userId"]) && str(r["joinedAt"]))
      mb.push({
        userId: r["userId"],
        host: r["host"] === true,
        joinedAt: r["joinedAt"],
        leftAt: str(r["leftAt"]) ? r["leftAt"] : null,
      });
  }
  return { members: mb, messages: ms, truncated: truncated === true, kept: ms.length };
}

/**
 * A watch-room report's transcript and member list in the mod queue's report detail (ADR 0017
 * decision 2). Only platform staff see it: room reports carry no channel, so they never reach a
 * channel's moderators.
 */
export function WatchRoomEvidence({ reportId, evidence, lookup }: WatchRoomEvidenceProps): React.JSX.Element | null {
  const parsed = React.useMemo(() => parseRoomEvidence(evidence), [evidence]);
  const [names, setNames] = React.useState<ReadonlyMap<string, string>>(new Map());
  React.useEffect(() => {
    if (!parsed || !lookup) return;
    const ids = [...new Set([...parsed.members.map((m) => m.userId), ...parsed.messages.map((m) => m.userId)])];
    let cancelled = false;
    lookup(ids)
      .then((found) => {
        if (!cancelled) setNames(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [parsed, lookup]);

  if (!parsed)
    return (
      <p data-testid="watch-room-evidence" data-report-id={reportId} className="text-sm text-muted-foreground">
        {t("watchRooms.evidence.unreadable")}
      </p>
    );
  const who = (id: string) => names.get(id) ?? t("watchRooms.evidence.unknownUser");
  return (
    <section
      data-testid="watch-room-evidence"
      data-report-id={reportId}
      aria-labelledby={`watch-room-evidence-${reportId}`}
      className="flex flex-col gap-3"
    >
      <h3 id={`watch-room-evidence-${reportId}`} className="text-sm font-medium">
        {t("watchRooms.evidence.title")}
      </h3>
      <p className="text-sm text-muted-foreground">{t("watchRooms.evidence.intro")}</p>
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium">{t("watchRooms.evidence.members")}</h4>
        <ul className="flex flex-col gap-1">
          {parsed.members.map((m) => (
            <li
              key={`${m.userId}-${m.joinedAt}`}
              data-testid="watch-room-evidence-member"
              data-user-id={m.userId}
              data-joined-at={m.joinedAt}
              data-left-at={m.leftAt ?? ""}
              className="flex flex-wrap items-center gap-x-2 text-xs"
            >
              <span className="font-medium">{who(m.userId)}</span>
              {m.host && <StatusBadge tone="neutral">{t("watchRooms.evidence.host")}</StatusBadge>}
              <span className="text-muted-foreground">
                {t("watchRooms.evidence.joined")} <RelativeTime date={m.joinedAt} />
              </span>
              <span className="text-muted-foreground">
                {m.leftAt ? (
                  <>
                    {t("watchRooms.evidence.left")} <RelativeTime date={m.leftAt} />
                  </>
                ) : (
                  t("watchRooms.evidence.stillIn")
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium">{t("watchRooms.evidence.messages")}</h4>
        {parsed.truncated && (
          <p className="text-sm text-muted-foreground">{t("watchRooms.evidence.truncated", { count: parsed.kept })}</p>
        )}
        {parsed.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("watchRooms.evidence.empty")}</p>
        ) : (
          <ol className="flex max-h-96 flex-col gap-1 overflow-y-auto">
            {parsed.messages.map((m) => (
              <li
                key={m.id}
                data-testid="watch-room-evidence-message"
                data-user-id={m.userId}
                data-at={m.at}
                className="text-xs"
              >
                <span className="font-medium">{who(m.userId)}</span>{" "}
                <span className="text-muted-foreground">
                  <RelativeTime date={m.at} />
                </span>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
