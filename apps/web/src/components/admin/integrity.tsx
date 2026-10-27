// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { INTEGRITY_DECISIONS, INTEGRITY_SUBJECTS } from "@commonair/contracts/enums";
import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { ShieldUserIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { usePaged } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import {
  integrityClient,
  type FlagFilters,
  type IntegrityClient,
  type IntegrityDecision,
  type IntegrityFlagDto,
  type IntegritySubject,
} from "./client.ts";
import { DECIDE_REASON_MAX, channelFilter, detailText } from "./forms.ts";
import { decisionLabel, decisionTone, subjectLabel } from "./labels.ts";

const ALL = "all";
const CHANNEL_DEBOUNCE_MS = 400;

/** The API filters for the toggles and the (already checked) channel. */
export function flagFilters(subject: string, decision: string, channel: string | undefined): FlagFilters {
  const s = INTEGRITY_SUBJECTS.find((x) => x === subject);
  const d = INTEGRITY_DECISIONS.find((x) => x === decision);
  return { ...(s ? { subjectType: s } : {}), ...(d ? { decision: d } : {}), ...(channel ? { channel } : {}) };
}

/** `/admin/integrity`: flags newest first with filters (pending review by default), each decidable in place. */
export function IntegrityPage({ client: clientProp }: { client?: IntegrityClient }): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? integrityClient());
  const [subject, setSubject] = React.useState<string>(ALL);
  const [decision, setDecision] = React.useState<string>("pending_review");
  const [channelInput, setChannelInput] = React.useState("");
  const [channel, setChannel] = React.useState<string | undefined>(undefined);
  const channelCheck = channelFilter(channelInput);
  const channelId = React.useId();

  React.useEffect(() => {
    const check = channelFilter(channelInput);
    if (!check.ok) return;
    const timer = setTimeout(() => setChannel(check.channel), CHANNEL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [channelInput]);

  const filters = flagFilters(subject, decision, channel);
  const flags = usePaged(
    JSON.stringify(filters),
    (cursor) => client.flags(filters, cursor),
    (err) => toastActionError(err, t("admin.integrity.loadMoreFailed")),
  );
  // Decided here: shown with their new decision until the list loads again.
  const [decided, setDecided] = React.useState<Map<string, IntegrityFlagDto>>(() => new Map());
  const items = flags.items?.map((f) => decided.get(f.id) ?? f) ?? null;

  return (
    <div data-testid="integrityq" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <ChoiceToggle
          data-testid="integrityq-subject"
          label={t("admin.integrity.filterSubject")}
          value={subject}
          wrap
          onValueChange={setSubject}
          options={[
            { value: ALL, label: t("admin.integrity.all"), "data-testid": "integrityq-subject-all" },
            ...INTEGRITY_SUBJECTS.map((s: IntegritySubject) => ({
              value: s,
              label: subjectLabel(s),
              "data-testid": `integrityq-subject-${s}`,
            })),
          ]}
        />
        <ChoiceToggle
          data-testid="integrityq-decision"
          label={t("admin.integrity.filterDecision")}
          value={decision}
          wrap
          onValueChange={setDecision}
          options={[
            { value: ALL, label: t("admin.integrity.all"), "data-testid": "integrityq-decision-all" },
            ...INTEGRITY_DECISIONS.map((d: IntegrityDecision) => ({
              value: d,
              label: decisionLabel(d),
              "data-testid": `integrityq-decision-${d}`,
            })),
          ]}
        />
        <Field className="max-w-xs">
          <FieldLabel htmlFor={channelId}>{t("admin.integrity.filterChannel")}</FieldLabel>
          <Input
            id={channelId}
            data-testid="integrityq-channel"
            value={channelInput}
            maxLength={25}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!channelCheck.ok || undefined}
            onChange={(e) => setChannelInput(e.currentTarget.value)}
          />
          {channelCheck.ok ? (
            <FieldDescription>{t("admin.integrity.filterChannelHint")}</FieldDescription>
          ) : (
            <FieldError>{t("admin.integrity.filterChannelInvalid")}</FieldError>
          )}
        </Field>
      </div>
      {/* An invalid channel would otherwise leave the previous channel's flags on screen. */}
      {channelCheck.ok && (
        <>
          <FlagList
            flags={items}
            failed={flags.failed}
            onRetry={flags.reload}
            onDecide={async (flag, to, reason) => {
              const updated = await client.decide({ id: flag.id, decision: to, reason });
              setDecided((prev) => new Map(prev).set(updated.id, updated));
            }}
          />
          {flags.hasMore && (
            <div>
              <Button variant="ghost" size="sm" disabled={flags.loadingMore} onClick={flags.loadMore}>
                {t("admin.integrity.loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function FlagList({
  flags,
  failed,
  onRetry,
  onDecide,
}: {
  flags: IntegrityFlagDto[] | null;
  failed: boolean;
  onRetry: () => void;
  onDecide: (flag: IntegrityFlagDto, decision: "excluded" | "allowed", reason: string) => Promise<void>;
}): React.JSX.Element {
  if (failed && flags === null)
    return (
      <div className="flex flex-col items-start gap-3">
        <FormError>{t("admin.integrity.loadFailed")}</FormError>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("admin.integrity.retry")}
        </Button>
      </div>
    );
  if (flags === null)
    return (
      <SkeletonGroup label={t("admin.integrity.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (flags.length === 0)
    return (
      <EmptyState
        data-testid="integrityq-empty"
        icon={ShieldUserIcon}
        title={t("admin.integrity.empty")}
        headingLevel={2}
      />
    );
  return (
    <ul className="flex flex-col gap-3">
      {flags.map((f) => (
        <li key={f.id}>
          <FlagCard flag={f} onDecide={(d, r) => onDecide(f, d, r)} />
        </li>
      ))}
    </ul>
  );
}

function FlagCard({
  flag,
  onDecide,
}: {
  flag: IntegrityFlagDto;
  onDecide: (decision: "excluded" | "allowed", reason: string) => Promise<void>;
}): React.JSX.Element {
  const [to, setTo] = React.useState<"excluded" | "allowed" | "">("");
  const [reason, setReason] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const reasonId = React.useId();
  const ready = to !== "" && to !== flag.decision && reason.trim() !== "";
  const details = Object.entries(flag.details);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (to === "" || !ready || pending) return;
    setPending(true);
    try {
      await onDecide(to, reason.trim());
      toast.success(t("admin.integrity.decided"));
      setTo("");
      setReason("");
    } catch (err) {
      if (errorCode(err) === "CONFLICT") toast.error(t("admin.integrity.conflict"));
      else toastActionError(err, t("admin.integrity.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card
      size="sm"
      data-testid="integrityq-item"
      data-flag-id={flag.id}
      data-subject-type={flag.subjectType}
      data-subject-id={flag.subjectId}
      data-signal={flag.signal}
      data-score={flag.score}
      data-decision={flag.decision}
    >
      <CardHeader>
        <CardTitle>
          <h2 className="flex flex-wrap items-center gap-2">
            <span className="font-mono break-all">{flag.signal}</span>
            <StatusBadge tone={decisionTone(flag.decision)}>{decisionLabel(flag.decision)}</StatusBadge>
          </h2>
        </CardTitle>
        <CardAction>
          <RelativeTime date={flag.createdAt} className="text-xs text-muted-foreground" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <KeyValueList
          dense
          rows={[
            {
              term: subjectLabel(flag.subjectType),
              value: <span className="font-mono break-all">{flag.subjectId}</span>,
            },
            { term: t("admin.integrity.score"), value: detailText(flag.score) },
            ...details.map(([k, v]) => ({
              term: <span className="font-mono">{k}</span>,
              value: <span className="break-all whitespace-normal">{detailText(v)}</span>,
            })),
          ]}
        />
        {details.length === 0 && <p className="text-xs text-muted-foreground">{t("admin.integrity.noDetails")}</p>}
        <form
          data-testid="integrityq-decide"
          className="flex flex-col gap-3"
          onSubmit={(e) => void submit(e)}
          noValidate
        >
          <ChoiceToggle
            label={t("admin.integrity.decide")}
            value={to}
            onValueChange={(v) => {
              if (v === "excluded" || v === "allowed") setTo(v);
            }}
            options={[
              {
                value: "excluded",
                label: decisionLabel("excluded"),
                disabled: flag.decision === "excluded",
                "data-testid": "integrityq-decide-excluded",
              },
              {
                value: "allowed",
                label: decisionLabel("allowed"),
                disabled: flag.decision === "allowed",
                "data-testid": "integrityq-decide-allowed",
              },
            ]}
          />
          <Field>
            <FieldLabel htmlFor={reasonId}>{t("admin.integrity.reason")}</FieldLabel>
            <Textarea
              id={reasonId}
              data-testid="integrityq-reason"
              rows={2}
              required
              maxLength={DECIDE_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
            <FieldDescription>{t("admin.integrity.reasonHint")}</FieldDescription>
          </Field>
          <div>
            <Button
              data-testid="integrityq-submit"
              type="submit"
              disabled={!ready || pending}
              aria-busy={pending || undefined}
            >
              {t("admin.integrity.submit")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
