// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SITE } from "@commonair/config/site";
import { ChannelAvatar, useLocale, useRequestNow } from "@commonair/ui";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { AltchaField, type AltchaFieldHandle } from "../../components/altcha-field.tsx";
import { CHANNEL_INTENTS, intentLanding } from "../../components/auth-gate/intents.ts";
import { savePendingIntent } from "../../components/auth-gate/pending-intent.ts";
import {
  joinTermsOf,
  signupAfterNote,
  signupPerks,
  signupTitle,
  type JoinTerms,
} from "../../components/auth-gate/signup-copy.ts";
import {
  useUsernameCheck,
  type UsernameCheck,
  type UsernameReason,
} from "../../components/auth-gate/username-check.ts";
import { AuthLayout } from "../../components/auth-layout.tsx";
import { BirthDateField } from "../../components/birth-date-field.tsx";
import { FormError } from "../../components/form-error.tsx";
import { LegalDocumentList, splitByAcceptance, type LegalDoc } from "../../components/legal-document-link.tsx";
import { SignUpPasswordField } from "../../components/password-fields.tsx";
import { ResendVerification } from "../../components/resend-verification.tsx";
import { t, type MessageKey } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { AuthRequestError, signUp } from "../../lib/auth.ts";
import { authSearch, authTarget, carriedSearch } from "../../lib/auth-return.ts";
import { EMPTY_DATE, partsFromIso, validateBirthDate, type DateParts } from "../../lib/birth-date.ts";
import { authErrorMessage } from "../../lib/form-errors.ts";
import { field } from "../../lib/form.ts";
import { titleHead } from "../../lib/page-title.ts";
import { trackUi, type UiStep } from "../../lib/ui-metrics.ts";

export const Route = createFileRoute("/_app/signup")({
  head: () => titleHead(t("pageTitle.signup")),
  // `?redirect=` / `?returnTo=`: the verification link lands there (the page the visitor came
  // from, or an OAuth consent page). Same-origin paths only. `?intent=`, `?channel=` and
  // `?username=` (README D2.2) shape the headline and pre-fill the name.
  validateSearch: authSearch,
  component: SignUpPage,
});

const BIRTH_DATE_ERRORS = {
  required: "polish.birthDate.required",
  invalid: "polish.birthDate.invalid",
  future: "polish.birthDate.future",
} as const;

