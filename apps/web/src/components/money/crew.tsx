// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/crew` (W2-splits, ADR 0013): the owner proposes a revenue split (recipients, basis, basis
 * points, an optional window) with a plain-language preview, sees and ends its versions; a
 * recipient accepts or refuses what it was offered. Test ids: docs/testing/w2-selectors.md "Crew".
 */
import type { dto } from "@commonair/contracts";
import { SPLIT_BASES, SPLIT_RULES } from "@commonair/contracts/enums";
import {
  ConfirmDialog,
  EmptyState,
  IconButton,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  type StatusTone,
  formatMoney,
  formatNumber,
  useLocale,
} from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from "@commonair/ui/components/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, Delete02Icon, InformationCircleIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import type { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { DateTimeField } from "../studio/date-time-field.tsx";
import { EMPTY_DATE_TIME, dateTimeIso, upcomingYears, type DateTimeParts } from "../studio/date-time.ts";

export type SplitDto = z.infer<typeof dto.RevenueSplit>;
export type SplitBasis = (typeof SPLIT_BASES)[number];
type SplitStatus = SplitDto["status"];

/** The example payment the preview prices (a $10 tip, or 10 units of the instance currency). */
export const PREVIEW_EXAMPLE_CENTS = 1000;
const BPS_TOTAL = SPLIT_RULES.maxBpsTotal;

const BASIS_LABEL: Record<SplitBasis, MessageKey> = {
  tips: "splits.basis.tips",
  subs: "splits.basis.subs",
  all: "splits.basis.all",
};
const STATUS_LABEL: Record<SplitStatus, MessageKey> = {
  proposed: "splits.status.proposed",
  accepted: "splits.status.accepted",
  ended: "splits.status.ended",
  rejected: "splits.status.rejected",
};
const STATUS_TONE: Record<SplitStatus, StatusTone> = {
  proposed: "warning",
  accepted: "success",
  ended: "neutral",
  rejected: "danger",
};
const REQUIREMENT_MESSAGE: Record<string, MessageKey> = {
  split_recipient_account_age: "splits.error.accountAge",
  split_recipient_payout_account: "splits.error.payoutAccount",
  split_owner_is_crew: "splits.error.ownerIsCrew",
};

export const isBasis = (v: unknown): v is SplitBasis => SPLIT_BASES.some((b) => b === v);

export interface CrewRow {
  username: string;
  /** As typed; parsed by `parseBps`. */
  bps: string;
}

/** Basis points typed into the form, or null when not a whole number in [1, 9999]. */
export function parseBps(raw: string): number | null {
  const v = raw.trim();
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= SPLIT_RULES.minBps && n < BPS_TOTAL ? n : null;
}

/**
 * What a payment of `exampleCents` pays each person under these shares, with the ledger's
 * rounding: the co-op's cut first (floor of the creator share, `splitNet`), then the creator
 * share by basis points with the largest remainder (`splitNetN`). Ties go to the earlier name
 * here (the ledger orders by user id), so a split cent may land elsewhere. Null when a row is
 * incomplete or the crew's shares leave the owner nothing.
 */
export function crewPreview(
  exampleCents: number,
  streamerShare: number,
  rows: readonly { username: string; bps: number }[],
): { ownerCents: number; crew: { username: string; cents: number }[] } | null {
  const crewBps = rows.reduce((s, r) => s + r.bps, 0);
  if (rows.length === 0 || crewBps >= BPS_TOTAL || rows.some((r) => !r.username.trim())) return null;
  const share = Math.min(1, Math.max(0, Number.isFinite(streamerShare) ? streamerShare : 0));
  const micros = BigInt(Math.round(share * 1_000_000));
  const creator = (BigInt(Math.max(0, Math.trunc(exampleCents))) * micros) / 1_000_000n;
  const items = [
    { key: "", bps: BPS_TOTAL - crewBps },
    ...rows.map((r) => ({ key: r.username.trim().toLowerCase(), bps: r.bps })),
  ];
  const total = BigInt(BPS_TOTAL);
  const parts = items.map((i, index) => ({
    index,
    base: (creator * BigInt(i.bps)) / total,
    rem: (creator * BigInt(i.bps)) % total,
  }));
  let left = creator - parts.reduce((s, p) => s + p.base, 0n);
  for (const p of [...parts].sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1))) {
    if (left === 0n) break;
    if (p.rem === 0n) continue;
    p.base += 1n;
    left -= 1n;
  }
  return {
    ownerCents: Number(parts[0]?.base ?? 0n),
    crew: rows.map((r, k) => ({ username: r.username.trim(), cents: Number(parts[k + 1]?.base ?? 0n) })),
  };
}

