// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/dmca` (platform moderators): DMCA notices by status, a notice's items and the item
 * owners' strikes, the decision (actioned needs a confirmation: it disables access at once and
 * records a strike per owner), and counter-notices with "suit filed". Not reviewed by a lawyer.
 */
import { DMCA_RULES } from "@commonair/contracts/enums";
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { usePaged } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import {
  dmcaQueueClient,
  type DmcaCounterNoticeDto,
  type DmcaNoticeDto,
  type DmcaQueueClient,
  type DmcaStatus,
} from "./client.ts";
import { DMCA_STATUS_ORDER, dmcaStatusLabel, dmcaStatusTone, itemStateLabel, subjectLabel } from "./labels.ts";

export const NOTE_MAX = 2000;

/** `data-repeat-infringer` on `dmcaq-strikes`: at or over the policy threshold. */
export const isRepeatInfringer = (strikes: number, threshold: number = DMCA_RULES.repeatInfringerStrikes) =>
  threshold > 0 && strikes >= threshold;

const resolvedCount = (n: DmcaNoticeDto) => n.items.filter((i) => i.subjectType !== null).length;

export function DmcaQueue({ client: clientProp }: { client?: DmcaQueueClient }): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? dmcaQueueClient());
  const [status, setStatus] = React.useState<DmcaStatus>("received");
  const [selected, setSelected] = React.useState<DmcaNoticeDto | null>(null);
  const notices = usePaged(
    `dmcaq:${status}`,
    (cursor) => client.queue(status, cursor),
    (err) => toastActionError(err, t("dmcaq.loadMoreFailed")),
  );
  const options = DMCA_STATUS_ORDER.map((s) => ({
    value: s,
    label: dmcaStatusLabel(s),
    "data-testid": `dmcaq-status-${s}`,
  }));
  const update = (n: DmcaNoticeDto) => {
    setSelected(n);
    notices.reload();
  };
  return (
    <div data-testid="dmcaq" className="flex flex-col gap-4">
      <ChoiceToggle
        data-testid="dmcaq-status"
        label={t("dmcaq.statusFilter")}
        value={status}
        wrap
        onValueChange={(v) => {
          const next = DMCA_STATUS_ORDER.find((s) => s === v);
          if (next) {
            setStatus(next);
            setSelected(null);
          }
        }}
        options={options}
      />
      {notices.failed && notices.items === null ? (
        <div className="flex flex-col items-start gap-3">
          <FormError>{t("dmcaq.loadFailed")}</FormError>
          <Button variant="outline" size="sm" onClick={notices.reload}>
            {t("dmcaq.retry")}
          </Button>
        </div>
      ) : (
        <DmcaNoticeList
          notices={notices.items}
          selectedId={selected?.id ?? null}
          onSelect={(n) => setSelected((cur) => (cur?.id === n.id ? null : n))}
        />
      )}
      {notices.hasMore && (
        <div>
          <Button variant="ghost" size="sm" disabled={notices.loadingMore} onClick={notices.loadMore}>
            {t("dmcaq.loadMore")}
          </Button>
        </div>
      )}
      {selected && (
        <DmcaNoticeDetail
          notice={selected}
          onDecide={async (decision, note) => update(await client.action({ id: selected.id, decision, note }))}
          onSuitFiled={async (counterId, note) => update(await client.suitFiled({ id: counterId, note }))}
        />
      )}
    </div>
  );
}

