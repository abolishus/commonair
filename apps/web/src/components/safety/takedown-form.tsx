// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime } from "@commonair/ui";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { AltchaField, type AltchaFieldHandle } from "../altcha-field.tsx";
import { t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { takedownClient, type NciiRelationship, type NciiSubmitInput, type TakedownClient } from "./client.ts";

export const NCII_URLS_MAX = 20;
export const NCII_DESCRIPTION_MAX = 5000;
export const NCII_NAME_MAX = 200;
export const NCII_SIGNATURE_MAX = 200;

/** One URL per line, blank lines ignored; `invalid` lists the lines that are not http(s) URLs. */
export function parseContentUrls(text: string): { urls: string[]; invalid: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const line of lines) {
    let ok = false;
    try {
      const url = new URL(line);
      ok = url.protocol === "https:" || url.protocol === "http:";
    } catch {
      ok = false;
    }
    if (ok) urls.push(line);
    else invalid.push(line);
  }
  return { urls, invalid };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TakedownDraft {
  name: string;
  email: string;
  relationship: NciiRelationship | "";
  urls: string;
  description: string;
  goodFaith: boolean;
  signature: string;
}

export type TakedownField = "name" | "email" | "relationship" | "urls" | "description" | "goodFaith" | "signature";

/** Field errors for a draft (empty when it can be submitted, ALTCHA aside). */
export function takedownErrors(draft: TakedownDraft): Partial<Record<TakedownField, string>> {
  const errors: Partial<Record<TakedownField, string>> = {};
  if (draft.name.trim() === "") errors.name = t("safety.takedown.error.name");
  if (!EMAIL.test(draft.email.trim())) errors.email = t("safety.takedown.error.email");
  if (draft.relationship === "") errors.relationship = t("safety.takedown.error.relationship");
  const { urls, invalid } = parseContentUrls(draft.urls);
  if (invalid.length > 0) errors.urls = t("safety.takedown.error.urlInvalid");
  else if (urls.length === 0) errors.urls = t("safety.takedown.error.urlMissing");
  else if (urls.length > NCII_URLS_MAX) errors.urls = t("safety.takedown.error.urlTooMany", { max: NCII_URLS_MAX });
  if (draft.description.trim() === "") errors.description = t("safety.takedown.error.description");
  if (!draft.goodFaith) errors.goodFaith = t("safety.takedown.error.goodFaith");
  if (draft.signature.trim() === "") errors.signature = t("safety.takedown.error.signature");
  return errors;
}

export interface TakedownReceipt {
  id: string;
  deadlineAt: string;
}

/** The `/takedown` form (`ncii-form`), replaced by `ncii-receipt` once the request is in. */
export function TakedownForm({ client = takedownClient() }: { client?: TakedownClient }): React.JSX.Element {
  const [receipt, setReceipt] = React.useState<TakedownReceipt | null>(null);
  if (receipt) return <TakedownReceiptCard receipt={receipt} />;
  return <TakedownFields client={client} onReceipt={setReceipt} />;
}

export function TakedownReceiptCard({ receipt }: { receipt: TakedownReceipt }): React.JSX.Element {
  return (
    <AlertCallout
      data-testid="ncii-receipt"
      data-request-id={receipt.id}
      data-deadline-at={receipt.deadlineAt}
      tone="info"
      live
      title={t("safety.takedown.receipt.title")}
      description={
        <div className="flex flex-col gap-2">
          <p>{t("safety.takedown.receipt.body")}</p>
          <p>
            {t("safety.takedown.receipt.deadline")} <RelativeTime date={receipt.deadlineAt} />
          </p>
          <p>{t("safety.takedown.receipt.reference", { id: receipt.id })}</p>
        </div>
      }
    />
  );
}

const EMPTY: TakedownDraft = {
  name: "",
  email: "",
  relationship: "",
  urls: "",
  description: "",
  goodFaith: false,
  signature: "",
};

function TakedownFields({
  client,
  onReceipt,
}: {
  client: TakedownClient;
  onReceipt: (receipt: TakedownReceipt) => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<TakedownDraft>(EMPTY);
  const [altcha, setAltcha] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const altchaRef = React.useRef<AltchaFieldHandle>(null);
  const ids = {
    name: React.useId(),
    email: React.useId(),
    urls: React.useId(),
    description: React.useId(),
    goodFaith: React.useId(),
    signature: React.useId(),
  };
  const errors = takedownErrors(draft);
  const shown = touched ? errors : {};
  const set = <K extends keyof TakedownDraft>(key: K, value: TakedownDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || altcha === null || pending || draft.relationship === "") return;
    const input: NciiSubmitInput = {
      requesterName: draft.name.trim(),
      requesterEmail: draft.email.trim(),
      relationship: draft.relationship,
      contentUrls: parseContentUrls(draft.urls).urls,
      description: draft.description.trim(),
      goodFaith: true,
      signature: draft.signature.trim(),
      altcha,
    };
    setPending(true);
    try {
      onReceipt(await client.submit(input));
    } catch (err) {
      // ALTCHA payloads are single use.
      altchaRef.current?.renew();
      const code = errorCode(err);
      toast.error(
        code === "TOO_MANY_REQUESTS"
          ? t("error.rateLimited")
          : code === "BAD_REQUEST"
            ? t("safety.takedown.error.rejected")
            : t("safety.takedown.error.failed"),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <form data-testid="ncii-form" className="flex flex-col gap-6" onSubmit={(e) => void submit(e)} noValidate>
      <FieldGroup>
        <Field data-invalid={shown.name ? true : undefined}>
          <FieldLabel htmlFor={ids.name}>{t("safety.takedown.name")}</FieldLabel>
          <Input
            id={ids.name}
            data-testid="ncii-name"
            autoComplete="name"
            maxLength={NCII_NAME_MAX}
            value={draft.name}
            aria-invalid={shown.name ? true : undefined}
            onChange={(e) => set("name", e.currentTarget.value)}
          />
          {shown.name ? <FieldError>{shown.name}</FieldError> : null}
        </Field>
        <Field data-invalid={shown.email ? true : undefined}>
          <FieldLabel htmlFor={ids.email}>{t("safety.takedown.email")}</FieldLabel>
          <Input
            id={ids.email}
            data-testid="ncii-email"
            type="email"
            autoComplete="email"
            value={draft.email}
            aria-invalid={shown.email ? true : undefined}
            onChange={(e) => set("email", e.currentTarget.value)}
          />
          <FieldDescription>{t("safety.takedown.emailHint")}</FieldDescription>
          {shown.email ? <FieldError>{shown.email}</FieldError> : null}
        </Field>
        <ChoiceToggle
          data-testid="ncii-relationship"
          label={t("safety.takedown.relationship")}
          value={draft.relationship}
          onValueChange={(v) => {
            if (v === "self" || v === "representative") set("relationship", v);
          }}
          wrap
          options={[
            { value: "self", label: t("safety.takedown.relationship.self"), "data-testid": "ncii-relationship-self" },
            {
              value: "representative",
              label: t("safety.takedown.relationship.representative"),
              "data-testid": "ncii-relationship-representative",
            },
          ]}
        />
        {shown.relationship ? <FieldError>{shown.relationship}</FieldError> : null}
        <Field data-invalid={shown.urls ? true : undefined}>
          <FieldLabel htmlFor={ids.urls}>{t("safety.takedown.urls")}</FieldLabel>
          <Textarea
            id={ids.urls}
            data-testid="ncii-urls"
            rows={4}
            spellCheck={false}
            value={draft.urls}
            aria-invalid={shown.urls ? true : undefined}
            onChange={(e) => set("urls", e.currentTarget.value)}
          />
          <FieldDescription>{t("safety.takedown.urlsHint", { max: NCII_URLS_MAX })}</FieldDescription>
          {shown.urls ? <FieldError>{shown.urls}</FieldError> : null}
        </Field>
        <Field data-invalid={shown.description ? true : undefined}>
          <FieldLabel htmlFor={ids.description}>{t("safety.takedown.description")}</FieldLabel>
          <Textarea
            id={ids.description}
            data-testid="ncii-description"
            rows={4}
            maxLength={NCII_DESCRIPTION_MAX}
            value={draft.description}
            aria-invalid={shown.description ? true : undefined}
            onChange={(e) => set("description", e.currentTarget.value)}
          />
          <FieldDescription>{t("safety.takedown.descriptionHint")}</FieldDescription>
          {shown.description ? <FieldError>{shown.description}</FieldError> : null}
        </Field>
        <Field orientation="horizontal" data-invalid={shown.goodFaith ? true : undefined}>
          <Checkbox
            id={ids.goodFaith}
            data-testid="ncii-good-faith"
            checked={draft.goodFaith}
            onCheckedChange={(checked) => set("goodFaith", checked === true)}
          />
          <FieldLabel htmlFor={ids.goodFaith}>{t("safety.takedown.goodFaith")}</FieldLabel>
        </Field>
        {shown.goodFaith ? <FieldError>{shown.goodFaith}</FieldError> : null}
        <Field data-invalid={shown.signature ? true : undefined}>
          <FieldLabel htmlFor={ids.signature}>{t("safety.takedown.signature")}</FieldLabel>
          <Input
            id={ids.signature}
            data-testid="ncii-signature"
            maxLength={NCII_SIGNATURE_MAX}
            value={draft.signature}
            aria-invalid={shown.signature ? true : undefined}
            onChange={(e) => set("signature", e.currentTarget.value)}
          />
          <FieldDescription>{t("safety.takedown.signatureHint")}</FieldDescription>
          {shown.signature ? <FieldError>{shown.signature}</FieldError> : null}
        </Field>
        <AltchaField ref={altchaRef} onChange={setAltcha} />
      </FieldGroup>
      <div>
        <Button
          data-testid="ncii-submit"
          type="submit"
          disabled={pending || altcha === null}
          aria-busy={pending || undefined}
        >
          {t("safety.takedown.submit")}
        </Button>
      </div>
    </form>
  );
}