/** A share in basis points as a percent label (1250 → "12.5%"). */
export function bpsPercent(bps: number, locale: string): string {
  return t("splits.percent", { value: formatNumber(bps / 100, locale) });
}

function errorMessage(err: unknown, fallback: MessageKey): string {
  const data = (err as { data?: { requirement?: unknown } } | null)?.data;
  const requirement = typeof data?.requirement === "string" ? REQUIREMENT_MESSAGE[data.requirement] : undefined;
  if (requirement) return t(requirement);
  if (errorCode(err) === "NOT_FOUND") return t("splits.error.notFound");
  if (errorCode(err) === "CONFLICT") return t("splits.error.conflict");
  return t(fallback);
}

/** The note on every crew page: crew are paid like any creator, by the treasurer, through the manual adapter. */
export function CrewPayoutNote(): React.JSX.Element {
  return (
    <Alert data-testid="crew-payout-note">
      <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden />
      <AlertDescription>{t("splits.payoutNote")}</AlertDescription>
    </Alert>
  );
}

export function CrewListSkeleton(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("splits.loading")}>
      <SkeletonText lines={4} />
    </SkeletonGroup>
  );
}

export interface ProposeInput {
  basis: SplitBasis;
  shares: { username: string; bps: number }[];
  startsAt?: string;
  endsAt?: string;
}

/** The chosen instant as ISO; undefined when left empty or not yet a whole date. */
function isoOf(parts: DateTimeParts): string | undefined {
  const r = dateTimeIso(parts);
  return "iso" in r ? r.iso : undefined;
}

/** The field's error once it has been touched or the form submitted (F32 timing), else null. */
function windowError(parts: DateTimeParts, show: boolean): string | null {
  if (!show) return null;
  const r = dateTimeIso(parts);
  if ("error" in r) return r.error === "incomplete" ? t("studio.dateTime.incomplete") : t("studio.dateTime.invalid");
  return null;
}