/** The counter's step for a refused sign-up (closed list; no message text). */
function errorStep(err: unknown): UiStep {
  if (err instanceof AuthRequestError) {
    if (err.status === 429) return "rate_limited";
    if (err.code === "USERNAME_IS_ALREADY_TAKEN") return "username_taken";
    if (err.code === "USER_ALREADY_EXISTS" || err.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
      return "email_taken";
  }
  return "invalid";
}

const USERNAME_REASONS: Record<UsernameReason, MessageKey> = {
  taken: "d2Gate.username.taken",
  reserved: "d2Gate.username.reserved",
  invalid: "d2Gate.username.invalid",
};

function UsernameStatus({ check }: { check: UsernameCheck }): React.JSX.Element {
  let text: string | null = null;
  if (check.state === "checking") text = t("d2Gate.username.checking", { username: check.username });
  else if (check.state === "free") text = t("d2Gate.username.free", { username: check.username });
  else if (check.state === "unavailable") text = t(USERNAME_REASONS[check.reason], { username: check.username });
  return (
    // Always mounted, so screen readers announce the answer when it arrives.
    <output
      data-testid="signup-username-check"
      data-state={check.state}
      data-reason={check.state === "unavailable" ? check.reason : undefined}
      className={
        check.state === "unavailable" ? "block text-sm text-destructive" : "block text-sm text-muted-foreground"
      }
    >
      {text}
    </output>
  );
}

function SignUpPage(): React.JSX.Element {
  // From the location, not the route match: the page also renders outside it (tests). Re-checked.
  const search = authSearch(useLocation().search as Record<string, unknown>);
  const intent = search.intent;
  const channel = search.channel;
  // The creator intents land on their own pages when nothing else asked for a target.
  const target = authTarget(search) ?? intentLanding(intent);
  const carried = carriedSearch(search);
  const requestNow = useRequestNow();
  const [now] = React.useState(() => new Date(requestNow ?? Date.now()));
  const [docs, setDocs] = React.useState<LegalDoc[] | null>(null);
  const [altcha, setAltcha] = React.useState<string | null>(null);
  const [birth, setBirth] = React.useState<DateParts>(EMPTY_DATE);
  const [birthError, setBirthError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [doneEmail, setDoneEmail] = React.useState<string | null>(null);
  const altchaRef = React.useRef<AltchaFieldHandle>(null);
  const username = useUsernameCheck();
  const { locale } = useLocale();
  const [joinTerms, setJoinTerms] = React.useState<JoinTerms | null>(null);
  const { required, optional } = splitByAcceptance(docs ?? []);
  const title = signupTitle(intent, channel);
  const after = signupAfterNote(intent, channel, target);
  const creatorIntent = intent === "stream" || intent === "import";

  React.useEffect(() => {
    api()
      .legal.current()
      .then(setDocs)
      // Unknown: keep the box (the API decides what is required and says so on submit).
      .catch(() => {});
  }, []);
  React.useEffect(() => trackUi("signup", "view", intent ?? "none"), [intent]);
  // The join perk states the governed share and minimum sub, never a figure baked into the copy.
  React.useEffect(() => {
    if (intent !== "join") return;
    let live = true;
    api()
      .coop.settings()
      .then((settings) => {
        if (live) setJoinTerms(joinTermsOf(settings));
      })
      // Unknown: the perk names no figure.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [intent]);
  // A name claimed on /creators: say at once whether it is still free.
  const { run } = username;
  React.useEffect(() => {
    if (search.username) run(search.username);
  }, [search.username, run]);

  const onBirthChange = (next: DateParts) => {
    setBirth(next);
    // Clear a shown error as soon as the date is fine; keep it while it is still wrong.
    if (birthError) {
      const checked = validateBirthDate(next, now);
      setBirthError("error" in checked ? t(BIRTH_DATE_ERRORS[checked.error]) : null);
    }
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!altcha || pending) return;
    const form = new FormData(e.currentTarget);
    const checked = validateBirthDate(partsFromIso(field(form, "birthDate")), now);
    if ("error" in checked) {
      setBirthError(t(BIRTH_DATE_ERRORS[checked.error]));
      e.currentTarget.querySelector<HTMLElement>('[data-testid^="signup-birthdate-"]')?.focus();
      return;
    }
    const email = field(form, "email").trim();
    setPending(true);
    setError(null);
    trackUi("signup", "submit", intent ?? "none");
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
          birthDate: checked.iso,
          altcha,
          acceptedDocumentIds: requiredIds,
          signupIntent: intent,
        },
        target,
      );
      // Back on that page after verifying, they get a one-tap confirm (never an automatic action).
      savePendingIntent({ intent, target, channel });
      setDoneEmail(email);
    } catch (err) {
      trackUi("signup", "error", errorStep(err));
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
        {after ? <p className="text-sm text-muted-foreground">{after}</p> : null}
        <ResendVerification email={doneEmail} callbackURL={target} />
        <div>
          <Button
            data-testid="signup-wrong-address"
            type="button"
            variant="outline"
            onClick={() => {
              setDoneEmail(null);
              // The sign-up spent the proof: keep submit disabled until the remounted widget solves anew.
              setAltcha(null);
              username.reset();
            }}
          >
            {t("d2Gate.signup.wrongAddress")}
          </Button>
        </div>
      </PageContainer>
    );

  return (
    <AuthLayout data-testid="signup-page" title={title} description={t("d2Gate.signup.free", { site: SITE.name })}>
      {channel && intent && CHANNEL_INTENTS.has(intent) ? (
        <Link
          data-testid="signup-context"
          to="/$channel"
          params={{ channel }}
          className="flex items-center gap-3 border border-border p-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChannelAvatar name={channel} size="sm" decorative />
          <span className="flex min-w-0 flex-col">
            <span className="text-xs text-muted-foreground">{t("d2Gate.signup.watching")}</span>
            <span className="truncate text-sm font-medium">{channel}</span>
          </span>
        </Link>
      ) : null}
      <section aria-label={t("d2Gate.signup.perks")}>
        <ul data-testid="signup-perks" className="flex flex-col gap-2 text-sm">
          {signupPerks(intent, joinTerms, locale).map(({ key, values }) => (
            <li key={key} className="flex items-start gap-2">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                strokeWidth={2}
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-success"
              />
              <span>{t(key, values)}</span>
            </li>
          ))}
        </ul>
      </section>
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
              defaultValue={search.username}
              aria-describedby="signup-username-hint signup-username-check"
              aria-invalid={username.check.state === "unavailable" || undefined}
              onBlur={(e) => username.run(e.currentTarget.value)}
            />
            <FieldDescription id="signup-username-hint">
              {creatorIntent ? t("d2Gate.signup.usernameHintChannel") : t("signup.usernameHint")}
            </FieldDescription>
            <span id="signup-username-check">
              <UsernameStatus check={username.check} />
            </span>
          </Field>
          <SignUpPasswordField />
          <BirthDateField value={birth} onValueChange={onBirthChange} error={birthError} now={now} />
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
            data-filled-cta=""
            type="submit"
            variant="brand"
            size="lg"
            disabled={!altcha || pending}
            aria-busy={pending || undefined}
          >
            {t("signup.submit")}
          </Button>
          {after ? <FieldDescription data-testid="signup-after">{after}</FieldDescription> : null}
          <FieldDescription>
            {t("signup.haveAccount")}{" "}
            <Button variant="link" nativeButton={false} render={<Link to="/signin" search={carried} />}>
              {t("nav.signIn")}
            </Button>
          </FieldDescription>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
