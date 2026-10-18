// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Link, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { AltchaField, type AltchaFieldHandle } from "../../components/altcha-field.tsx";
import { FormError } from "../../components/form-error.tsx";
import { LegalDocumentLink, type LegalDoc } from "../../components/legal-document-link.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { signUp } from "../../lib/auth.ts";
import { authErrorMessage } from "../../lib/form-errors.ts";
import { field } from "../../lib/form.ts";

export const Route = createFileRoute("/_app/signup")({ component: SignUpPage });

function SignUpPage(): React.JSX.Element {
  const [docs, setDocs] = React.useState<LegalDoc[] | null>(null);
  const [altcha, setAltcha] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [doneEmail, setDoneEmail] = React.useState<string | null>(null);
  const altchaRef = React.useRef<AltchaFieldHandle>(null);

  React.useEffect(() => {
    api()
      .legal.current()
      .then(setDocs)
      .catch(() => setDocs([]));
  }, []);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!altcha || pending) return;
    const form = new FormData(e.currentTarget);
    const email = field(form, "email").trim();
    setPending(true);
    setError(null);
    try {
      await signUp({
        email,
        username: field(form, "username").trim().toLowerCase(),
        password: field(form, "password"),
        birthDate: field(form, "birthDate"),
        altcha,
        acceptedDocumentIds: form.get("legal") === "on" ? (docs ?? []).map((d) => d.id) : [],
      });
      setDoneEmail(email);
    } catch (err) {
      setError(authErrorMessage(err));
      // The proof of work was spent on this attempt; solve a new one for the retry.
      altchaRef.current?.renew();
    } finally {
      setPending(false);
    }
  };

  if (doneEmail)
    return (
      <section
        data-testid="signup-check-email"
        className="mx-auto flex max-w-md flex-col gap-3 px-4 py-12"
        aria-live="polite"
      >
        <h1 className="font-display text-xl font-semibold">{t("signup.checkEmailTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("signup.checkEmailBody", { email: doneEmail })}</p>
      </section>
    );

  return (
    <section className="mx-auto flex max-w-md flex-col gap-6 px-4 py-12">
      <h1 className="font-display text-xl font-semibold">{t("signup.title")}</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="signup-email">{t("field.email")}</FieldLabel>
            <Input
              id="signup-email"
              data-testid="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="signup-username">{t("field.username")}</FieldLabel>
            <Input
              id="signup-username"
              data-testid="signup-username"
              name="username"
              autoComplete="username"
              required
              minLength={3}
              maxLength={25}
              pattern="[a-z0-9_]{3,25}"
              aria-describedby="signup-username-hint"
            />
            <FieldDescription id="signup-username-hint">{t("signup.usernameHint")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="signup-password">{t("field.password")}</FieldLabel>
            <Input
              id="signup-password"
              data-testid="signup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={256}
              aria-describedby="signup-password-hint"
            />
            <FieldDescription id="signup-password-hint">{t("signup.passwordHint")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="signup-birthdate">{t("field.birthDate")}</FieldLabel>
            <Input id="signup-birthdate" data-testid="signup-birthdate" name="birthDate" type="date" required />
          </Field>
          <div className="flex items-start gap-2 text-xs">
            <input
              id="signup-legal"
              data-testid="signup-legal"
              name="legal"
              type="checkbox"
              required
              className="mt-0.5 size-4 shrink-0 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span>
              <label htmlFor="signup-legal">{t("signup.legalAccept")}</label>{" "}
              {docs && docs.length > 0 && (
                <span className="text-muted-foreground">
                  {t("common.openParen")}
                  {docs.map((d, i) => (
                    <React.Fragment key={d.id}>
                      {i > 0 && t("common.listSeparator")}
                      <LegalDocumentLink doc={d} />
                    </React.Fragment>
                  ))}
                  {t("common.closeParen")}
                </span>
              )}
            </span>
          </div>
          <AltchaField ref={altchaRef} onChange={setAltcha} />
          {error && <FormError>{error}</FormError>}
          <Button
            data-testid="signup-submit"
            type="submit"
            size="lg"
            disabled={!altcha || pending}
            aria-busy={pending || undefined}
          >
            {t("signup.submit")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("signup.haveAccount")}{" "}
            <Link to="/signin" className="underline underline-offset-4">
              {t("nav.signIn")}
            </Link>
          </p>
        </FieldGroup>
      </form>
    </section>
  );
}
