// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The treasury's "Fraud review" tab (ADR 0036, docs/testing/w1-selectors.md "Fraud floor"): flags
 * with their evidence in plain words, the payee's held payouts, the first review and the second
 * person's decision, and a form to hold a payee by hand. Data and actions come in as props (the
 * route wires them to `money.treasurer.fraudFlags.*`), so tests can render it with fixtures.
 * There is no release control: an admin releases a confirmed flag through the API (W1).
 */
import type { dto } from "@commonair/contracts";
import { PAYMENT_FRAUD_RULES, type PAYMENT_FRAUD_DECISIONS, PAYMENT_FRAUD_STATUSES } from "@commonair/contracts/enums";
import {
  ConfirmDialog,
  EmptyState,
  MoneyAmount,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  type StatusTone,
  formatNumber,
  useLocale,
} from "@commonair/ui";
import { FilterBar } from "@commonair/ui/blocks/data";
import { FormSection } from "@commonair/ui/blocks/forms";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
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
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";

export type PaymentFraudFlagDto = z.infer<typeof dto.PaymentFraudFlag>;
type Status = PaymentFraudFlagDto["status"];
type Kind = PaymentFraudFlagDto["kind"];
export type FraudDecision = (typeof PAYMENT_FRAUD_DECISIONS)[number];
/** The list filter: one status, or every flag. */
export type FraudStatusFilter = Status | "all";

/** The contract's note limit (`fraudFlags.raise/review/decide`). */
export const FRAUD_NOTE_MAX = 500;

const KIND_LABEL: Record<Kind, MessageKey> = {
  payer_velocity: "fraud.kind.payer_velocity",
  payer_concentration: "fraud.kind.payer_concentration",
  new_payee: "fraud.kind.new_payee",
  manual: "fraud.kind.manual",
};
const KIND_HINT: Record<Kind, MessageKey> = {
  payer_velocity: "fraud.kindHint.payer_velocity",
  payer_concentration: "fraud.kindHint.payer_concentration",
  new_payee: "fraud.kindHint.new_payee",
  manual: "fraud.kindHint.manual",
};
const STATUS_LABEL: Record<Status, MessageKey> = {
  open: "fraud.status.open",
  reviewed: "fraud.status.reviewed",
  cleared: "fraud.status.cleared",
  confirmed: "fraud.status.confirmed",
};
const STATUS_TONE: Record<Status, StatusTone> = {
  open: "warning",
  reviewed: "info",
  cleared: "success",
  confirmed: "danger",
};
const DECISION_LABEL: Record<FraudDecision, MessageKey> = {
  clear: "fraud.decision.clear",
  confirm: "fraud.decision.confirm",
};

const isFilter = (v: string): v is FraudStatusFilter => v === "all" || PAYMENT_FRAUD_STATUSES.some((s) => s === v);
const isDecision = (v: unknown): v is FraudDecision => v === "clear" || v === "confirm";

/** The readable hold reason of a payout held for fraud review (other reasons: `holdReasonLabel`). */
export function fraudHoldLabel(): string {
  return t("fraud.holdReason");
}

/** Why `meId` may not decide this flag (four eyes), or null. */
export function decideBlockedReason(flag: PaymentFraudFlagDto, meId: string): string | null {
  if (flag.payee.id === meId) return t("fraud.decide.ownPayouts");
  if (flag.reviewedBy?.id === meId) return t("fraud.decide.youReviewed");
  if (flag.raisedBy?.id === meId) return t("fraud.decide.youRaised");
  return null;
}

const num = (v: string | number | undefined): number => (typeof v === "number" ? v : Number(v ?? 0));

/** A share in basis points as a percent string (8000 → "80"). */
function percent(bps: number, locale: string): string {
  return t("fraud.percent", { value: formatNumber(Math.floor(bps) / 100, locale) });
}

