// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/activate` (RFC 8628, ADR 0027 §2): the member types the code a headless app shows, sees the
 * same consent as `/oauth2/authorize`, and approves or denies. The code travels only in request
 * bodies (`developer.oauth.activation` is a POST); the page never puts it in a URL.
 */
import { normalizeUserCode } from "@commonair/contracts/oauth";
import { RelativeTime } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import * as React from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { t } from "../../i18n/index.ts";
import { fillNode } from "../../lib/fill.tsx";
import { AppOwner } from "./app-owner.tsx";
import { useFocusOnMount } from "./consent.tsx";
import { ScopeList } from "./scope-list.tsx";
import {
  type DeviceConsentDto,
  type DeviceErrorCode,
  type OAuthClient,
  USER_CODE_LENGTH,
  deviceError,
  formatUserCode,
} from "./shared.ts";

type View =
  | { kind: "form" }
  | { kind: "consent"; userCode: string; consent: DeviceConsentDto }
  | { kind: "error"; error: DeviceErrorCode }
  | { kind: "done"; result: "approved" | "denied" };

const DEVICE_ERROR_TEXT: Record<DeviceErrorCode, MessageKey> = {
  not_found: "oauth.device.notFound",
  expired: "oauth.device.expired",
  app_suspended: "oauth.device.suspended",
};

/** A typed code is usable once it has exactly the eight letters (any case, dash or none). */
export function usableUserCode(typed: string): string | null {
  const normalized = normalizeUserCode(typed);
  return normalized.length === USER_CODE_LENGTH ? normalized : null;
}

export interface DeviceActivationProps {
  client: OAuthClient;
  /** The `?code=` the device showed in its verification link, if any. */
  initialCode?: string | undefined;
}

export function DeviceActivation({ client, initialCode }: DeviceActivationProps): React.JSX.Element {
  const [view, setView] = React.useState<View>({ kind: "form" });

  if (view.kind === "consent")
    return (
      <DeviceConsent
        client={client}
        userCode={view.userCode}
        consent={view.consent}
        onDone={(result) => setView({ kind: "done", result })}
        onRefused={(error) => setView({ kind: "error", error })}
      />
    );
  return (
    <PageContainer width="form" className="flex flex-col gap-6 py-8 sm:py-12">
      {view.kind === "done" ? (
        <DeviceDone result={view.result} />
      ) : (
        <>
          <PageHeader title={t("oauth.device.pageTitle")} description={t("oauth.device.intro")} />
          {view.kind === "error" && (
            <AlertCallout
              data-testid="device-error"
              data-error={view.error}
              tone="danger"
              live
              description={t(DEVICE_ERROR_TEXT[view.error])}
            />
          )}
          <DeviceForm
            client={client}
            initialCode={initialCode}
            onConsent={(userCode, consent) => setView({ kind: "consent", userCode, consent })}
            onRefused={(error) => setView({ kind: "error", error })}
          />
        </>
      )}
    </PageContainer>
  );
}

function DeviceForm({
  client,
  initialCode,
  onConsent,
  onRefused,
}: {
  client: OAuthClient;
  initialCode?: string | undefined;
  onConsent: (userCode: string, consent: DeviceConsentDto) => void;
  onRefused: (error: DeviceErrorCode) => void;
}): React.JSX.Element {
  const [code, setCode] = React.useState(() => {
    const prefilled = normalizeUserCode(initialCode ?? "").slice(0, USER_CODE_LENGTH);
    return prefilled ? formatUserCode(prefilled) : "";
  });
  const [invalid, setInvalid] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const inputId = React.useId();
  const hintId = React.useId();
  const errorId = React.useId();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const userCode = usableUserCode(code);
    setFailed(false);
    if (!userCode) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setPending(true);
    try {
      onConsent(userCode, await client.oauth.activation({ userCode }));
    } catch (err) {
      const refused = deviceError(err);
      if (refused) onRefused(refused);
      else setFailed(true);
      setPending(false);
    }
  };

  return (
    <form data-testid="device-form" noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
      <Field data-invalid={invalid || undefined}>
        <FieldLabel htmlFor={inputId}>{t("oauth.device.codeLabel")}</FieldLabel>
        <Input
          id={inputId}
          data-testid="device-code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={16}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
          className="font-mono text-base tracking-widest uppercase"
        />
        <FieldDescription id={hintId}>{t("oauth.device.codeHint")}</FieldDescription>
        {invalid && <FieldError id={errorId}>{t("oauth.device.codeInvalid")}</FieldError>}
      </Field>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t("oauth.device.lookupFailed")}
        </p>
      )}
      <Button data-testid="device-submit" type="submit" disabled={pending} className="self-start">
        {t("oauth.device.submit")}
      </Button>
    </form>
  );
}

function DeviceConsent({
  client,
  userCode,
  consent,
  onDone,
  onRefused,
}: {
  client: OAuthClient;
  userCode: string;
  consent: DeviceConsentDto;
  onDone: (result: "approved" | "denied") => void;
  onRefused: (error: DeviceErrorCode) => void;
}): React.JSX.Element {
  const headingRef = useFocusOnMount<HTMLHeadingElement>();
  const listId = React.useId();
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const { app, scopes } = consent;

  const decide = async (approve: boolean) => {
    setPending(true);
    setFailed(false);
    try {
      await client.oauth.activate({ userCode, approve });
      onDone(approve ? "approved" : "denied");
    } catch (err) {
      const refused = deviceError(err);
      if (refused) onRefused(refused);
      else {
        setFailed(true);
        setPending(false);
      }
    }
  };

  return (
    <PageContainer width="form" className="py-8 sm:py-12">
      <Card data-testid="device-consent" data-client-id={app.clientId}>
        <CardHeader className="flex flex-col gap-2">
          <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold break-words outline-none">
            {t("oauth.device.consentHeading", { app: app.name })}
          </h1>
          {app.description && <p className="text-sm break-words text-muted-foreground">{app.description}</p>}
          <AppOwner owner={app.owner} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p id={listId} className="text-sm font-medium">
            {t("oauth.consent.willAbleTo", { app: app.name })}
          </p>
          <ScopeList scopes={scopes} labelledBy={listId} />
          <p className="text-xs text-muted-foreground">{t("oauth.consent.notSee")}</p>
          <p className="text-xs text-muted-foreground">
            {fillNode(t("oauth.device.expires"), "when", <RelativeTime date={consent.expiresAt} />)}
          </p>
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button data-testid="device-deny" variant="outline" disabled={pending} onClick={() => void decide(false)}>
              {t("oauth.device.deny")}
            </Button>
            <Button data-testid="device-approve" disabled={pending} onClick={() => void decide(true)}>
              {t("oauth.device.approve", { app: app.name })}
            </Button>
          </div>
          {failed && (
            <p role="alert" className="text-sm text-destructive">
              {t("oauth.device.decideFailed")}
            </p>
          )}
        </CardFooter>
      </Card>
    </PageContainer>
  );
}

/** The outcome; focus moves to its heading, so screen readers announce it. */
function DeviceDone({ result }: { result: "approved" | "denied" }): React.JSX.Element {
  const headingRef = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div data-testid="device-done" data-result={result} className="flex flex-col gap-2">
      <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        {t(result === "approved" ? "oauth.device.approved" : "oauth.device.denied")}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t(result === "approved" ? "oauth.device.approvedBody" : "oauth.device.deniedBody")}
      </p>
    </div>
  );
}
