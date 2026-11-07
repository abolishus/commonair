// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Link, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { AuthLayout } from "../../components/auth-layout.tsx";
import { FormError } from "../../components/form-error.tsx";
import { ResetPasswordField, SignInPasswordField } from "../../components/password-fields.tsx";
import { ResendVerification } from "../../components/resend-verification.tsx";
import { t } from "../../i18n/index.ts";
import { AuthRequestError, signIn } from "../../lib/auth.ts";
import { authSearch, authTarget, carriedSearch, signInLanding, type AuthSearch } from "../../lib/auth-return.ts";
import { authErrorMessage } from "../../lib/form-errors.ts";
import { field } from "../../lib/form.ts";
import { titleHead } from "../../lib/page-title.ts";
import { requestPasswordReset, resetPassword } from "../../lib/password-reset.ts";

export const Route = createFileRoute("/_app/signin")({
  head: () => titleHead(t("pageTitle.signin")),
  // `?redirect=` (where the visitor came from) or `?returnTo=` (a route guard, e.g. an OAuth
  // consent page): same-origin paths only, anything else is dropped. `?token=`/`?error=` are the
  // password reset link's landing.
  validateSearch: authSearch,
  component: SignInPage,
});

/** What the page shows: the sign-in form, the reset request, or the new password (`?token=`). */
type Mode = "signin" | "request" | "sent" | "reset" | "resetDone";

function initialMode(search: AuthSearch): Mode {
  if (search.token) return "reset";
  if (search.error) return "request";
  return "signin";
}

function SignInPage(): React.JSX.Element {
  // From the location, not the route match: the page also renders outside it (tests). Re-checked.
  const search = authSearch(useLocation().search as Record<string, unknown>);
  const target = authTarget(search);
  const carried = carriedSearch(search);
  const [mode, setMode] = React.useState<Mode>(() => initialMode(search));

  if (mode === "request" || mode === "sent")
    return (
      <RequestReset
        sent={mode === "sent"}
        expired={search.error !== undefined}
        onSent={() => setMode("sent")}
        onBack={() => setMode("signin")}
      />
    );
  if (mode === "reset" && search.token)
    return <ChooseNewPassword token={search.token} carried={carried} onDone={() => setMode("resetDone")} />;
  return (
    <SignInForm
      target={target}
      carried={carried}
      notice={mode === "resetDone" ? t("polish.auth.reset.done") : null}
      onForgot={() => setMode("request")}
    />
  );
}

function SignInForm({
  target,
  carried,
  notice,
  onForgot,
}: {
  target: string | undefined;
  carried: ReturnType<typeof carriedSearch>;
  notice: string | null;
  onForgot: () => void;
}): React.JSX.Element {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  /** The address of a sign-in refused as unverified: offers a new link for it. */
  const [unverified, setUnverified] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    const email = field(form, "email").trim();
    setPending(true);
    setError(null);
    setUnverified(null);
    try {
      await signIn(email, field(form, "password"));
      // F11: the target, else the studio for an account that streams and home for everyone else.
      // A full load renders it on the server with the new session cookie (stays pending until the
      // page goes away).
      window.location.assign(await signInLanding(target));
    } catch (err) {
      setError(authErrorMessage(err));
      if (err instanceof AuthRequestError && err.code === "EMAIL_NOT_VERIFIED") setUnverified(email);
      setPending(false);
    }
  };

  return (
    <AuthLayout title={t("signin.title")}>
      <form onSubmit={(e) => void onSubmit(e)}>
        <FieldGroup>
          {notice && (
            <p data-testid="signin-notice" aria-live="polite">
              {notice}
            </p>
          )}
          <Field>
            <FieldLabel htmlFor="signin-email">{t("field.email")}</FieldLabel>
            <Input
              id="signin-email"
              data-testid="signin-email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </Field>
          <SignInPasswordField
            forgotPassword={
              <Button type="button" variant="link" size="sm" data-testid="signin-forgot-password" onClick={onForgot}>
                {t("polish.auth.forgotPassword")}
              </Button>
            }
          />
          {error && <FormError>{error}</FormError>}
          {unverified && <ResendVerification email={unverified} callbackURL={target} />}
          <Button
            data-testid="signin-submit"
            type="submit"
            size="lg"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {t("signin.submit")}
          </Button>
          <FieldDescription>
            {t("signin.noAccount")}{" "}
            <Button variant="link" nativeButton={false} render={<Link to="/signup" search={carried} />}>
              {t("nav.signUp")}
            </Button>
          </FieldDescription>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}

/** "Forgot password?": one neutral answer whether or not the address has an account. */
function RequestReset({
  sent,
  expired,
  onSent,
  onBack,
}: {
  sent: boolean;
  expired: boolean;
  onSent: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const email = field(new FormData(e.currentTarget), "email").trim();
    setPending(true);
    setError(null);
    try {
      await requestPasswordReset(email);
      onSent();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      data-testid="signin-reset-request"
      title={t("polish.auth.reset.requestTitle")}
      description={t("polish.auth.reset.requestBody")}
    >
      {sent ? (
        <p data-testid="signin-reset-sent" aria-live="polite">
          {t("polish.auth.reset.sent")}
        </p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)}>
          <FieldGroup>
            {expired && <FormError>{t("polish.auth.reset.invalid")}</FormError>}
            <Field>
              <FieldLabel htmlFor="reset-email">{t("field.email")}</FieldLabel>
              <Input
                id="reset-email"
                data-testid="reset-email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </Field>
            {error && <FormError>{error}</FormError>}
            <Button type="submit" size="lg" disabled={pending} aria-busy={pending || undefined}>
              {t("polish.auth.reset.send")}
            </Button>
          </FieldGroup>
        </form>
      )}
      <div>
        <Button type="button" variant="link" onClick={onBack}>
          {t("nav.signIn")}
        </Button>
      </div>
    </AuthLayout>
  );
}

/** The reset link's landing (`/signin?token=`): the new password, then back to signing in. */
function ChooseNewPassword({
  token,
  carried,
  onDone,
}: {
  token: string;
  carried: ReturnType<typeof carriedSearch>;
  onDone: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await resetPassword(token, field(new FormData(e.currentTarget), "password"));
      // The token is spent: drop it from the address bar (and history).
      void navigate({ to: "/signin", search: carried, replace: true });
      onDone();
    } catch (err) {
      setError(
        err instanceof AuthRequestError && err.code === "INVALID_TOKEN"
          ? t("polish.auth.reset.invalid")
          : authErrorMessage(err),
      );
      setPending(false);
    }
  };

  return (
    <AuthLayout data-testid="signin-reset-new" title={t("polish.auth.reset.newTitle")}>
      <form onSubmit={(e) => void onSubmit(e)}>
        <FieldGroup>
          <ResetPasswordField />
          {error && <FormError>{error}</FormError>}
          <Button type="submit" size="lg" disabled={pending} aria-busy={pending || undefined}>
            {t("polish.auth.reset.newSubmit")}
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