export function DmcaNoticeList({
  notices,
  selectedId,
  onSelect,
}: {
  notices: DmcaNoticeDto[] | null;
  selectedId: string | null;
  onSelect: (n: DmcaNoticeDto) => void;
}): React.JSX.Element {
  if (notices === null)
    return (
      <SkeletonGroup label={t("dmcaq.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (notices.length === 0)
    return (
      <EmptyState data-testid="dmcaq-empty" icon={CheckmarkCircle02Icon} title={t("dmcaq.empty")} headingLevel={2} />
    );
  return (
    <ul className="flex flex-col gap-2">
      {notices.map((n) => (
        <li key={n.id}>
          <Button
            type="button"
            variant="outline"
            data-testid="dmcaq-item"
            data-notice-id={n.id}
            data-status={n.status}
            data-items={String(n.items.length)}
            data-resolved-items={String(resolvedCount(n))}
            aria-expanded={selectedId === n.id}
            onClick={() => onSelect(n)}
            className="h-auto w-full flex-col items-start gap-1 p-3 text-start whitespace-normal sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="min-w-0 break-words font-medium">{n.claimantName}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {t("dmcaq.itemCount", { items: n.items.length, resolved: resolvedCount(n) })}
              <RelativeTime date={n.createdAt} />
              <StatusBadge tone={dmcaStatusTone(n.status)}>{dmcaStatusLabel(n.status)}</StatusBadge>
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

export function DmcaNoticeDetail({
  notice,
  onDecide,
  onSuitFiled,
}: {
  notice: DmcaNoticeDto;
  onDecide: (decision: "actioned" | "rejected", note: string) => Promise<void>;
  onSuitFiled: (counterId: string, note: string) => Promise<void>;
}): React.JSX.Element {
  return (
    <Card data-testid="dmcaq-detail" data-notice-id={notice.id} data-status={notice.status} size="sm">
      <CardHeader>
        <CardTitle className="break-words">{t("dmcaq.detail.title", { name: notice.claimantName })}</CardTitle>
        <CardAction>
          <StatusBadge tone={dmcaStatusTone(notice.status)}>{dmcaStatusLabel(notice.status)}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact label={t("dmcaq.detail.email")}>{notice.claimantEmail}</Fact>
          <Fact label={t("dmcaq.detail.phone")}>{notice.claimantPhone ?? t("dmcaq.detail.none")}</Fact>
          <Fact label={t("dmcaq.detail.address")}>{notice.claimantAddress}</Fact>
          <Fact label={t("dmcaq.detail.signature")}>{notice.signature}</Fact>
          <Fact label={t("dmcaq.detail.work")}>{notice.copyrightedWork}</Fact>
          <Fact label={t("dmcaq.detail.received")}>
            <RelativeTime date={notice.createdAt} />
          </Fact>
          {notice.handledBy ? <Fact label={t("dmcaq.detail.handledBy")}>{notice.handledBy.username}</Fact> : null}
          {notice.decisionNote ? <Fact label={t("dmcaq.detail.note")}>{notice.decisionNote}</Fact> : null}
        </dl>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("dmcaq.detail.items")}</h3>
          <ul className="flex flex-col gap-2">
            {notice.items.map((i) => (
              <li
                key={i.id}
                data-testid="dmcaq-item-row"
                data-item-id={i.id}
                data-subject-type={i.subjectType ?? ""}
                data-subject-id={i.subjectId ?? ""}
                data-owner-id={i.ownerId ?? ""}
                data-removed-at={i.removedAt ?? ""}
                data-restored-at={i.restoredAt ?? ""}
                className="flex flex-col gap-0.5 rounded-md border p-2 text-sm"
              >
                <span className="font-medium">
                  {subjectLabel(i.subjectType)} · {itemStateLabel(i)}
                </span>
                <span className="break-all text-xs text-muted-foreground">{i.url}</span>
              </li>
            ))}
          </ul>
        </section>
        {Object.keys(notice.ownerStrikes).length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("dmcaq.strikes.title")}</h3>
            <ul className="flex flex-col gap-1">
              {Object.entries(notice.ownerStrikes).map(([userId, strikes]) => (
                <li
                  key={userId}
                  data-testid="dmcaq-strikes"
                  data-user-id={userId}
                  data-strikes={String(strikes)}
                  data-repeat-infringer={String(isRepeatInfringer(strikes))}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span className="break-all font-mono text-xs">{userId}</span>
                  <span>{t("dmcaq.strikes.count", { strikes, threshold: DMCA_RULES.repeatInfringerStrikes })}</span>
                  {isRepeatInfringer(strikes) ? (
                    <StatusBadge tone="danger">{t("dmcaq.strikes.repeat")}</StatusBadge>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}
        {notice.status === "received" && <DecisionForm onDecide={onDecide} />}
        {notice.counters.length > 0 && (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">{t("dmcaq.counter.title")}</h3>
            {notice.counters.map((c) => (
              <CounterCard key={c.id} counter={c} onSuitFiled={(note) => onSuitFiled(c.id, note)} />
            ))}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

export function DecisionForm({
  onDecide,
}: {
  onDecide: (decision: "actioned" | "rejected", note: string) => Promise<void>;
}): React.JSX.Element {
  const [decision, setDecision] = React.useState<"actioned" | "rejected" | "">("");
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const id = React.useId();
  const fail = (err: unknown) =>
    errorCode(err) === "CONFLICT"
      ? toast.error(t("dmcaq.decided"))
      : errorCode(err) === "FORBIDDEN"
        ? toast.error(t("dmcaq.ownContent"))
        : toastActionError(err, t("dmcaq.failed"));
  const run = async (d: "actioned" | "rejected") => {
    await onDecide(d, note.trim());
    toast.success(d === "actioned" ? t("dmcaq.actionedDone") : t("dmcaq.rejectedDone"));
  };
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (decision === "" || pending) return;
    if (decision === "actioned") {
      setConfirming(true);
      return;
    }
    setPending(true);
    try {
      await run("rejected");
    } catch (err) {
      fail(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <ChoiceToggle
        data-testid="dmcaq-decision"
        label={t("dmcaq.decision")}
        value={decision}
        onValueChange={(v) => {
          if (v === "actioned" || v === "rejected") setDecision(v);
        }}
        options={[
          { value: "actioned", label: t("dmcaq.decision.actioned"), "data-testid": "dmcaq-decision-actioned" },
          { value: "rejected", label: t("dmcaq.decision.rejected"), "data-testid": "dmcaq-decision-rejected" },
        ]}
      />
      <Field>
        <FieldLabel htmlFor={id}>{t("dmcaq.note")}</FieldLabel>
        <Textarea
          id={id}
          data-testid="dmcaq-note"
          rows={3}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <FieldDescription>
          {decision === "rejected" ? t("dmcaq.noteHintRejected") : t("dmcaq.noteHint")}
        </FieldDescription>
      </Field>
      <div>
        <Button
          data-testid="dmcaq-submit"
          type="submit"
          disabled={decision === "" || pending}
          aria-busy={pending || undefined}
        >
          {t("dmcaq.submit")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="destructive"
        title={t("dmcaq.confirmTitle")}
        description={t("dmcaq.confirmBody")}
        confirmLabel={t("dmcaq.confirm")}
        onConfirm={() => run("actioned")}
        onError={fail}
      />
    </form>
  );
}

export function CounterCard({
  counter,
  onSuitFiled,
}: {
  counter: DmcaCounterNoticeDto;
  onSuitFiled: (note: string) => Promise<void>;
}): React.JSX.Element {
  const [note, setNote] = React.useState("");
  const id = React.useId();
  const open = counter.restoredAt === null && counter.suitFiledAt === null;
  return (
    <div
      data-testid="dmcaq-counter"
      data-counter-id={counter.id}
      data-restore-after={counter.restoreAfter}
      data-restored-at={counter.restoredAt ?? ""}
      data-suit-filed-at={counter.suitFiledAt ?? ""}
      className="flex flex-col gap-3 rounded-md border p-3"
    >
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label={t("dmcaq.counter.user")}>{counter.user.username}</Fact>
        <Fact label={t("dmcaq.counter.name")}>{counter.fullName}</Fact>
        <Fact label={t("dmcaq.counter.address")}>{counter.address}</Fact>
        <Fact label={t("dmcaq.counter.phone")}>{counter.phone}</Fact>
        <Fact label={t("dmcaq.counter.statement")}>{counter.statement}</Fact>
        <Fact label={t("dmcaq.counter.items")}>{String(counter.itemIds.length)}</Fact>
        <Fact label={t("dmcaq.counter.restoreAfter")}>
          <RelativeTime date={counter.restoreAfter} />
        </Fact>
        {counter.restoredAt ? (
          <Fact label={t("dmcaq.counter.restoredAt")}>
            <RelativeTime date={counter.restoredAt} />
          </Fact>
        ) : null}
        {counter.suitFiledAt ? (
          <Fact label={t("dmcaq.counter.suitFiledAt")}>
            <RelativeTime date={counter.suitFiledAt} />
          </Fact>
        ) : null}
        {counter.suitNote ? <Fact label={t("dmcaq.counter.suitNoteLabel")}>{counter.suitNote}</Fact> : null}
      </dl>
      {open && (
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={id}>{t("dmcaq.counter.suitNote")}</FieldLabel>
            <Textarea
              id={id}
              data-testid="dmcaq-suit-note"
              rows={2}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
            />
            <FieldDescription>{t("dmcaq.counter.suitHint")}</FieldDescription>
          </Field>
          <div>
            <ConfirmDialog
              trigger={
                <Button data-testid="dmcaq-suit-filed" variant="outline">
                  {t("dmcaq.counter.suitFiled")}
                </Button>
              }
              title={t("dmcaq.counter.suitConfirmTitle")}
              description={t("dmcaq.counter.suitConfirmBody")}
              confirmLabel={t("dmcaq.counter.suitConfirm")}
              onConfirm={async () => {
                await onSuitFiled(note.trim());
                toast.success(t("dmcaq.counter.suitDone"));
              }}
              onError={(err) =>
                errorCode(err) === "CONFLICT"
                  ? toast.error(t("dmcaq.counter.suitConflict"))
                  : toastActionError(err, t("dmcaq.counter.suitFailed"))
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
