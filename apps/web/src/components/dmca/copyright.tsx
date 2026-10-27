// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/settings/copyright`: copyright notices about your content and the counter-notice
 * (17 U.S.C. § 512(g)(3)). Every statutory statement is spelled out next to its checkbox, and a
 * confirmation says the claimant will receive your name, address and phone, as the law requires.
 * Not reviewed by a lawyer (docs/operators/dmca.md).
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Checkbox } from "@commonair/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { CopyrightIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { useLoad } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import {
  copyrightClient,
  type CopyrightClient,
  type CounterInput,
  type DmcaNoticeForOwnerDto,
  type DmcaNoticeItemDto,
} from "./client.ts";
import { dmcaStatusLabel, dmcaStatusTone, itemStateLabel, subjectLabel } from "./labels.ts";

/** Contract limits (`safety.dmca.counter`). */
export const COUNTER_NAME_MAX = 200;
export const COUNTER_ADDRESS_MAX = 500;
export const COUNTER_PHONE_MIN = 5;
export const COUNTER_PHONE_MAX = 40;
export const COUNTER_STATEMENT_MAX = 5000;
export const COUNTER_SIGNATURE_MAX = 200;

/** Your items of a notice that are down and can be countered. */
export const counterableItems = (n: DmcaNoticeForOwnerDto): DmcaNoticeItemDto[] =>
  n.items.filter((i) => i.removedAt !== null && i.restoredAt === null);

/** `counter-open` shows while the notice has removed, unrestored items of yours and no counter-notice. */
export const canCounter = (n: DmcaNoticeForOwnerDto) =>
  n.counter === null && (n.status === "actioned" || n.status === "countered") && counterableItems(n).length > 0;

export interface CounterDraft {
  name: string;
  address: string;
  phone: string;
  itemIds: string[];
  statement: string;
  goodFaith: boolean;
  jurisdiction: boolean;
  signature: string;
}

export type CounterField = keyof CounterDraft;

export function counterDraftFor(n: DmcaNoticeForOwnerDto): CounterDraft {
  return {
    name: "",
    address: "",
    phone: "",
    // Every removed item is checked by default.
    itemIds: counterableItems(n).map((i) => i.id),
    statement: "",
    goodFaith: false,
    jurisdiction: false,
    signature: "",
  };
}

export function counterErrors(d: CounterDraft): Partial<Record<CounterField, string>> {
  const e: Partial<Record<CounterField, string>> = {};
  if (d.name.trim() === "") e.name = t("copyright.counter.error.name");
  if (d.address.trim() === "") e.address = t("copyright.counter.error.address");
  const phone = d.phone.trim();
  if (phone.length < COUNTER_PHONE_MIN || phone.length > COUNTER_PHONE_MAX)
    e.phone = t("copyright.counter.error.phone", { min: COUNTER_PHONE_MIN, max: COUNTER_PHONE_MAX });
  if (d.itemIds.length === 0) e.itemIds = t("copyright.counter.error.items");
  if (d.statement.trim() === "") e.statement = t("copyright.counter.error.statement");
  if (!d.goodFaith) e.goodFaith = t("copyright.counter.error.goodFaith");
  if (!d.jurisdiction) e.jurisdiction = t("copyright.counter.error.jurisdiction");
  if (d.signature.trim() === "") e.signature = t("copyright.counter.error.signature");
  return e;
}

export function counterInput(noticeId: string, d: CounterDraft): CounterInput {
  return {
    id: noticeId,
    fullName: d.name.trim(),
    address: d.address.trim(),
    phone: d.phone.trim(),
    itemIds: d.itemIds,
    statement: d.statement.trim(),
    goodFaithStatement: true,
    consentToJurisdiction: true,
    signature: d.signature.trim(),
  };
}

/** The page body: load, empty, error with retry, or the notices. */
export function MyCopyright({
  client: clientProp,
  focusNoticeId,
}: {
  client?: CopyrightClient;
  focusNoticeId?: string | undefined;
}): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? copyrightClient());
  const mine = useLoad("dmca-mine", () => client.mine());
  return (
    <div data-testid="copyright" className="flex flex-col gap-4">
      <CopyrightNotices
        notices={mine.data}
        failed={mine.failed}
        onRetry={mine.reload}
        focusNoticeId={focusNoticeId}
        onCounter={async (input) => {
          const r = await client.counter(input);
          mine.reload();
          return r;
        }}
      />
    </div>
  );
}