/** The owner's propose form with its live preview. */
export function CrewProposeForm({
  currency,
  streamerShare,
  onPropose,
  now,
}: {
  currency: string;
  /** The creator's share of a payment; null while it loads (the example is not priced on a guess). */
  streamerShare: number | null;
  onPropose: (input: ProposeInput) => Promise<void>;
  /** The request time, for the year list (server render and hydration agree). */
  now?: number;
}): React.JSX.Element {
  const { locale } = useLocale();
  const id = React.useId();
  const [basis, setBasis] = React.useState<SplitBasis>("tips");
  const [rows, setRows] = React.useState<CrewRow[]>([{ username: "", bps: "" }]);
  const [startsAt, setStartsAt] = React.useState<DateTimeParts>(EMPTY_DATE_TIME);
  const [endsAt, setEndsAt] = React.useState<DateTimeParts>(EMPTY_DATE_TIME);
  const [submitted, setSubmitted] = React.useState(false);
  const [touched, setTouched] = React.useState({ starts: false, ends: false });
  const [clock] = React.useState(() => now ?? Date.now());
  const years = upcomingYears(new Date(clock));
  const startsError = windowError(startsAt, submitted || touched.starts);
  const endsError = windowError(endsAt, submitted || touched.ends);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const parsed = rows.map((r) => ({ username: r.username.trim(), bps: parseBps(r.bps) }));
  const complete = parsed.every((r) => r.username !== "" && r.bps !== null);
  const valid = complete ? parsed.map((r) => ({ username: r.username, bps: r.bps ?? 0 })) : [];
  const crewBps = valid.reduce((s, r) => s + r.bps, 0);
  // What crewPreview accepts; proposing does not wait for the share (the server prices payments).
  const splitOk = valid.length > 0 && crewBps < BPS_TOTAL;
  const preview = splitOk && streamerShare !== null ? crewPreview(PREVIEW_EXAMPLE_CENTS, streamerShare, valid) : null;
  const names = new Set(valid.map((r) => r.username.toLowerCase()));
  const canSubmit = splitOk && names.size === valid.length && !pending;

  const update = (k: number, patch: Partial<CrewRow>) =>
    setRows((prev) => prev.map((r, i) => (i === k ? { ...r, ...patch } : r)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!canSubmit || "error" in dateTimeIso(startsAt) || "error" in dateTimeIso(endsAt)) return;
    setPending(true);
    setError(null);
    try {
      const starts = isoOf(startsAt);
      const ends = isoOf(endsAt);
      await onPropose({
        basis,
        shares: valid,
        ...(starts ? { startsAt: starts } : {}),
        ...(ends ? { endsAt: ends } : {}),
      });
      setRows([{ username: "", bps: "" }]);
      setStartsAt(EMPTY_DATE_TIME);
      setEndsAt(EMPTY_DATE_TIME);
      setSubmitted(false);
      toast.success(t("splits.propose.done"));
    } catch (err) {
      if (isSessionExpired(err)) toastActionError(err, t("splits.propose.failed"));
      else setError(errorMessage(err, "splits.propose.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("splits.propose.title")}</CardTitle>
        <CardDescription>{t("splits.propose.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          data-testid="crew-propose-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => void submit(e)}
          noValidate
        >
          <Field>
            <FieldLabel htmlFor={`${id}-basis`}>{t("splits.basis")}</FieldLabel>
            <Select<string>
              value={basis}
              onValueChange={(v) => {
                if (isBasis(v)) setBasis(v);
              }}
            >
              <SelectTrigger id={`${id}-basis`} data-testid="crew-basis" data-value={basis} className="w-full sm:w-72">
                <SelectValue>{(v: string) => (isBasis(v) ? t(BASIS_LABEL[v]) : null)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SPLIT_BASES.map((b) => (
                  <SelectItem key={b} value={b} data-testid={`crew-basis-${b}`}>
                    {t(BASIS_LABEL[b])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <ul className="flex flex-col gap-3">
            {rows.map((r, k) => (
              <li key={k} className="flex flex-wrap items-end gap-3">
                <Field className="min-w-0 flex-1 basis-48">
                  <FieldLabel htmlFor={`${id}-user-${k}`}>{t("splits.recipient")}</FieldLabel>
                  <Input
                    id={`${id}-user-${k}`}
                    data-testid="crew-recipient"
                    value={r.username}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(e) => update(k, { username: e.currentTarget.value })}
                  />
                </Field>
                <Field className="w-36">
                  <FieldLabel htmlFor={`${id}-bps-${k}`}>{t("splits.bps")}</FieldLabel>
                  <Input
                    id={`${id}-bps-${k}`}
                    data-testid="crew-bps"
                    inputMode="numeric"
                    value={r.bps}
                    aria-describedby={`${id}-bps-hint`}
                    onChange={(e) => update(k, { bps: e.currentTarget.value })}
                  />
                </Field>
                {rows.length > 1 && (
                  <IconButton
                    type="button"
                    variant="ghost"
                    icon={Delete02Icon}
                    label={t("splits.removeRecipient")}
                    onClick={() => setRows((prev) => prev.filter((_, i) => i !== k))}
                  />
                )}
              </li>
            ))}
          </ul>
          <p id={`${id}-bps-hint`} className="text-xs text-muted-foreground">
            {t("splits.bpsHint", { percent: bpsPercent(crewBps, locale) })}
          </p>
          {rows.length < SPLIT_RULES.maxRecipients && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRows((prev) => [...prev, { username: "", bps: "" }])}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
                {t("splits.addRecipient")}
              </Button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <DateTimeField
              data-testid="crew-starts"
              legend={t("splits.startsAt")}
              hint={t("splits.startsAtHint")}
              value={startsAt}
              onValueChange={setStartsAt}
              onBlur={() => setTouched((p) => ({ ...p, starts: true }))}
              years={years}
              error={startsError}
            />
            <DateTimeField
              data-testid="crew-ends"
              legend={t("splits.endsAt")}
              hint={t("splits.endsAtHint")}
              value={endsAt}
              onValueChange={setEndsAt}
              onBlur={() => setTouched((p) => ({ ...p, ends: true }))}
              years={years}
              error={endsError}
            />
          </div>
          <section
            data-testid="crew-preview"
            data-example-cents={PREVIEW_EXAMPLE_CENTS}
            data-recipient-cents={preview?.crew[0]?.cents ?? ""}
            aria-live="polite"
            className="flex flex-col gap-1 rounded-md border border-border p-3 text-xs/relaxed"
          >
            <h3 className="font-medium">{t("splits.preview.title")}</h3>
            {preview ? (
              <>
                <p>{t("splits.preview.lead", { example: formatMoney(PREVIEW_EXAMPLE_CENTS, currency, locale) })}</p>
                <ul className="flex flex-col gap-0.5 ps-4">
                  <li className="list-disc">
                    {t("splits.preview.owner", { amount: formatMoney(preview.ownerCents, currency, locale) })}
                  </li>
                  {preview.crew.map((c) => (
                    <li key={c.username} className="list-disc">
                      {t("splits.preview.recipient", {
                        username: c.username,
                        amount: formatMoney(c.cents, currency, locale),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-muted-foreground">
                {splitOk
                  ? t("splits.preview.loading")
                  : crewBps >= BPS_TOTAL
                    ? t("splits.preview.tooMuch")
                    : t("splits.preview.invalid")}
              </p>
            )}
          </section>
          {error && (
            <Alert variant="destructive" data-testid="form-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button type="submit" data-testid="crew-propose-submit" disabled={!canSubmit}>
              {t("splits.propose.submit")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** One version: its status, window and shares, and what the viewer may do with it. */
export function CrewSplitItem({
  split,
  meId,
  canEnd,
  onAnswer,
  onEnd,
}: {
  split: SplitDto;
  meId: string;
  canEnd: boolean;
  onAnswer: (id: string, accept: boolean) => Promise<void>;
  onEnd: (id: string) => Promise<void>;
}): React.JSX.Element {
  const { locale } = useLocale();
  const mine = split.shares.find((s) => s.recipient.id === meId);
  const answerable = split.status === "proposed" && mine !== undefined && mine.decision === null;
  const [busy, setBusy] = React.useState(false);
  const answer = async (accept: boolean) => {
    setBusy(true);
    try {
      await onAnswer(split.id, accept);
      toast.success(t(accept ? "splits.accept.done" : "splits.reject.done"));
    } catch (err) {
      if (isSessionExpired(err)) toastActionError(err, t("splits.answer.failed"));
      else toast.error(errorMessage(err, "splits.answer.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Item
      variant="outline"
      data-testid="crew-split"
      data-split-id={split.id}
      data-version={split.version}
      data-status={split.status}
      data-basis={split.basis}
    >
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-2">
          <span>{t("splits.version", { version: split.version, channel: split.channelSlug })}</span>
          <StatusBadge tone={STATUS_TONE[split.status]}>{t(STATUS_LABEL[split.status])}</StatusBadge>
          <span className="text-sm font-normal text-muted-foreground">{t(BASIS_LABEL[split.basis])}</span>
        </ItemTitle>
        <ItemDescription className="flex flex-wrap gap-x-2">
          <span>{t("splits.from")}</span>
          <RelativeTime date={split.startsAt} />
          {split.endsAt && (
            <>
              <span>{t("splits.until")}</span>
              <RelativeTime date={split.endsAt} />
            </>
          )}
        </ItemDescription>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {split.shares.map((s) => (
            <li
              key={s.recipient.id}
              data-testid="crew-share"
              data-user-id={s.recipient.id}
              data-bps={s.bps}
              data-accepted={s.decision === "accepted" ? "true" : "false"}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <span className="font-medium">
                {t("splits.share", { username: s.recipient.username, percent: bpsPercent(s.bps, locale) })}
              </span>
              <span className="text-muted-foreground">
                {t(
                  s.decision === "accepted"
                    ? "splits.decision.accepted"
                    : s.decision === "rejected"
                      ? "splits.decision.rejected"
                      : "splits.decision.pending",
                )}
              </span>
            </li>
          ))}
        </ul>
      </ItemContent>
      <ItemActions className="flex flex-wrap gap-2">
        {answerable && (
          <>
            <Button size="sm" data-testid="crew-accept" disabled={busy} onClick={() => void answer(true)}>
              {t("splits.accept")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="crew-reject"
              disabled={busy}
              onClick={() => void answer(false)}
            >
              {t("splits.reject")}
            </Button>
          </>
        )}
        {canEnd && (split.status === "accepted" || split.status === "proposed") && (
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="outline" data-testid="crew-end">
                {t("splits.end")}
              </Button>
            }
            title={t("splits.end.title", { version: split.version })}
            description={t("splits.end.hint")}
            confirmLabel={t("splits.end.confirm")}
            variant="destructive"
            onConfirm={async () => {
              await onEnd(split.id);
              toast.success(t("splits.end.done"));
            }}
            onError={(err) =>
              isSessionExpired(err)
                ? toastActionError(err, t("splits.end.failed"))
                : toast.error(errorMessage(err, "splits.end.failed"))
            }
            // ConfirmDialog names its own confirm button; this wraps it.
            contentProps={{ "data-testid": "crew-end-confirm" }}
          />
        )}
      </ItemActions>
      {split.acceptedAt && (
        <ItemFooter className="text-xs text-muted-foreground">
          <span>{t("splits.acceptedAt")}</span> <RelativeTime date={split.acceptedAt} />
        </ItemFooter>
      )}
    </Item>
  );
}

/** A list of versions, or its empty state. */
export function CrewSplitList({
  splits,
  meId,
  canEnd,
  empty,
  onAnswer,
  onEnd,
}: {
  splits: readonly SplitDto[];
  meId: string;
  canEnd: boolean;
  /** `action`: the owner's way to fill it (F25); a list others fill has none. */
  empty: { title: MessageKey; hint: MessageKey; action?: React.ReactNode };
  onAnswer: (id: string, accept: boolean) => Promise<void>;
  onEnd: (id: string) => Promise<void>;
}): React.JSX.Element {
  if (splits.length === 0)
    return (
      <EmptyState
        data-testid="crew-empty"
        icon={UserGroupIcon}
        title={t(empty.title)}
        description={t(empty.hint)}
        headingLevel={3}
        action={empty.action}
      />
    );
  return (
    <ItemGroup className="gap-3">
      {splits.map((s) => (
        <CrewSplitItem key={s.id} split={s} meId={meId} canEnd={canEnd} onAnswer={onAnswer} onEnd={onEnd} />
      ))}
    </ItemGroup>
  );
}

/** Splits the viewer receives, with a running total of what is pending their answer. */
export function CrewOffered({
  splits,
  meId,
  onAnswer,
}: {
  splits: readonly SplitDto[];
  meId: string;
  onAnswer: (id: string, accept: boolean) => Promise<void>;
}): React.JSX.Element {
  const waiting = splits.filter((s) => s.awaitingYou).length;
  return (
    <Section
      heading={t("splits.offered.title")}
      description={waiting > 0 ? t("splits.offered.waiting", { count: waiting }) : t("splits.offered.hint")}
    >
      <CrewSplitList
        splits={splits}
        meId={meId}
        canEnd={false}
        empty={{ title: "splits.offered.empty", hint: "splits.offered.emptyHint" }}
        onAnswer={onAnswer}
        onEnd={async () => undefined}
      />
    </Section>
  );
}
