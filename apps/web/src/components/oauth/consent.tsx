// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/oauth2/authorize` (ADR 0027 §1): ask the API whether the request is sound, then either go
 * straight back to the app (`redirect`, or an existing grant without `force_verify`), show why it
 * cannot go back (`oauth-consent-error`, never a redirect), or show the consent card. Approve and
 * deny both go through `developer.oauth.decide`, whose `redirectTo` the API built from the app's
 * registered redirect URI; the page navigates nowhere else. Nothing from the query is rendered.
 */
import type { Scope } from "@commonair/contracts/scopes";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader } from "@commonair/ui/components/card";
import { Skeleton, SkeletonButton, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { PageContainer } from "@commonair/ui/layouts";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { errorRequirement } from "../../lib/coop.ts";
import { AppOwner } from "./app-owner.tsx";
import { type AuthorizeSearch, forcesVerify, requestInput } from "./authorize-query.ts";
import { ScopeList } from "./scope-list.tsx";
import { type AppSummaryDto, type ConsentErrorCode, type Navigator, type OAuthClient, consentError } from "./shared.ts";

export type AuthorizeErrorCode = ConsentErrorCode | "invalid_request";

type View =
  | { kind: "loading" }
  | { kind: "leaving" }
  | { kind: "error"; error: AuthorizeErrorCode }
  | { kind: "auto"; app: AppSummaryDto; scopes: Scope[] }
  | { kind: "consent"; app: AppSummaryDto; scopes: Scope[]; alreadyGranted: boolean };

const ERROR_TEXT: Record<AuthorizeErrorCode, MessageKey> = {
  invalid_client: "oauth.error.invalidClient",
  invalid_redirect_uri: "oauth.error.invalidRedirectUri",
  app_suspended: "oauth.error.appSuspended",
  invalid_request: "oauth.error.invalidRequest",
  request_failed: "oauth.error.failed",
};

/** A `developer.oauth.request` failure: a malformed request (`BAD_REQUEST`) is not worth retrying. */
export function authorizeError(err: unknown): AuthorizeErrorCode {
  return errorCode(err) === "BAD_REQUEST" ? "invalid_request" : consentError(err);
}

/** Why `developer.oauth.decide` failed, as one inline sentence under the buttons. */
export function decideErrorText(err: unknown): MessageKey {
  if (errorCode(err) === "PRECONDITION_FAILED" && errorRequirement(err) === "app_suspended")
    return "oauth.consent.decideSuspended";
  if (["NOT_FOUND", "PRECONDITION_FAILED", "BAD_REQUEST"].includes(errorCode(err) ?? ""))
    return "oauth.consent.decideInvalid";
  return "oauth.consent.decideFailed";
}

export interface ConsentPageProps {
  /** The query exactly as the app sent it (`authorizeQueryFrom`). */
  query: AuthorizeSearch;
  client: OAuthClient;
  /** The signed-in member (the route guard guarantees one). */
  me: { username: string };
  navigator: Navigator;
  /** "Not you?": sign out, then sign in again and come back to this request. */
  onSwitchAccount: () => Promise<void>;
}

export function ConsentPage({ query, client, me, navigator, onSwitchAccount }: ConsentPageProps): React.JSX.Element {
  const [view, setView] = React.useState<View>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [decideError, setDecideError] = React.useState<MessageKey | null>(null);

  const prepared = React.useMemo(() => requestInput(query), [query]);

  const decide = React.useCallback(
    async (approve: boolean, how: "assign" | "replace") => {
      if (!prepared.ok) return false;
      const { clientId, redirectUri, scope, state, codeChallenge } = prepared.input;
      setPending(true);
      setDecideError(null);
      try {
        const { redirectTo } = await client.oauth.decide({
          clientId,
          redirectUri,
          scope,
          ...(state === undefined ? {} : { state }),
          // The request answered `consent`, so the API already checked the challenge is S256.
          codeChallenge: codeChallenge ?? "",
          codeChallengeMethod: "S256",
          approve,
        });
        // Stays pending: the page is going away.
        navigator[how](redirectTo);
        return true;
      } catch (err) {
        setDecideError(decideErrorText(err));
        setPending(false);
        return false;
      }
    },
    [client, navigator, prepared],
  );

  React.useEffect(() => {
    if (!prepared.ok) return;
    let live = true;
    client.oauth
      .request(prepared.input)
      .then(async (answer) => {
        if (!live) return;
        if (answer.kind === "redirect") {
          setView({ kind: "leaving" });
          navigator.replace(answer.redirectTo);
          return;
        }
        if (answer.alreadyGranted && !forcesVerify(query)) {
          // Already granted: approve without asking again, the card's skeleton meanwhile.
          setView({ kind: "auto", app: answer.app, scopes: answer.scopes });
          const ok = await decide(true, "replace");
          if (live && !ok) setView({ kind: "consent", app: answer.app, scopes: answer.scopes, alreadyGranted: true });
          return;
        }
        setView({ kind: "consent", app: answer.app, scopes: answer.scopes, alreadyGranted: answer.alreadyGranted });
      })
      .catch((err: unknown) => {
        if (live) setView({ kind: "error", error: authorizeError(err) });
      });
    return () => {
      live = false;
    };
    // `decide` changes only with these, so it never asks twice for one request.
  }, [client, navigator, query, prepared, attempt, decide]);

  const retry = () => {
    setView({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  // Without a client id or a redirect URI there is nothing to ask the API.
  if (!prepared.ok) return <ConsentError error={prepared.error} onRetry={retry} />;
  if (view.kind === "error") return <ConsentError error={view.error} onRetry={retry} />;
  if (view.kind === "loading" || view.kind === "auto" || view.kind === "leaving")
    return (
      <ConsentSkeleton label={view.kind === "loading" ? t("oauth.consent.checking") : t("oauth.consent.returning")} />
    );
  return (
    <ConsentCard
      app={view.app}
      scopes={view.scopes}
      alreadyGranted={view.alreadyGranted}
      me={me}
      pending={pending}
      error={decideError}
      onApprove={() => void decide(true, "assign")}
      onDeny={() => void decide(false, "assign")}
      onSwitchAccount={onSwitchAccount}
    />
  );
}

/** Puts keyboard and screen-reader focus on the heading when the card or result appears. */
export function useFocusOnMount<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = React.useRef<T>(null);
  React.useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, []);
  return ref;
}

/** The card's loading shape; the route also shows it until it has read the query. */
export function ConsentSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <PageContainer width="form" className="py-8 sm:py-12">
      <SkeletonGroup label={label} data-testid="oauth-consent-loading">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <SkeletonText lines={4} />
          </CardContent>
          <CardFooter className="flex gap-2">
            <SkeletonButton />
            <SkeletonButton />
          </CardFooter>
        </Card>
      </SkeletonGroup>
    </PageContainer>
  );
}