export function CopyrightNotices({
  notices,
  failed,
  onRetry,
  onCounter,
  focusNoticeId,
}: {
  notices: DmcaNoticeForOwnerDto[] | null;
  failed: boolean;
  onRetry: () => void;
  onCounter: (input: CounterInput) => Promise<{ restoreAfter: string }>;
  focusNoticeId?: string | undefined;
}): React.JSX.Element {
  if (notices === null && failed)
    return (
      <div className="flex flex-col items-start gap-3">
        <FormError>{t("copyright.loadFailed")}</FormError>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("copyright.retry")}
        </Button>
      </div>
    );
  if (notices === null)
    return (
      <SkeletonGroup label={t("copyright.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (notices.length === 0)
    return (
      <EmptyState
        data-testid="copyright-empty"
        icon={CopyrightIcon}
        title={t("copyright.empty")}
        description={t("copyright.emptyBody")}
        headingLevel={2}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      {notices.map((n) => (
        <NoticeCard key={n.id} notice={n} focused={n.id === focusNoticeId} onCounter={onCounter} />
      ))}
    </div>
  );
}

function NoticeCard({
  notice,
  focused,
  onCounter,
}: {
  notice: DmcaNoticeForOwnerDto;
  focused: boolean;
  onCounter: (input: CounterInput) => Promise<{ restoreAfter: string }>;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "start" });
  }, [focused]);
  return (
    <Card
      ref={ref}
      size="sm"
      data-testid="copyright-notice"
      data-notice-id={notice.id}
      data-status={notice.status}
      className={focused ? "ring-2 ring-ring" : undefined}
    >
      <CardHeader>
        <CardTitle className="break-words">{t("copyright.notice.from", { name: notice.claimantName })}</CardTitle>
        <CardAction className="flex items-center gap-2">
          <StatusBadge tone={dmcaStatusTone(notice.status)}>{dmcaStatusLabel(notice.status)}</StatusBadge>
          <RelativeTime date={notice.actionedAt ?? notice.createdAt} className="text-xs text-muted-foreground" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{t("copyright.notice.work")}</p>
          <p className="text-sm break-words whitespace-pre-wrap">{notice.copyrightedWork}</p>
        </div>
        <ul className="flex flex-col gap-2">
          {notice.items.map((i) => (
            <li
              key={i.id}
              data-testid="copyright-item"
              data-item-id={i.id}
              data-subject-type={i.subjectType ?? ""}
              data-subject-id={i.subjectId ?? ""}
              data-removed={String(i.removedAt !== null)}
              data-restored={String(i.restoredAt !== null)}
              className="flex flex-col gap-0.5 rounded-md border p-2 text-sm"
            >
              <span className="font-medium">
                {subjectLabel(i.subjectType)} · {itemStateLabel(i)}
              </span>
              <span className="break-all text-xs text-muted-foreground">{i.url}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{t("copyright.notice.repeat")}</p>
        {notice.counter ? (
          <CounterReceipt counter={notice.counter} />
        ) : canCounter(notice) ? (
          <div>
            <Button data-testid="counter-open" variant="outline" onClick={() => setOpen(true)}>
              {t("copyright.counter.open")}
            </Button>
          </div>
        ) : null}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-xl">
            <CounterForm
              notice={notice}
              onSubmit={async (input) => {
                const r = await onCounter(input);
                setOpen(false);
                return r;
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}

export function CounterReceipt({
  counter,
}: {
  counter: NonNullable<DmcaNoticeForOwnerDto["counter"]>;
}): React.JSX.Element {
  return (
    <output
      data-testid="counter-receipt"
      data-counter-id={counter.id}
      data-restore-after={counter.restoreAfter}
      data-restored={String(counter.restoredAt !== null)}
      data-suit-filed={String(counter.suitFiledAt !== null)}
      className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3 text-sm"
    >
      <p className="font-medium">{t("copyright.receipt.title")}</p>
      {counter.restoredAt ? (
        <p>
          {t("copyright.receipt.restored")} <RelativeTime date={counter.restoredAt} />
        </p>
      ) : counter.suitFiledAt ? (
        <p>{t("copyright.receipt.suit")}</p>
      ) : (
        <p>
          {t("copyright.receipt.restoreAfter")} <RelativeTime date={counter.restoreAfter} />
        </p>
      )}
    </output>
  );
}

/** `counter-form`: every element of § 512(g)(3), then a confirmation of what the claimant receives. */
export function CounterForm({
  notice,
  onSubmit,
}: {
  notice: DmcaNoticeForOwnerDto;
  onSubmit: (input: CounterInput) => Promise<{ restoreAfter: string }>;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<CounterDraft>(() => counterDraftFor(notice));
  const [touched, setTouched] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const ids = {
    name: React.useId(),
    address: React.useId(),
    phone: React.useId(),
    statement: React.useId(),
    goodFaith: React.useId(),
    jurisdiction: React.useId(),
    signature: React.useId(),
  };
  const itemIdBase = React.useId();
  const errors = counterErrors(draft);
  const shown = touched ? errors : {};
  const set = <K extends keyof CounterDraft>(key: K, value: CounterDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const items = counterableItems(notice);

  const text = (
    key: "name" | "address" | "phone" | "signature",
    testId: string,
    label: string,
    opts: { hint?: string; type?: string; autoComplete?: string; maxLength?: number } = {},
  ) => (
    <Field data-invalid={shown[key] ? true : undefined}>
      <FieldLabel htmlFor={ids[key]}>{label}</FieldLabel>
      <Input
        id={ids[key]}
        data-testid={testId}
        type={opts.type ?? "text"}
        autoComplete={opts.autoComplete}
        maxLength={opts.maxLength}
        value={draft[key]}
        aria-invalid={shown[key] ? true : undefined}
        onChange={(e) => set(key, e.currentTarget.value)}
      />
      {opts.hint ? <FieldDescription>{opts.hint}</FieldDescription> : null}
      {shown[key] ? <FieldError>{shown[key]}</FieldError> : null}
    </Field>
  );

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setConfirming(true);
  };

  return (
    <form data-testid="counter-form" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{t("copyright.counter.title")}</DialogTitle>
        <DialogDescription>{t("copyright.counter.description")}</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {text("name", "counter-name", t("copyright.counter.name"), {
          autoComplete: "name",
          maxLength: COUNTER_NAME_MAX,
        })}
        {text("address", "counter-address", t("copyright.counter.address"), {
          autoComplete: "street-address",
          maxLength: COUNTER_ADDRESS_MAX,
        })}
        {text("phone", "counter-phone", t("copyright.counter.phone"), {
          type: "tel",
          autoComplete: "tel",
          maxLength: COUNTER_PHONE_MAX,
        })}
        <FieldSet data-invalid={shown.itemIds ? true : undefined}>
          <FieldLegend variant="label">{t("copyright.counter.items")}</FieldLegend>
          {items.map((i) => (
            <Field key={i.id} orientation="horizontal">
              <Checkbox
                id={`${itemIdBase}-${i.id}`}
                data-testid={`counter-item-${i.id}`}
                checked={draft.itemIds.includes(i.id)}
                onCheckedChange={(checked) =>
                  set(
                    "itemIds",
                    checked === true ? [...new Set([...draft.itemIds, i.id])] : draft.itemIds.filter((x) => x !== i.id),
                  )
                }
              />
              <FieldLabel htmlFor={`${itemIdBase}-${i.id}`} className="font-normal break-all">
                {subjectLabel(i.subjectType)}: {i.url}
              </FieldLabel>
            </Field>
          ))}
          {shown.itemIds ? <FieldError>{shown.itemIds}</FieldError> : null}
        </FieldSet>
        <Field data-invalid={shown.statement ? true : undefined}>
          <FieldLabel htmlFor={ids.statement}>{t("copyright.counter.statement")}</FieldLabel>
          <Textarea
            id={ids.statement}
            data-testid="counter-statement"
            rows={4}
            maxLength={COUNTER_STATEMENT_MAX}
            value={draft.statement}
            aria-invalid={shown.statement ? true : undefined}
            onChange={(e) => set("statement", e.currentTarget.value)}
          />
          <FieldDescription>{t("copyright.counter.statementHint")}</FieldDescription>
          {shown.statement ? <FieldError>{shown.statement}</FieldError> : null}
        </Field>
        <Field orientation="horizontal" data-invalid={shown.goodFaith ? true : undefined}>
          <Checkbox
            id={ids.goodFaith}
            data-testid="counter-good-faith"
            checked={draft.goodFaith}
            onCheckedChange={(checked) => set("goodFaith", checked === true)}
          />
          <FieldLabel htmlFor={ids.goodFaith} className="font-normal">
            {t("copyright.counter.goodFaith")}
          </FieldLabel>
        </Field>
        {shown.goodFaith ? <FieldError>{shown.goodFaith}</FieldError> : null}
        <Field orientation="horizontal" data-invalid={shown.jurisdiction ? true : undefined}>
          <Checkbox
            id={ids.jurisdiction}
            data-testid="counter-jurisdiction"
            checked={draft.jurisdiction}
            onCheckedChange={(checked) => set("jurisdiction", checked === true)}
          />
          <FieldLabel htmlFor={ids.jurisdiction} className="font-normal">
            {t("copyright.counter.jurisdiction")}
          </FieldLabel>
        </Field>
        {shown.jurisdiction ? <FieldError>{shown.jurisdiction}</FieldError> : null}
        {text("signature", "counter-signature", t("copyright.counter.signature"), {
          maxLength: COUNTER_SIGNATURE_MAX,
          hint: t("copyright.counter.signatureHint"),
        })}
      </FieldGroup>
      <DialogFooter>
        <Button data-testid="counter-submit" type="submit">
          {t("copyright.counter.submit")}
        </Button>
      </DialogFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("copyright.counter.confirmTitle")}
        description={t("copyright.counter.confirmBody")}
        confirmLabel={t("copyright.counter.confirm")}
        onConfirm={async () => {
          await onSubmit(counterInput(notice.id, draft));
          toast.success(t("copyright.counter.done"));
        }}
        onError={(err) =>
          errorCode(err) === "CONFLICT"
            ? toast.error(t("copyright.counter.conflict"))
            : toastActionError(err, t("copyright.counter.failed"))
        }
      />
    </form>
  );
}
