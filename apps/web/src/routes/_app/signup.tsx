// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { AltchaField, type AltchaFieldHandle } from "../../components/altcha-field.tsx";
import { FormError } from "../../components/form-error.tsx";
import { LegalDocumentList, splitByAcceptance, type LegalDoc } from "../../components/legal-document-link.tsx";
import { SignUpPasswordField } from "../../components/password-fields.tsx";
import { ResendVerification } from "../../components/resend-verification.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { signUp } from "../../lib/auth.ts";
import { authErrorMessage } from "../../lib/form-errors.ts";
import { field } from "../../lib/form.ts";
import { returnToSearch, safeReturnTo } from "../../lib/guard.ts";

export const Route = createFileRoute("/_app/signup")({
  // `?returnTo=`: the verification link lands there (e.g. back on an OAuth consent page).
  validateSearch: returnToSearch,
  component: SignUpPage,
});

function SignUpPage(): React.JSX.Element {
  // From the location, not the route match: the page also renders outside it (tests). Re-checked.
  const returnTo = safeReturnTo(useLocation({ select: (l) => (l.search as { returnTo?: unknown }).returnTo }));
  const [docs, setDocs] = React.useState<LegalDoc[] | null>(null);
  const [altcha, setAltcha] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [doneEmail, setDoneEmail] = React.useState<string | null>(null);
  const altchaRef = React.useRef<AltchaFieldHandle>(null);
  const { required, optional } = splitByAcceptance(docs ?? []);

  React.useEffect(() => {
    api()
      .legal.current()
      .then(setDocs)
      // Unknown: keep the box (the API decides what is required and says so on submit).
      .catch(() => {});
  }, []);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!altcha || pending) return;
    const form = new FormData(e.currentTarget);
    const email = field(form, "email").trim();
    setPending(true);
    setError(null);
    try {
      // Only documents that require acceptance are accepted; the others are linked for reading.
      // If the list never loaded (or is still loading) the box was shown anyway: fetch it now, so
      // a ticked box is not sent as an empty acceptance.
      const accepting = form.get("legal") === "on";
      const requiredIds = accepting
        ? splitByAcceptance(docs ?? (await api().legal.current())).required.map((d) => d.id)
        : [];
      await signUp(
        {
          email,
          username: field(form, "username").trim().toLowerCase(),
          password: field(form, "password"),
          birthDate: field(form, "birthDate"),
          altcha,
          acceptedDocumentIds: requiredIds,
        },
        returnTo,
      );
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
      <PageContainer
        data-testid="signup-check-email"
        width="form"
        className="flex flex-col gap-6 py-12"
        aria-live="polite"
      >
        <PageHeader
          title={t("signup.checkEmailTitle")}
          description={t("signup.checkEmailBody", { email: doneEmail })}
        />
        <ResendVerification email={doneEmail} callbackURL={returnTo} />
      </PageContainer>
    );

  return (
    <PageContainer width="form" className="flex flex-col gap-6 py-12">
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
          <SignUpPasswordField />
          {/* A native date input (shadcn `Input type="date"`), not DateOfBirthField's three Selects:
              the e1 contract fills `signup-birthdate` with one YYYY-MM-DD value, and the browser's
              date picker is accessible and localized on every platform. */}
          <Field>
            <FieldLabel htmlFor="signup-birthdate">{t("field.birthDate")}</FieldLabel>
            <Input id="signup-birthdate" data-testid="signup-birthdate" name="birthDate" type="date" required />
          </Field>
          {/* While the list loads the box is shown (the API requires acceptance whenever any document
              does); it disappears only once it is known that nothing needs accepting. */}
          {(docs === null || required.length > 0) && (
            <Field orientation="horizontal">
              <Checkbox id="signup-legal" data-testid="signup-legal" name="legal" required />
              <FieldContent>
                <FieldLabel htmlFor="signup-legal">{t("signup.legalAccept")}</FieldLabel>
                {required.length > 0 && (
                  <FieldDescription>
                    <LegalDocumentList docs={required} />
                  </FieldDescription>
                )}
              </FieldContent>
            </Field>
          )}
          {optional.length > 0 && (
            <FieldDescription>
              {t("legal.pending.optional")} <LegalDocumentList docs={optional} />
            </FieldDescription>
          )}
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
            <Button
              variant="link"
              nativeButton={false}
              render={<Link to="/signin" search={returnTo === undefined ? {} : { returnTo }} />}
            >
              {t("nav.signIn")}
            </Button>
          </FieldDescription>
        </FieldGroup>
      </form>
    </PageContainer>
  );
}