function ConsentError({ error, onRetry }: { error: AuthorizeErrorCode; onRetry: () => void }): React.JSX.Element {
  const ref = useFocusOnMount<HTMLDivElement>();
  return (
    <PageContainer width="form" className="py-8 sm:py-12">
      <div ref={ref} tabIndex={-1} className="outline-none">
        <AlertCallout
          data-testid="oauth-consent-error"
          data-error={error}
          tone="danger"
          live
          title={t("oauth.error.title")}
          description={t(ERROR_TEXT[error])}
          action={
            <>
              {error === "request_failed" && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {t("oauth.error.retry")}
                </Button>
              )}
              {/* A real link styled as the house link button (Base UI's Button would give it role=button). */}
              <a href="/" className={buttonVariants({ variant: "link", size: "sm" })}>
                {t("oauth.error.home")}
              </a>
            </>
          }
        />
      </div>
    </PageContainer>
  );
}

export interface ConsentCardProps {
  app: AppSummaryDto;
  scopes: readonly Scope[];
  alreadyGranted: boolean;
  me: { username: string };
  pending: boolean;
  error: MessageKey | null;
  onApprove: () => void;
  onDeny: () => void;
  onSwitchAccount: () => Promise<void>;
}

export function ConsentCard({
  app,
  scopes,
  alreadyGranted,
  me,
  pending,
  error,
  onApprove,
  onDeny,
  onSwitchAccount,
}: ConsentCardProps): React.JSX.Element {
  const headingRef = useFocusOnMount<HTMLHeadingElement>();
  const listId = React.useId();
  const [switching, setSwitching] = React.useState(false);
  const [switchFailed, setSwitchFailed] = React.useState(false);

  const switchAccount = async () => {
    setSwitching(true);
    setSwitchFailed(false);
    try {
      await onSwitchAccount();
    } catch {
      setSwitchFailed(true);
      setSwitching(false);
    }
  };

  return (
    <PageContainer width="form" className="py-8 sm:py-12">
      <Card
        data-testid="oauth-consent"
        data-client-id={app.clientId}
        data-already-granted={alreadyGranted ? "true" : "false"}
      >
        <CardHeader className="flex flex-col gap-2">
          <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold break-words outline-none">
            {t("oauth.consent.heading", { app: app.name })}
          </h1>
          {app.description && <p className="text-sm break-words text-muted-foreground">{app.description}</p>}
          <AppOwner owner={app.owner} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p id={listId} className="text-sm font-medium">
            {t("oauth.consent.willAbleTo", { app: app.name })}
            <span className="sr-only"> ({t("oauth.consent.scopeCount", { count: scopes.length })})</span>
          </p>
          <ScopeList scopes={scopes} labelledBy={listId} />
          <p className="text-xs text-muted-foreground">{t("oauth.consent.notSee")}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{t("oauth.consent.signedInAs", { username: me.username })}</span>
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0"
              disabled={switching || pending}
              onClick={() => void switchAccount()}
            >
              {t("oauth.consent.notYou")}
            </Button>
          </p>
          {switchFailed && (
            <p role="alert" className="text-xs text-destructive">
              {t("oauth.consent.signOutFailed")}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button data-testid="oauth-consent-deny" variant="outline" disabled={pending} onClick={onDeny}>
              {t("oauth.consent.deny")}
            </Button>
            <Button data-testid="oauth-consent-approve" disabled={pending} onClick={onApprove}>
              {t("oauth.consent.approve", { app: app.name })}
            </Button>
          </div>
          {error && (
            <p role="alert" data-testid="oauth-consent-decide-error" className="text-sm text-destructive">
              {t(error)}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t("oauth.consent.afterwards")}</p>
        </CardFooter>
      </Card>
    </PageContainer>
  );
}
