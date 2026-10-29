// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { SignInPasswordField } from "../../components/password-fields.tsx";
import { ResendVerification } from "../../components/resend-verification.tsx";
import { t } from "../../i18n/index.ts";
import { AuthRequestError, signIn } from "../../lib/auth.ts";
import { authErrorMessage } from "../../lib/form-errors.ts";
import { field } from "../../lib/form.ts";
import { returnToSearch, safeReturnTo } from "../../lib/guard.ts";

export const Route = createFileRoute("/_app/signin")({
  // `?returnTo=` (a relative path, e.g. an OAuth consent page); anything else is dropped.
  validateSearch: returnToSearch,
  component: SignInPage,
});

function SignInPage(): React.JSX.Element {
  // From the location, not the route match: the page also renders outside it (tests). Re-checked.
  const returnTo = safeReturnTo(useLocation({ select: (l) => (l.search as { returnTo?: unknown }).returnTo }));
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
      // A full load renders the dashboard on the server with the new session cookie
      // (stays pending until the page goes away).
      window.location.assign(returnTo ?? "/dashboard");
    } catch (err) {
      setError(authErrorMessage(err));
      if (err instanceof AuthRequestError && err.code === "EMAIL_NOT_VERIFIED") setUnverified(email);
      setPending(false);
    }
  };

  return (
    <PageContainer width="form" className="flex flex-col gap-6 py-12">
      <PageHeader title={t("signin.title")} />
      <form onSubmit={(e) => void onSubmit(e)}>
        <FieldGroup>
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
          <SignInPasswordField />
          {error && <FormError>{error}</FormError>}
          {unverified && <ResendVerification email={unverified} callbackURL={returnTo} />}
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
            <Button
              variant="link"
              nativeButton={false}
              render={<Link to="/signup" search={returnTo === undefined ? {} : { returnTo }} />}
            >
              {t("nav.signUp")}
            </Button>
          </FieldDescription>
        </FieldGroup>
      </form>
    </PageContainer>
  );
}
