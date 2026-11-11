// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Treasury `shares` tab, overhaul wave 5 (ADR 0042 decision 5): members holding a share whose
 * account deletion is scheduled, soonest first, with the date and "Ask for refund details"
 * (`coop.shares.askRefundDetails`, behind a `ConfirmDialog`). The platform emails the member; the
 * treasurer never sees the address. Asking again within a day is refused, so the button says when
 * it was last asked and waits.
 *
 * `LeavingSharesPanel` takes the shares as props (tests render it with fixtures);
 * `CoopSharesTab` (coop/treasury-tabs.tsx) loads them with `loadLeavingShares`, which reads every
 * page of held shares: a member leaving can hold any of them, not only the newest page.
 */
import { ConfirmDialog, MoneyAmount, RelativeTime } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import type { ShareDto } from "../../lib/coop.ts";
import { fillNode } from "../../lib/fill.tsx";

/** `coop.shares.askRefundDetails` allows one request a day per share. */
export const ASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Held shares per request while looking for members leaving (the contract's maximum). */
export const LEAVING_PAGE = 100;
/** At most this many pages are read; past it the panel says the list may be incomplete. */
export const LEAVING_MAX_PAGES = 50;

export interface LeavingLoad {
  /** Shares of members leaving, soonest first. */
  shares: ShareDto[];
  /** More held shares exist than `LEAVING_MAX_PAGES` pages: some leaving members may be missing. */
  truncated: boolean;
}

/**
 * Every page of held shares, kept to the ones whose member is leaving. `list` is
 * `coop.shares.list({ status: "held" })` for a cursor.
 */
export async function loadLeavingShares(
  list: (cursor: string | undefined, limit: number) => Promise<{ items: ShareDto[]; nextCursor: string | null }>,
  maxPages = LEAVING_MAX_PAGES,
): Promise<LeavingLoad> {
  const found: ShareDto[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const page = await list(cursor, LEAVING_PAGE);
    found.push(...page.items.filter((s) => s.deletionScheduledFor !== null));
    if (page.nextCursor === null) return { shares: leavingShares(found) ?? [], truncated: false };
    cursor = page.nextCursor;
  }
  return { shares: leavingShares(found) ?? [], truncated: true };
}

/** The shares whose member has a deletion scheduled, soonest first (pure). */
export function leavingShares(shares: readonly ShareDto[] | null): ShareDto[] | null {
  if (shares === null) return null;
  return shares
    .filter((s) => s.deletionScheduledFor !== null)
    .toSorted((a, b) => Date.parse(a.deletionScheduledFor ?? "") - Date.parse(b.deletionScheduledFor ?? ""));
}

/** Whether the member was asked less than a day ago (the API would refuse). */
export function askedRecently(share: Pick<ShareDto, "refundDetailsRequestedAt">, nowMs: number): boolean {
  if (!share.refundDetailsRequestedAt) return false;
  return nowMs - Date.parse(share.refundDetailsRequestedAt) < ASK_COOLDOWN_MS;
}

/** What a refused ask tells the treasurer (pure). */
export function askErrorText(err: unknown): string {
  return errorCode(err) === "CONFLICT" ? t("w5Deletion.treasury.askTooSoon") : t("w5Deletion.treasury.askFailed");
}

export interface LeavingSharesPanelProps {
  /** Shares of members leaving (`leavingShares`); null while loading. Nothing renders when empty. */
  shares: ShareDto[] | null;
  /** Not every held share was checked (`LeavingLoad.truncated`). */
  truncated?: boolean;
  onAsk: (share: ShareDto) => Promise<void>;
  now?: () => number;
}

export function LeavingSharesPanel({
  shares,
  truncated = false,
  onAsk,
  now = Date.now,
}: LeavingSharesPanelProps): React.JSX.Element | null {
  if (!shares || (shares.length === 0 && !truncated)) return null;
  const nowMs = now();
  return (
    <Section
      heading={t("w5Deletion.treasury.title")}
      description={t("w5Deletion.treasury.intro")}
      data-testid="treasury-leaving-shares"
    >
      {truncated ? (
        <p className="text-muted-foreground text-sm" data-testid="treasury-leaving-shares-truncated">
          {t("w5Deletion.treasury.truncated")}
        </p>
      ) : null}
      <ItemGroup className="gap-3">
        {shares.map((share) => (
          <LeavingShareItem key={share.id} share={share} onAsk={onAsk} recent={askedRecently(share, nowMs)} />
        ))}
      </ItemGroup>
    </Section>
  );
}

function LeavingShareItem({
  share,
  onAsk,
  recent,
}: {
  share: ShareDto;
  onAsk: LeavingSharesPanelProps["onAsk"];
  recent: boolean;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <Item variant="outline" data-testid="treasury-leaving-share" data-share-id={share.id}>
      <ItemContent className="min-w-0 gap-1">
        <ItemTitle className="flex flex-wrap items-center gap-2">
          <span>{share.user.displayName}</span>
          <MoneyAmount value={share.amount} />
        </ItemTitle>
        <ItemDescription className="flex flex-col gap-1">
          {share.deletionScheduledFor ? (
            <span>
              {t("w5Deletion.treasury.deletesOn")} <RelativeTime date={share.deletionScheduledFor} />
            </span>
          ) : null}
          <span data-testid="treasury-leaving-share-asked">
            {share.refundDetailsRequestedAt ? (
              <>
                {t("w5Deletion.treasury.lastAsked")} <RelativeTime date={share.refundDetailsRequestedAt} />
              </>
            ) : (
              t("w5Deletion.treasury.neverAsked")
            )}
          </span>
        </ItemDescription>
      </ItemContent>
      <ItemActions className="self-start">
        <ConfirmDialog
          trigger={
            <Button
              variant="outline"
              size="sm"
              data-testid="treasury-share-ask-refund-details"
              disabled={recent}
              aria-describedby={recent ? `${id}-recent` : undefined}
            >
              {t("w5Deletion.treasury.ask")}
            </Button>
          }
          title={t("w5Deletion.treasury.askTitle", { name: share.user.displayName })}
          description={fillNode(t("w5Deletion.treasury.askBody"), "amount", <MoneyAmount value={share.amount} />)}
          confirmLabel={t("w5Deletion.treasury.askConfirm")}
          onConfirm={async () => {
            await onAsk(share);
            toast.success(t("w5Deletion.treasury.asked"));
          }}
          onError={(err) => toastActionError(err, askErrorText(err))}
          contentProps={{ "data-testid": "treasury-share-ask-refund-details-dialog" }}
        />
        {recent ? (
          <p id={`${id}-recent`} className="sr-only">
            {t("w5Deletion.treasury.askedToday")}
          </p>
        ) : null}
      </ItemActions>
    </Item>
  );
}