/** The flag's evidence in plain words, one line per fact. */
export function FraudEvidence({
  flag,
  currency,
}: {
  flag: PaymentFraudFlagDto;
  currency: string;
}): React.JSX.Element | null {
  const { locale } = useLocale();
  const e = flag.evidence;
  const rows: { label: string; value: React.ReactNode }[] = [];
  switch (flag.kind) {
    case "payer_velocity":
      rows.push(
        {
          label: t("fraud.evidence.velocityPayments", { minutes: PAYMENT_FRAUD_RULES.velocityWindowMinutes }),
          value: formatNumber(num(e.payments), locale),
        },
        {
          label: t("fraud.evidence.velocityStart"),
          value: typeof e.windowStart === "string" ? <RelativeTime date={e.windowStart} /> : null,
        },
      );
      break;
    case "payer_concentration":
      rows.push(
        {
          label: t("fraud.evidence.gross", { days: PAYMENT_FRAUD_RULES.concentrationWindowDays }),
          value: <MoneyAmount value={{ cents: num(e.grossCents), currency }} />,
        },
        {
          label: t("fraud.evidence.topShare", { count: PAYMENT_FRAUD_RULES.concentrationTopN }),
          value: percent(num(e.topShareBps), locale),
        },
        {
          label: t("fraud.evidence.newPayerShare", { days: PAYMENT_FRAUD_RULES.newPayerAccountDays }),
          value: percent(num(e.newPayerShareBps), locale),
        },
        { label: t("fraud.evidence.payers"), value: formatNumber(num(e.payers), locale) },
      );
      break;
    case "new_payee":
      rows.push({
        label: t("fraud.evidence.firstPayout"),
        value: <MoneyAmount value={{ cents: num(e.payoutCents), currency }} />,
      });
      break;
    case "manual":
      break;
  }
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2" data-testid="fraud-flag-evidence">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-wrap items-baseline justify-between gap-2 sm:contents">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="font-medium tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The recommendation or decision choice inside the review and decide dialogs. */
function DecisionChoice({
  value,
  onChange,
  legend,
}: {
  value: FraudDecision | null;
  onChange: (v: FraudDecision) => void;
  legend: string;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <RadioGroup
        data-testid="fraud-decision"
        value={value ?? ""}
        onValueChange={(v) => {
          if (isDecision(v)) onChange(v);
        }}
      >
        {(["clear", "confirm"] as const).map((d) => (
          <Field key={d} orientation="horizontal">
            <RadioGroupItem id={`${id}-${d}`} value={d} data-testid={`fraud-decision-${d}`} />
            <FieldLabel htmlFor={`${id}-${d}`} className="font-normal">
              {t(DECISION_LABEL[d])}
            </FieldLabel>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const id = React.useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("fraud.note")}</FieldLabel>
      <Textarea
        id={id}
        data-testid="fraud-note"
        value={value}
        maxLength={FRAUD_NOTE_MAX}
        rows={3}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <FieldDescription>{t("fraud.noteHint")}</FieldDescription>
    </Field>
  );
}

/** Who did what so far, in plain words. */
function FlagHistory({ flag }: { flag: PaymentFraudFlagDto }): React.JSX.Element {
  const line = (text: string, at: string | null) => (
    <li className="flex flex-wrap gap-x-1">
      <span>{text}</span>
      {at && <RelativeTime date={at} className="text-muted-foreground" />}
    </li>
  );
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {line(
        flag.raisedBy
          ? t("fraud.history.raisedBy", { username: flag.raisedBy.username })
          : t("fraud.history.raisedByScan"),
        flag.raisedAt,
      )}
      {flag.reviewedBy &&
        flag.recommendation &&
        line(
          t("fraud.history.reviewed", {
            username: flag.reviewedBy.username,
            recommendation: t(DECISION_LABEL[flag.recommendation]),
          }),
          flag.reviewedAt,
        )}
      {flag.decidedBy &&
        line(
          t(flag.status === "cleared" ? "fraud.history.cleared" : "fraud.history.confirmed", {
            username: flag.decidedBy.username,
          }),
          flag.decidedAt,
        )}
      {flag.releasedBy && line(t("fraud.history.released", { username: flag.releasedBy.username }), flag.releasedAt)}
    </ul>
  );
}

export interface FraudFlagItemProps {
  flag: PaymentFraudFlagDto;
  meId: string;
  currency: string;
  onReview: (flag: PaymentFraudFlagDto, recommendation: FraudDecision, note: string) => Promise<void>;
  onDecide: (flag: PaymentFraudFlagDto, decision: FraudDecision, note: string) => Promise<void>;
}

export function FraudFlagItem({ flag, meId, currency, onReview, onDecide }: FraudFlagItemProps): React.JSX.Element {
  const released = flag.releasedAt !== null;
  const holding = flag.status === "open" || flag.status === "reviewed" || (flag.status === "confirmed" && !released);
  return (
    <Item
      variant="outline"
      data-testid="fraud-flag"
      data-flag-id={flag.id}
      data-kind={flag.kind}
      data-status={flag.status}
      data-payee={flag.payee.username}
      data-released={released ? "true" : "false"}
      data-held-payouts={flag.heldPayouts}
    >
      <ItemContent className="min-w-0 gap-2">
        <ItemTitle className="flex flex-wrap items-center gap-2">
          <span>{t(KIND_LABEL[flag.kind])}</span>
          <StatusBadge tone={STATUS_TONE[flag.status]}>{t(STATUS_LABEL[flag.status])}</StatusBadge>
        </ItemTitle>
        <ItemDescription>
          {t("fraud.payee", { name: flag.payee.displayName, username: flag.payee.username })}
          {t("fraud.sentenceSeparator")}
          {t(KIND_HINT[flag.kind])}
        </ItemDescription>
        <FraudEvidence flag={flag} currency={currency} />
        <p className="text-sm" data-testid="fraud-flag-held">
          {holding ? t("fraud.heldPayouts", { count: flag.heldPayouts }) : t("fraud.releasedPayouts")}
        </p>
        {flag.status === "confirmed" && (
          <p className="text-sm text-muted-foreground" data-testid="fraud-flag-confirmed">
            {released
              ? t("fraud.confirmed.released", { username: flag.releasedBy?.username ?? "" })
              : t("fraud.confirmed.held")}
          </p>
        )}
        {flag.note && (
          <p className="text-sm break-words whitespace-pre-line">
            <span className="text-muted-foreground">{t("fraud.noteShown")}</span> {flag.note}
          </p>
        )}
      </ItemContent>
      {(flag.status === "open" || flag.status === "reviewed") && (
        <ItemActions className="self-start">
          <FlagActionDialog
            flag={flag}
            mode={flag.status === "open" ? "review" : "decide"}
            disabledReason={
              flag.status === "open"
                ? flag.payee.id === meId
                  ? t("fraud.review.ownPayouts")
                  : null
                : decideBlockedReason(flag, meId)
            }
            onSubmit={(choice, note) =>
              flag.status === "open" ? onReview(flag, choice, note) : onDecide(flag, choice, note)
            }
          />
        </ItemActions>
      )}
      <ItemFooter>
        <FlagHistory flag={flag} />
      </ItemFooter>
    </Item>
  );
}

/** Review (open) or decide (reviewed): a confirm dialog with the choice and a note. */
function FlagActionDialog({
  flag,
  mode,
  disabledReason,
  onSubmit,
}: {
  flag: PaymentFraudFlagDto;
  mode: "review" | "decide";
  disabledReason: string | null;
  onSubmit: (choice: FraudDecision, note: string) => Promise<void>;
}): React.JSX.Element {
  const [choice, setChoice] = React.useState<FraudDecision | null>(null);
  const [note, setNote] = React.useState("");
  const review = mode === "review";
  const hintId = React.useId();
  return (
    <div className="flex max-w-xs flex-col items-start gap-1">
      <ConfirmDialog
        trigger={
          <Button
            size="sm"
            variant={review ? "outline" : "default"}
            disabled={disabledReason !== null}
            data-testid={review ? "fraud-flag-review" : "fraud-flag-decide"}
            aria-label={t(review ? "fraud.review.label" : "fraud.decide.label", { username: flag.payee.username })}
            aria-describedby={hintId}
          >
            {t(review ? "fraud.review.button" : "fraud.decide.button")}
          </Button>
        }
        onOpenChange={(open) => {
          if (open) {
            setChoice(null);
            setNote("");
          }
        }}
        title={t(review ? "fraud.review.title" : "fraud.decide.title", { username: flag.payee.username })}
        description={t(review ? "fraud.review.hint" : "fraud.decide.hint")}
        confirmLabel={t(review ? "fraud.review.submit" : "fraud.decide.submit")}
        confirmDisabled={choice === null}
        variant={!review && choice === "confirm" ? "destructive" : "default"}
        onConfirm={async () => {
          if (choice === null) return;
          await onSubmit(choice, note.trim());
          toast.success(t(review ? "fraud.review.done" : "fraud.decide.done"));
        }}
        onError={(err) => toastActionError(err, t(review ? "fraud.review.failed" : "fraud.decide.failed"))}
        contentProps={{ "data-testid": review ? "fraud-review-dialog" : "fraud-decide-dialog" }}
      >
        <div className="flex flex-col gap-4">
          <DecisionChoice
            value={choice}
            onChange={setChoice}
            legend={t(review ? "fraud.review.choice" : "fraud.decide.choice")}
          />
          <NoteField value={note} onChange={setNote} />
        </div>
      </ConfirmDialog>
      {/* The button explains itself: a decision always needs a second person. */}
      <p id={hintId} className="text-xs text-muted-foreground" data-testid="fraud-flag-action-hint">
        {disabledReason ?? t(review ? "fraud.review.next" : "fraud.decide.secondPerson")}
      </p>
    </div>
  );
}

/** Hold a payee's payouts by hand (`manual`): their username and a note for the reviewers. */
export function RaiseFlagForm({
  onSubmit,
}: {
  onSubmit: (username: string, note: string) => Promise<void>;
}): React.JSX.Element {
  const [username, setUsername] = React.useState("");
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const name = username.trim().toLowerCase();
  const id = React.useId();

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name || pending) return;
    setPending(true);
    try {
      await onSubmit(name, note.trim());
      toast.success(t("fraud.raise.done"));
      setUsername("");
      setNote("");
    } catch (err) {
      toastActionError(err, t("fraud.raise.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormSection
      title={t("fraud.raise.title")}
      description={t("fraud.raise.hint")}
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="fraud-raise-form"
    >
      <Field>
        <FieldLabel htmlFor={`${id}-username`}>{t("fraud.raise.username")}</FieldLabel>
        <Input
          id={`${id}-username`}
          data-testid="fraud-raise-username"
          value={username}
          maxLength={25}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
      </Field>
      <NoteField value={note} onChange={setNote} />
      <div>
        <Button
          data-testid="fraud-flag-raise"
          type="submit"
          disabled={!name || pending}
          aria-busy={pending || undefined}
        >
          {t("fraud.raise.submit")}
        </Button>
      </div>
    </FormSection>
  );
}

export interface FraudReviewPanelProps {
  /** null while loading. */
  flags: PaymentFraudFlagDto[] | null;
  /** The signed-in treasurer (four eyes: they cannot decide what they reviewed or raised). */
  meId: string;
  /** The instance currency (evidence amounts are in it). */
  currency: string;
  status: FraudStatusFilter;
  onStatusChange: (status: FraudStatusFilter) => void;
  onRaise: (username: string, note: string) => Promise<void>;
  onReview: FraudFlagItemProps["onReview"];
  onDecide: FraudFlagItemProps["onDecide"];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

/** The treasury `fraud` tab. */
export function FraudReviewPanel({
  flags,
  meId,
  currency,
  status,
  onStatusChange,
  onRaise,
  onReview,
  onDecide,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: FraudReviewPanelProps): React.JSX.Element {
  const options: FraudStatusFilter[] = ["all", ...PAYMENT_FRAUD_STATUSES];
  return (
    <div className="flex flex-col gap-6">
      <Section
        heading={t("fraud.title")}
        description={t("fraud.intro")}
        data-testid="fraud-flags"
        action={
          <FilterBar
            filters={[
              {
                id: "fraud-status",
                label: t("fraud.filter"),
                value: status,
                options: options.map((s) => ({
                  value: s,
                  label: s === "all" ? t("fraud.filterAll") : t(STATUS_LABEL[s]),
                })),
                onValueChange: (v) => onStatusChange(isFilter(v) ? v : "all"),
              },
            ]}
          />
        }
      >
        {flags === null ? (
          <SkeletonGroup label={t("fraud.loading")}>
            <SkeletonText lines={4} />
          </SkeletonGroup>
        ) : flags.length === 0 ? (
          <EmptyState
            icon={CheckmarkCircle02Icon}
            headingLevel={3}
            title={t("fraud.empty")}
            description={t("fraud.emptyHint")}
          />
        ) : (
          <ItemGroup className="gap-3">
            {flags.map((flag) => (
              <FraudFlagItem
                key={flag.id}
                flag={flag}
                meId={meId}
                currency={currency}
                onReview={onReview}
                onDecide={onDecide}
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
              {t("fraud.loadMore")}
            </Button>
          </div>
        )}
      </Section>
      <RaiseFlagForm onSubmit={onRaise} />
    </div>
  );
}
