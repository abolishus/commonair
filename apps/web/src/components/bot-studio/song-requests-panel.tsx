// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The song request queue on `/bot`: links viewers asked for with `!sr`, marked played or skipped.
 * A link is shown as text and opens in a new tab (`rel="noopener noreferrer nofollow"`); nothing
 * is fetched, previewed or embedded (ADR 0026 decision 6).
 */
import { EmptyState, RelativeTime, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { MusicNote01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { orderedSongRequests, songLink, songStatusLabel, type SongRequestDto } from "../../lib/bot-studio.ts";
import { fillNode } from "../../lib/fill.tsx";
import { StudioSection, type StudioApi } from "../interact-studio/shared.tsx";

export function SongRequestsPanel({
  channel,
  initial,
  client,
}: {
  channel: string;
  initial: SongRequestDto[];
  client: StudioApi;
}): React.JSX.Element {
  const [rows, setRows] = React.useState(initial);
  const [busy, setBusy] = React.useState<string | null>(null);

  const mark = (row: SongRequestDto, status: "played" | "skipped"): void => {
    setBusy(row.id);
    client.bot.songRequests
      .setStatus({ channel, id: row.id, status })
      .then((next) => {
        setRows((list) => list.map((r) => (r.id === next.id ? next : r)));
        toast.success(status === "played" ? t("bot.sr.markedPlayed") : t("bot.sr.markedSkipped"));
      })
      .catch((err: unknown) => toastActionError(err, t("bot.sr.failed")))
      .finally(() => setBusy(null));
  };

  const ordered = orderedSongRequests(rows);
  return (
    <StudioSection icon={MusicNote01Icon} title={t("bot.sr.title")} description={t("bot.sr.intro")}>
      {ordered.length === 0 ? (
        <EmptyState data-testid="sr-empty" icon={MusicNote01Icon} headingLevel={3} title={t("bot.sr.empty")} />
      ) : (
        <ol className="flex flex-col divide-y" aria-label={t("bot.sr.title")}>
          {ordered.map((row) => {
            const href = songLink(row.url);
            return (
              <li
                key={row.id}
                data-testid="sr-row"
                data-id={row.id}
                data-status={row.status}
                className="flex flex-wrap items-center gap-2 py-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-sm break-all underline underline-offset-3"
                    >
                      {row.url}
                    </a>
                  ) : (
                    <span className="text-sm break-all">{row.url}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {fillNode(
                      t("bot.sr.requestedBy", { username: row.requester }),
                      "time",
                      <RelativeTime date={row.createdAt} />,
                    )}
                  </span>
                </div>
                {row.status === "queued" ? (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="sr-played"
                      disabled={busy === row.id}
                      onClick={() => mark(row, "played")}
                    >
                      {t("bot.sr.played")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="sr-skip"
                      disabled={busy === row.id}
                      onClick={() => mark(row, "skipped")}
                    >
                      {t("bot.sr.skip")}
                    </Button>
                  </div>
                ) : (
                  <StatusBadge tone="neutral">{songStatusLabel(row.status)}</StatusBadge>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </StudioSection>
  );
}
