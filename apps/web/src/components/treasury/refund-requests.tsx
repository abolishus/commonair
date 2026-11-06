// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Treasury `refunds` tab (ADR 0007 decisions 2 and 3, docs/testing/b8-selectors.md "Refund
 * requests"): provider refund requests (`money.treasurer.refundRequests`) with their markers, by
 * state: outstanding (still blocking a new refund of the payment), outcome unknown (the provider
 * did not answer; listed until something settles it) or all. A request whose outcome is unknown can
 * be resolved by hand, through a `ConfirmDialog`, once the reconciler has had its 15 minutes.
 *
 * `RefundRequests` loads its own data; `RefundRequestsPanel` takes it as props so tests can render
 * it with fixtures.
 */
import type { dto } from "@commonair/contracts";
import type { REFUND_MARKER_ACTIONS, REFUND_REQUEST_FILTERS, RefundRecheckResult } from "@commonair/contracts/enums";
import {
  ConfirmDialog,
  EmptyState,
  MoneyAmount,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from "@commonair/ui";
import { FilterBar } from "@commonair/ui/blocks/data";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from "@commonair/ui/components/item";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { MoneyReceive01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import { usePaged } from "../money/use-load.ts";
import { OutcomeUnknownSummary } from "./outcome-unknown-summary.tsx";
import { RecheckRefundDialog, recheckToast } from "./refund-recheck.tsx";

export type RefundRequestDto = z.infer<typeof dto.RefundRequestView>;
export type RefundRequestFilter = (typeof REFUND_REQUEST_FILTERS)[number];
export type RefundResolution = "refunded" | "failed";
type State = RefundRequestDto["state"];
type MarkerAction = (typeof REFUND_MARKER_ACTIONS)[number];

/** The contract's note limit (`refundRequests.resolve`). */
export const RESOLVE_NOTE_MAX = 500;
/** `resolve` is refused this long after the request (the reconciler asks the provider first). */
export const RESOLVE_GRACE_MS = 15 * 60 * 1000;
const PAGE = 50;

const FILTERS: readonly RefundRequestFilter[] = ["outstanding", "unknown", "all"];
const FILTER_LABEL: Record<RefundRequestFilter, MessageKey> = {
  outstanding: "refundRequests.filter.outstanding",
  unknown: "refundRequests.filter.unknown",
  all: "refundRequests.filter.all",
};
const STATE_LABEL: Record<State, MessageKey> = {
  outstanding: "refundRequests.state.outstanding",
  unknown: "refundRequests.state.unknown",
  resolved: "refundRequests.state.resolved",
};
const STATE_TONE: Record<State, StatusTone> = { outstanding: "info", unknown: "warning", resolved: "success" };
const MARKER_LABEL: Record<MarkerAction, MessageKey> = {
  "payment.refund_requested": "refundRequests.marker.requested",
  "payment.refund_submitted": "refundRequests.marker.submitted",
  "payment.refund_request_failed": "refundRequests.marker.failed",
  "payment.refund_outcome_unknown": "refundRequests.marker.unknown",
};
const KIND_LABEL: Record<RefundRequestDto["paymentKind"], MessageKey> = {
  subscription: "refundRequests.kind.subscription",
  tip: "refundRequests.kind.tip",
  membership_share: "refundRequests.kind.membership_share",
};
const OUTCOME_LABEL: Record<RefundResolution, MessageKey> = {
  refunded: "refundRequests.resolve.outcome.refunded",
  failed: "refundRequests.resolve.outcome.failed",
};
const EMPTY_TITLE: Record<RefundRequestFilter, MessageKey> = {
  outstanding: "refundRequests.empty.title",
  unknown: "refundRequests.empty.unknownTitle",
  all: "refundRequests.empty.allTitle",
};

const isFilter = (v: string): v is RefundRequestFilter => (FILTERS as readonly string[]).includes(v);
const isResolution = (v: unknown): v is RefundResolution => v === "refunded" || v === "failed";

/** Why a request cannot be resolved by hand now, or null when it can. */
export function resolveBlockedReason(r: RefundRequestDto, nowMs: number): string | null {
  if (r.state !== "unknown") return t("refundRequests.resolve.notUnknown");
  if (nowMs - Date.parse(r.createdAt) < RESOLVE_GRACE_MS) return t("refundRequests.resolve.tooSoon");
  return null;
}

export interface RefundRequestsPanelProps {
  /** null while the first page loads. */
  requests: RefundRequestDto[] | null;
  filter: RefundRequestFilter;
  onFilterChange: (f: RefundRequestFilter) => void;
  onResolve: (r: RefundRequestDto, outcome: RefundResolution, note: string) => Promise<void>;
  /** Ask Stripe again about an unknown request (follow-ups, unit money); omitted: no button. */
  onRecheck?: (r: RefundRequestDto) => Promise<void>;
  /** Injectable clock for the 15-minute rule. */
  now?: () => number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function RefundRequestsPanel({
  requests,
  filter,
  onFilterChange,
  onResolve,
  onRecheck,
  now = Date.now,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: RefundRequestsPanelProps): React.JSX.Element {
  return (
    <Section
      heading={t("refundRequests.title")}
      description={t("refundRequests.intro")}
      action={
        <FilterBar
          filters={[
            {
              id: "refund-request-state",
              label: t("refundRequests.filter"),
              value: filter,
              options: FILTERS.map((f) => ({ value: f, label: t(FILTER_LABEL[f]) })),
              onValueChange: (v) => onFilterChange(isFilter(v) ? v : "outstanding"),
            },
          ]}
        />
      }
    >
      {requests === null ? (
        <SkeletonGroup label={t("refundRequests.loading")}>
          <SkeletonText lines={4} />
        </SkeletonGroup>
      ) : requests.length === 0 ? (
        <EmptyState
          data-testid="refund-requests"
          icon={MoneyReceive01Icon}
          headingLevel={3}
          title={t(EMPTY_TITLE[filter])}
          description={t("refundRequests.empty.body")}
        />
      ) : (
        <ItemGroup className="gap-3" data-testid="refund-requests">
          {requests.map((r) => (
            <RefundRequestItem
              key={r.id}
              request={r}
              onResolve={onResolve}
              {...(onRecheck ? { onRecheck } : {})}
              nowMs={now()}
            />
          ))}
        </ItemGroup>
      )}
      {hasMore && onLoadMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            aria-busy={loadingMore || undefined}
            onClick={onLoadMore}
          >
            {t("refundRequests.loadMore")}
          </Button>
        </div>
      )}
    </Section>
  );
}

function RefundRequestItem({
  request: r,
  onResolve,
  onRecheck,
  nowMs,
}: {
  request: RefundRequestDto;
  onResolve: RefundRequestsPanelProps["onResolve"];
  onRecheck?: RefundRequestsPanelProps["onRecheck"];
  nowMs: number;
}): React.JSX.Element {
  const unknown = r.state === "unknown";
  return (
    <Item
      variant="outline"
      data-testid={unknown ? "refund-request-unknown" : undefined}
      data-request-id={r.id}
      data-payment-id={r.paymentId}
      data-state={r.state}
      data-reason={r.reason ?? undefined}
    >
      <ItemContent className="min-w-0 gap-2">
        <ItemTitle className="flex flex-wrap items-center gap-2">
          <MoneyAmount value={r.requested} />
          <StatusBadge tone={STATE_TONE[r.state]}>{t(STATE_LABEL[r.state])}</StatusBadge>
          {r.reason === "paid_after_end" && (
            <StatusBadge tone="neutral">{t("refundRequests.reason.paidAfterEnd")}</StatusBadge>
          )}
        </ItemTitle>
        <ItemDescription>
          {t("refundRequests.payment", { kind: t(KIND_LABEL[r.paymentKind]) })} <MoneyAmount value={r.amount} />
          {t("refundRequests.sentenceSeparator")}
          {r.requestedBy
            ? t("refundRequests.requestedBy", { username: r.requestedBy.username })
            : t("refundRequests.requestedBySystem")}{" "}
          <RelativeTime date={r.createdAt} />
        </ItemDescription>
        {unknown && <p className="text-sm text-muted-foreground">{t("refundRequests.unknownHint")}</p>}
      </ItemContent>
      {unknown && (
        <ItemActions className="flex-wrap items-start self-start">
          {onRecheck && (
            <RecheckRefundDialog
              requestId={r.id}
              blockedReason={resolveBlockedReason(r, nowMs)}
              onRecheck={() => onRecheck(r)}
            />
          )}
          <ResolveDialog request={r} blockedReason={resolveBlockedReason(r, nowMs)} onResolve={onResolve} />
        </ItemActions>
      )}
      <ItemFooter>
        <ol className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label={t("refundRequests.history")}>
          {r.markers.map((m, i) => (
            <li key={`${m.action}-${i}`} className="flex flex-wrap gap-x-2">
              <span>{t(MARKER_LABEL[m.action])}</span>
              <RelativeTime date={m.at} />
            </li>
          ))}
        </ol>
      </ItemFooter>
    </Item>
  );
}

function ResolveDialog({
  request: r,
  blockedReason,
  onResolve,
}: {
  request: RefundRequestDto;
  blockedReason: string | null;
  onResolve: RefundRequestsPanelProps["onResolve"];
}): React.JSX.Element {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState<RefundResolution | null>(null);
  const [note, setNote] = React.useState("");
  const trigger = (
    <Button
      variant="outline"
      size="sm"
      data-testid="refund-request-resolve"
      data-request-id={r.id}
      disabled={blockedReason !== null}
      aria-describedby={blockedReason ? `${id}-blocked` : undefined}
    >
      {t("refundRequests.resolve")}
    </Button>
  );
  return (
    <div className="flex flex-col items-end gap-1">
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setOutcome(null);
            setNote("");
          }
        }}
        trigger={trigger}
        title={t("refundRequests.resolve.title")}
        description={t("refundRequests.resolve.body")}
        confirmLabel={t("refundRequests.resolve.confirm")}
        confirmDisabled={outcome === null}
        onConfirm={async () => {
          if (outcome === null) return;
          await onResolve(r, outcome, note.trim());
        }}
        onError={(err) => toastActionError(err, t("refundRequests.resolve.error"))}
        contentProps={{ "data-testid": "refund-request-resolve-dialog" }}
      >
        <FieldSet>
          <FieldLegend variant="label">{t("refundRequests.resolve.outcome")}</FieldLegend>
          <RadioGroup
            value={outcome ?? ""}
            onValueChange={(v) => {
              if (isResolution(v)) setOutcome(v);
            }}
          >
            {(["refunded", "failed"] as const).map((o) => (
              <Field key={o} orientation="horizontal">
                <RadioGroupItem id={`${id}-${o}`} value={o} />
                <FieldLabel htmlFor={`${id}-${o}`} className="font-normal">
                  {t(OUTCOME_LABEL[o])}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <Field>
          <FieldLabel htmlFor={`${id}-note`}>{t("refundRequests.resolve.note")}</FieldLabel>
          <Textarea
            id={`${id}-note`}
            value={note}
            maxLength={RESOLVE_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </ConfirmDialog>
      {blockedReason && (
        <p id={`${id}-blocked`} className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      )}
    </div>
  );
}

/** The tab with its data (`money.treasurer.refundRequests.{list,resolve}`). */
export function RefundRequests(): React.JSX.Element {
  const [filter, setFilter] = React.useState<RefundRequestFilter>("outstanding");
  // Bumped after a settle, so the outcome-unknown summary reloads with the list.
  const [version, setVersion] = React.useState(0);
  const list = usePaged(
    `refund-requests|${filter}`,
    (cursor) => api().money.treasurer.refundRequests.list({ state: filter, limit: PAGE, cursor }),
    (err) => toastActionError(err, t("refundRequests.loadFailed")),
  );
  if (list.failed && list.items === null)
    return (
      <EmptyState
        data-testid="refund-requests"
        icon={MoneyReceive01Icon}
        headingLevel={3}
        title={t("refundRequests.loadFailed")}
        description={t("refundRequests.retryHint")}
        action={
          <Button variant="outline" size="sm" onClick={list.reload}>
            {t("refundRequests.retry")}
          </Button>
        }
      />
    );
  const reload = () => {
    list.reload();
    setVersion((v) => v + 1);
  };
  return (
    <>
      <OutcomeUnknownSummary version={version} />
      <RefundRequestsPanel
        requests={list.items}
        filter={filter}
        onFilterChange={setFilter}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        onLoadMore={list.loadMore}
        onResolve={async (r, outcome, note) => {
          try {
            await api().money.treasurer.refundRequests.resolve({ requestId: r.id, outcome, note });
          } catch (err) {
            // Settled meanwhile (a webhook, another treasurer): show the list as it is now.
            if (errorCode(err) === "CONFLICT") list.reload();
            throw err;
          }
          toast.success(t("refundRequests.resolve.done"));
          reload();
        }}
        onRecheck={async (r) => {
          let result: RefundRecheckResult;
          try {
            ({ result } = await api().money.treasurer.refundRequests.recheck({ requestId: r.id }));
          } catch (err) {
            if (errorCode(err) === "CONFLICT") reload();
            throw err;
          }
          const told = recheckToast(result);
          toast[told.tone](told.message);
          reload();
        }}
      />
    </>
  );
}
