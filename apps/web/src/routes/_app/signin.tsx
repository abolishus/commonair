// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { t } from "../../i18n/index.ts";
import { signIn } from "../../lib/auth.ts";
import { authErrorMessage } from "../../lib/form-errors.ts";
import { field } from "../../lib/form.ts";

export const Route = createFileRoute("/_app/signin")({ component: SignInPage });

function SignInPage(): React.JSX.Element {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await signIn(field(form, "email").trim(), field(form, "password"));
      // A full load renders the dashboard on the server with the new session cookie
      // (stays pending until the page goes away).
      window.location.assign("/dashboard");
    } catch (err) {
      setError(authErrorMessage(err));
      setPending(false);
    }
  };

  return (
    <PageContainer width="narrow" className="flex max-w-md flex-col gap-6 py-12">
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
          {/* E4a gap: PasswordField forces autocomplete="new-password", which makes password managers
              offer a new password on sign-in; it needs to pass `autoComplete` through first. */}
          <Field>
            <FieldLabel htmlFor="signin-password">{t("field.password")}</FieldLabel>
            <Input
              id="signin-password"
              data-testid="signin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <FormError>{error}</FormError>}
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
            <Link to="/signup" className={buttonVariants({ variant: "link", className: "px-0" })}>
              {t("nav.signUp")}
            </Link>
          </FieldDescription>
        </FieldGroup>
      </form>
    </PageContainer>
  );
}
