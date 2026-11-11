// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, formatMoney, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { monthLabel } from "../../lib/money.ts";
import type { Deficit, NotedMonth } from "./model.ts";

/**
 * The honest deficit note (coop-trust P3.4, voice-copy 4.12): the gap in figures, then the
 * treasurer's own note when one exists, else the promise to publish one. It never says who covers
 * the gap unless the treasurer wrote it, and makes no claim about the creators' share and the gap
 * (README open question 4 is unconfirmed, so the conservative reading says nothing).
 */
export function DeficitNote({ deficit, note }: { deficit: Deficit; note: NotedMonth | null }): React.JSX.Element {
  const { locale } = useLocale();
  const money = (cents: number) => formatMoney(cents, deficit.currency, locale);
  return (
    <AlertCallout
      data-testid="transparency-deficit"
      data-gap={deficit.gap}
      tone="info"
      title={t("d6Transparency.deficit.title")}
      description={
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {t("d6Transparency.deficit.body", {
              months: deficit.months,
              costs: money(deficit.costs),
              retained: money(deficit.retained),
              gap: money(deficit.gap),
            })}
          </p>
          {note ? (
            <figure data-testid="transparency-deficit-note" data-month={note.month} className="flex flex-col gap-1">
              <figcaption className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>{t("d6Transparency.deficit.noteTitle", { month: monthLabel(note.month) })}</span>
                <span>
                  {t("d6Transparency.deficit.noteUpdated")} <RelativeTime date={note.updatedAt} />
                </span>
              </figcaption>
              <blockquote className="border-l-2 border-border pl-3 break-words whitespace-pre-line">
                {note.body}
              </blockquote>
            </figure>
          ) : (
            <p data-testid="transparency-deficit-missing">{t("d6Transparency.deficit.fundingMissing")}</p>
          )}
          <p className="text-muted-foreground">{t("d6Transparency.deficit.commitment")}</p>
        </div>
      }
    />
  );
}

/** The treasurer's note when the months shown have no deficit: the same words, without the gap. */
export function TreasurerNote({ note }: { note: NotedMonth }): React.JSX.Element {
  return (
    <AlertCallout
      data-testid="transparency-treasurer-note"
      data-month={note.month}
      tone="neutral"
      title={t("d6Transparency.deficit.noteTitle", { month: monthLabel(note.month) })}
      description={
        <div className="flex flex-col gap-1 text-sm">
          <p className="break-words whitespace-pre-line">{note.body}</p>
          <p className="text-xs text-muted-foreground">
            {t("d6Transparency.deficit.noteUpdated")} <RelativeTime date={note.updatedAt} />
          </p>
        </div>
      }
    />
  );
}
