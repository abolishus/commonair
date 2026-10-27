// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/dmca`: the copyright takedown notice (17 U.S.C. § 512(c)(3)(A)), every statutory element its
 * own field or its own labelled checkbox. Not reviewed by a lawyer (docs/operators/dmca.md).
 */
import { RelativeTime } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { AltchaField, type AltchaFieldHandle } from "../altcha-field.tsx";
import { parseContentUrls } from "../safety/takedown-form.tsx";
import { t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { dmcaNoticeClient, type DmcaNoticeClient, type DmcaSubmitInput } from "./client.ts";

/** Contract limits (`safety.dmca.submit`). */
export const DMCA_URLS_MAX = 50;
export const DMCA_NAME_MAX = 200;
export const DMCA_ADDRESS_MAX = 500;
export const DMCA_PHONE_MIN = 5;
export const DMCA_PHONE_MAX = 40;
export const DMCA_WORK_MAX = 5000;
export const DMCA_SIGNATURE_MAX = 200;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DmcaDraft {
  name: string;
  email: string;
  address: string;
  phone: string;
  work: string;
  urls: string;
  goodFaith: boolean;
  accuracy: boolean;
  signature: string;
}

export type DmcaField = keyof DmcaDraft;

export const EMPTY_DMCA_DRAFT: DmcaDraft = {
  name: "",
  email: "",
  address: "",
  phone: "",
  work: "",
  urls: "",
  goodFaith: false,
  accuracy: false,
  signature: "",
};

/** Field errors for a draft (empty when it can be submitted, ALTCHA aside). */
export function dmcaErrors(d: DmcaDraft): Partial<Record<DmcaField, string>> {
  const e: Partial<Record<DmcaField, string>> = {};
  if (d.name.trim() === "") e.name = t("dmca.error.name");
  if (!EMAIL.test(d.email.trim())) e.email = t("dmca.error.email");
  if (d.address.trim() === "") e.address = t("dmca.error.address");
  const phone = d.phone.trim();
  if (phone !== "" && (phone.length < DMCA_PHONE_MIN || phone.length > DMCA_PHONE_MAX))
    e.phone = t("dmca.error.phone", { min: DMCA_PHONE_MIN, max: DMCA_PHONE_MAX });
  if (d.work.trim() === "") e.work = t("dmca.error.work");
  const { urls, invalid } = parseContentUrls(d.urls);
  if (invalid.length > 0) e.urls = t("dmca.error.urlInvalid");
  else if (urls.length === 0) e.urls = t("dmca.error.urlMissing");
  else if (urls.length > DMCA_URLS_MAX) e.urls = t("dmca.error.urlTooMany", { max: DMCA_URLS_MAX });
  if (!d.goodFaith) e.goodFaith = t("dmca.error.goodFaith");
  if (!d.accuracy) e.accuracy = t("dmca.error.accuracy");
  if (d.signature.trim() === "") e.signature = t("dmca.error.signature");
  return e;
}

/** The submit input for a valid draft. */
export function dmcaInput(d: DmcaDraft, altcha: string): DmcaSubmitInput {
  const phone = d.phone.trim();
  return {
    claimantName: d.name.trim(),
    claimantEmail: d.email.trim(),
    claimantAddress: d.address.trim(),
    ...(phone !== "" ? { claimantPhone: phone } : {}),
    copyrightedWork: d.work.trim(),
    infringingUrls: parseContentUrls(d.urls).urls,
    goodFaithStatement: true,
    accuracyStatement: true,
    signature: d.signature.trim(),
    altcha,
  };
}

export interface DmcaReceipt {
  id: string;
  receivedAt: string;
}

export function DmcaReceiptCard({ receipt }: { receipt: DmcaReceipt }): React.JSX.Element {
  return (
    <AlertCallout
      data-testid="dmca-receipt"
      data-notice-id={receipt.id}
      tone="info"
      live
      title={t("dmca.receipt.title")}
      description={
        <div className="flex flex-col gap-2">
          <p>{t("dmca.receipt.body")}</p>
          <p>
            {t("dmca.receipt.received")} <RelativeTime date={receipt.receivedAt} />
          </p>
          <p className="break-all">{t("dmca.receipt.reference", { id: receipt.id })}</p>
        </div>
      }
    />
  );
}

/** The form (`dmca-form`), replaced by `dmca-receipt` once the notice is in. */
export function DmcaNoticeForm({ client: clientProp }: { client?: DmcaNoticeClient }): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? dmcaNoticeClient());
  const [receipt, setReceipt] = React.useState<DmcaReceipt | null>(null);
  if (receipt) return <DmcaReceiptCard receipt={receipt} />;
  return <DmcaFields client={client} onReceipt={setReceipt} />;
}

