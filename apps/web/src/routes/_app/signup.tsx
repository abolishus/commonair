// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PasswordField } from "@commonair/ui/blocks/forms";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
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

// Passed as a variable (not an inline literal) so the `data-testid` key is not an excess property.
const passwordInputProps = {
  "data-testid": "signup-password",
  name: "password",
  required: true,
  minLength: 10,
  maxLength: 256,
  "aria-describedby": "signup-password-hint",
};

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
      <PageContainer data-testid="signup-check-email" width="narrow" className="max-w-md py-12" aria-live="polite">
        <PageHeader
          title={t("signup.checkEmailTitle")}
          description={t("signup.checkEmailBody", { email: doneEmail })}
        />
      </PageContainer>
    );

  return (
    <PageContainer width="narrow" className="flex max-w-md flex-col gap-6 py-12">
      <PageHeader title={t("signup.title")} />
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
          {/* PasswordField has no hint slot; the hint follows it and is wired with aria-describedby. */}
          <PasswordField
            label={t("field.password")}
            showLabel={t("field.showPassword")}
            hideLabel={t("field.hidePassword")}
            inputProps={passwordInputProps}
          />
          <FieldDescription id="signup-password-hint">{t("signup.passwordHint")}</FieldDescription>
          {/* E4a gap: DateOfBirthField is three Selects; the e1 contract (and the harness) fill
              `signup-birthdate` as one `<input type="date">`, so the date input stays until the
              contract or the block offers a native-date variant. */}
          <Field>
            <FieldLabel htmlFor="signup-birthdate">{t("field.birthDate")}</FieldLabel>
            <Input id="signup-birthdate" data-testid="signup-birthdate" name="birthDate" type="date" required />
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="signup-legal" data-testid="signup-legal" name="legal" required />
            <FieldContent>
              <FieldLabel htmlFor="signup-legal">{t("signup.legalAccept")}</FieldLabel>
              {docs && docs.length > 0 && (
                <FieldDescription>
                  {t("common.openParen")}
                  {docs.map((d, i) => (
                    <React.Fragment key={d.id}>
                      {i > 0 && t("common.listSeparator")}
                      <LegalDocumentLink doc={d} />
                    </React.Fragment>
                  ))}
                  {t("common.closeParen")}
                </FieldDescription>
              )}
            </FieldContent>
          </Field>
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
          <FieldDescription>
            {t("signup.haveAccount")}{" "}
            <Link to="/signin" className={buttonVariants({ variant: "link", className: "px-0" })}>
              {t("nav.signIn")}
            </Link>
          </FieldDescription>
        </FieldGroup>
      </form>
    </PageContainer>
  );
}
