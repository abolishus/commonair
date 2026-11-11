// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sign-in's second step (D7.2) after the password answered `twoFactorRedirect`: a 6-digit code
 * from the authenticator app, or one of the backup codes. Signed in, it hands back to the sign-in
 * form, which lands the member where wave 2's redirect and intent handling says.
 */
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { field } from "../../lib/form.ts";
import { AuthRequestError, verifyBackupCode, verifyTotp } from "../../lib/auth.ts";
import { AuthLayout } from "../auth-layout.tsx";
import { FormError } from "../form-error.tsx";
import { securityErrorMessage } from "./errors.ts";
import { isTotpCode, normalizeBackupCode, normalizeCode } from "./two-factor.ts";

export type CodeMode = "totp" | "backup";

export interface TwoFactorStepProps {
  /** Called once the code is accepted (the session cookie is set); resolves when navigation starts. */
  onSignedIn: () => Promise<void> | void;
  /** Back to the password (the pending sign-in expired, or the member chose to). */
  onStartOver: (reason?: string) => void;
}

export function TwoFactorStep({ onSignedIn, onStartOver }: TwoFactorStepProps): React.JSX.Element {
  const [mode, setMode] = React.useState<CodeMode>("totp");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const id = React.useId();
  const hintId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => inputRef.current?.focus(), [mode]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const raw = field(new FormData(e.currentTarget), "code");
    const code = mode === "totp" ? normalizeCode(raw) : normalizeBackupCode(raw);
    if (mode === "totp" && !isTotpCode(code)) {
      setError(t("d7Security.error.code"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await (mode === "totp" ? verifyTotp(code) : verifyBackupCode(code));
      // Stays pending until the page goes away.
      await onSignedIn();
    } catch (err) {
      setError(securityErrorMessage(err));
      setPending(false);
      // The pending sign-in is gone (10 minutes passed): only the password again helps.
      if (err instanceof AuthRequestError && err.code === "INVALID_TWO_FACTOR_COOKIE")
        onStartOver(t("d7Security.error.expiredStep"));
    }
  };

  const toggle = () => {
    setMode((m) => (m === "totp" ? "backup" : "totp"));
    setError(null);
  };

  return (
    <AuthLayout title={mode === "totp" ? t("d7Security.signin.codeTitle") : t("d7Security.signin.backupTitle")}>
      <form data-testid="signin-2fa-step" data-mode={mode} onSubmit={(e) => void onSubmit(e)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={id}>
              {mode === "totp" ? t("d7Security.signin.codeLabel") : t("d7Security.signin.backupLabel")}
            </FieldLabel>
            <Input
              // A new input per mode: the browser's one-time-code autofill applies to the app's code only.
              key={mode}
              ref={inputRef}
              id={id}
              data-testid="signin-2fa-code"
              name="code"
              required
              aria-describedby={hintId}
              {...(mode === "totp"
                ? { inputMode: "numeric" as const, autoComplete: "one-time-code", maxLength: 9 }
                : { autoComplete: "off", autoCapitalize: "off", spellCheck: false, maxLength: 64 })}
            />
            <FieldDescription id={hintId}>
              {mode === "totp" ? t("d7Security.signin.codeBody") : t("d7Security.signin.backupBody")}
            </FieldDescription>
          </Field>
          {error && <FormError>{error}</FormError>}
          <Button
            data-testid="signin-2fa-submit"
            type="submit"
            size="lg"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {t("d7Security.signin.verify")}
          </Button>
          <div className="flex flex-wrap justify-between gap-2">
            <Button type="button" variant="link" size="sm" data-testid="signin-2fa-mode" onClick={toggle}>
              {mode === "totp" ? t("d7Security.signin.useBackup") : t("d7Security.signin.useApp")}
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              data-testid="signin-2fa-start-over"
              onClick={() => onStartOver()}
            >
              {t("d7Security.signin.startOver")}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