function DmcaFields({
  client,
  onReceipt,
}: {
  client: DmcaNoticeClient;
  onReceipt: (r: DmcaReceipt) => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<DmcaDraft>(EMPTY_DMCA_DRAFT);
  const [altcha, setAltcha] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const altchaRef = React.useRef<AltchaFieldHandle>(null);
  const ids = {
    name: React.useId(),
    email: React.useId(),
    address: React.useId(),
    phone: React.useId(),
    work: React.useId(),
    urls: React.useId(),
    goodFaith: React.useId(),
    accuracy: React.useId(),
    signature: React.useId(),
  };
  const errors = dmcaErrors(draft);
  const shown = touched ? errors : {};
  const set = <K extends keyof DmcaDraft>(key: K, value: DmcaDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || altcha === null || pending) return;
    setPending(true);
    try {
      const r = await client.submit(dmcaInput(draft, altcha));
      onReceipt({ id: r.id, receivedAt: new Date().toISOString() });
    } catch (err) {
      // ALTCHA payloads are single use.
      altchaRef.current?.renew();
      const code = errorCode(err);
      toast.error(
        code === "TOO_MANY_REQUESTS"
          ? t("error.rateLimited")
          : code === "BAD_REQUEST"
            ? t("dmca.error.rejected")
            : t("dmca.error.failed"),
      );
    } finally {
      setPending(false);
    }
  };

  const text = (
    key: "name" | "email" | "address" | "phone" | "signature",
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

  const statement = (key: "goodFaith" | "accuracy", testId: string, label: string) => (
    <>
      <Field orientation="horizontal" data-invalid={shown[key] ? true : undefined}>
        <Checkbox
          id={ids[key]}
          data-testid={testId}
          checked={draft[key]}
          aria-invalid={shown[key] ? true : undefined}
          onCheckedChange={(checked) => set(key, checked === true)}
        />
        <FieldLabel htmlFor={ids[key]} className="font-normal">
          {label}
        </FieldLabel>
      </Field>
      {shown[key] ? <FieldError>{shown[key]}</FieldError> : null}
    </>
  );

  return (
    <form data-testid="dmca-form" className="flex flex-col gap-6" onSubmit={(e) => void submit(e)} noValidate>
      <FieldGroup>
        {text("name", "dmca-name", t("dmca.name"), { autoComplete: "name", maxLength: DMCA_NAME_MAX })}
        {text("email", "dmca-email", t("dmca.email"), {
          type: "email",
          autoComplete: "email",
          hint: t("dmca.emailHint"),
        })}
        {text("address", "dmca-address", t("dmca.address"), {
          autoComplete: "street-address",
          maxLength: DMCA_ADDRESS_MAX,
        })}
        {text("phone", "dmca-phone", t("dmca.phone"), {
          type: "tel",
          autoComplete: "tel",
          maxLength: DMCA_PHONE_MAX,
          hint: t("dmca.phoneHint"),
        })}
        <Field data-invalid={shown.work ? true : undefined}>
          <FieldLabel htmlFor={ids.work}>{t("dmca.work")}</FieldLabel>
          <Textarea
            id={ids.work}
            data-testid="dmca-work"
            rows={4}
            maxLength={DMCA_WORK_MAX}
            value={draft.work}
            aria-invalid={shown.work ? true : undefined}
            onChange={(e) => set("work", e.currentTarget.value)}
          />
          <FieldDescription>{t("dmca.workHint")}</FieldDescription>
          {shown.work ? <FieldError>{shown.work}</FieldError> : null}
        </Field>
        <Field data-invalid={shown.urls ? true : undefined}>
          <FieldLabel htmlFor={ids.urls}>{t("dmca.urls")}</FieldLabel>
          <Textarea
            id={ids.urls}
            data-testid="dmca-urls"
            rows={4}
            spellCheck={false}
            value={draft.urls}
            aria-invalid={shown.urls ? true : undefined}
            onChange={(e) => set("urls", e.currentTarget.value)}
          />
          <FieldDescription>{t("dmca.urlsHint", { max: DMCA_URLS_MAX })}</FieldDescription>
          {shown.urls ? <FieldError>{shown.urls}</FieldError> : null}
        </Field>
        {statement("goodFaith", "dmca-good-faith", t("dmca.goodFaith"))}
        {statement("accuracy", "dmca-accuracy", t("dmca.accuracy"))}
        {text("signature", "dmca-signature", t("dmca.signature"), {
          maxLength: DMCA_SIGNATURE_MAX,
          hint: t("dmca.signatureHint"),
        })}
        {/* The shared widget's own wrapper carries the sign-up id; this one carries the DMCA id. */}
        <div data-testid="dmca-altcha" data-state={altcha === null ? "unverified" : "verified"}>
          <AltchaField ref={altchaRef} onChange={setAltcha} />
        </div>
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{t("dmca.falseNotice")}</p>
      <div>
        <Button
          data-testid="dmca-submit"
          type="submit"
          disabled={pending || altcha === null}
          aria-busy={pending || undefined}
        >
          {t("dmca.submit")}
        </Button>
      </div>
    </form>
  );
}
