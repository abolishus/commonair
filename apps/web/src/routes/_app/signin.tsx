// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { SignInPasswordField } from "../../components/password-fields.tsx";
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
            <Button variant="link" nativeButton={false} render={<Link to="/signup" />}>
              {t("nav.signUp")}
            </Button>
          </FieldDescription>
        </FieldGroup>
      </form>
    </PageContainer>
  );
}
