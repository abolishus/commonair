// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public attestation verifier (`/attestations/verify`, ADR 0014 decision 7): paste a signed
 * statement (or a window of them), the API checks it against this instance's published key
 * history (`integrity.attestations.verify`), and the page says plainly whether it holds, which
 * instance signed it (prominently: a statement is only as good as its signer), what it says, and
 * that excluded traffic is not proof of wrongdoing. Screen-reader first: one form, a polite live
 * region for the result, headings in order. Public, no session.
 */
import type { AttestationVerifyResult } from "@commonair/contracts/dto";
import { StatusBadge, formatDateTime, formatNumber, useLocale } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Alert, AlertDescription, AlertTitle } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { hoursOf } from "../analytics/data.ts";
import { FormError } from "../form-error.tsx";
import { type VerifierClient, verifierClient } from "./client.ts";
import { PROBLEM_KEYS, kindKey } from "./labels.ts";
import { averageViewers, figuresOf, hostOf, isProblem, parseVerifierInput } from "./statement.ts";

/** Statement text the page accepts (a 2000-entry bundle of 8 KiB payloads, with room). */
const MAX_INPUT = 20_000_000;

export interface AttestationVerifierProps {
  client?: VerifierClient;
}

export function AttestationVerifier({ client: clientProp }: AttestationVerifierProps = {}): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? verifierClient());
  const inputId = React.useId();
  const hintId = React.useId();
  const [text, setText] = React.useState("");
  const [unparsable, setUnparsable] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<AttestationVerifyResult | null>(null);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const input = parseVerifierInput(text);
    setResult(null);
    setFailed(false);
    setUnparsable(input === null);
    if (!input) return;
    setBusy(true);
    client
      .verify(input)
      .then(setResult)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <PageContainer data-testid="attestation-verify-page" className="flex max-w-3xl flex-col gap-6 py-8">
      <PageHeader title={t("attestations.verify.title")} description={t("attestations.verify.intro")} />
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field data-invalid={unparsable || undefined}>
          <FieldLabel htmlFor={inputId}>{t("attestations.verify.inputLabel")}</FieldLabel>
          <Textarea
            id={inputId}
            data-testid="attestation-verify-input"
            aria-describedby={hintId}
            aria-invalid={unparsable || undefined}
            value={text}
            maxLength={MAX_INPUT}
            rows={8}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            onChange={(e) => setText(e.target.value)}
          />
          <FieldDescription id={hintId}>{t("attestations.verify.inputHint")}</FieldDescription>
          {unparsable ? <FieldError>{t("attestations.verify.unparsable")}</FieldError> : null}
        </Field>
        <div>
          <Button data-testid="attestation-verify-submit" type="submit" disabled={busy || text.trim() === ""}>
            {busy ? t("attestations.verify.checking") : t("attestations.verify.submit")}
          </Button>
        </div>
      </form>
      <div aria-live="polite" aria-atomic="true" className="flex flex-col gap-4">
        {failed ? <FormError>{t("attestations.verify.failed")}</FormError> : null}
        {result ? <VerifyResult result={result} /> : null}
      </div>
      <p className="text-sm text-muted-foreground">{t("attestations.verify.notProof")}</p>
    </PageContainer>
  );
}

export function VerifyResult({ result }: { result: AttestationVerifyResult }): React.JSX.Element {
  const { locale } = useLocale();
  const f = figuresOf(result.statement);
  const reason = result.valid ? null : isProblem(result.problem) ? result.problem : "unknown";
  const hours = (s: number) => t("attestations.entry.hours", { hours: hoursOf(s, locale) });
  return (
    <section
      data-testid="attestation-verify-result"
      data-valid={result.valid ? "true" : "false"}
      {...(reason ? { "data-reason": reason } : {})}
      aria-labelledby="attestation-verify-result-heading"
      className="flex flex-col gap-4"
    >
      <Alert variant={result.valid ? "default" : "destructive"}>
        <AlertTitle>
          <h2 id="attestation-verify-result-heading" className="text-base font-semibold">
            {result.valid ? t("attestations.verify.valid") : t("attestations.verify.invalid")}
          </h2>
        </AlertTitle>
        <AlertDescription>
          {reason ? t(PROBLEM_KEYS[reason]) : t("attestations.verify.validDescription")}
        </AlertDescription>
      </Alert>
      {result.origin ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t("attestations.verify.signedBy")}</p>
          <p
            data-testid="attestation-verify-origin"
            data-origin={result.origin}
            className="text-2xl font-semibold break-all"
          >
            {hostOf(result.origin)}
          </p>
        </div>
      ) : null}
      {f ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{t("attestations.verify.figures")}</h3>
            <StatusBadge tone="neutral">{t(kindKey(f.kind))}</StatusBadge>
          </div>
          <KeyValueList
            rows={[
              {
                term: t("attestations.verify.period"),
                value: t("attestations.verify.periodRange", {
                  start: formatDateTime(new Date(f.periodStart), locale),
                  end: formatDateTime(new Date(f.periodEnd), locale),
                }),
              },
              { term: t("attestations.entry.verifiedHours"), value: hours(f.verifiedViewerSeconds) },
              { term: t("attestations.verify.average"), value: formatNumber(Math.round(averageViewers(f)), locale) },
              { term: t("attestations.entry.peak"), value: formatNumber(f.peakVerifiedConcurrent, locale) },
              { term: t("attestations.verify.unverifiedHours"), value: hours(f.unverifiedViewerSeconds) },
              { term: t("attestations.entry.excludedHours"), value: hours(f.excludedViewerSeconds) },
              { term: t("attestations.entry.signed"), value: formatDateTime(new Date(f.signedAt), locale) },
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}
