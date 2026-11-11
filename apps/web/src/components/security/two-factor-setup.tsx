// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Setting up two-step sign-in (D7.2, account-admin.md P3), one Dialog in four steps: the password
 * again → the QR code (drawn here) and the key to type by hand → a 6-digit code from the app → the
 * 10 backup codes, with Download .txt and "I saved these". The account is protected only once the
 * code checks out; from there the dialog closes only through "I saved these".
 */
import { SITE } from "@commonair/config/site";
import { CopyField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { field } from "../../lib/form.ts";
import { verifyTotp } from "../../lib/auth.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { FormError } from "../form-error.tsx";
import { enableTwoFactor, type TotpEnrollment } from "./api.ts";
import { securityErrorMessage } from "./errors.ts";
import { QrCode } from "./qr-code.tsx";
import {
  SETUP_STEPS,
  backupCodesFile,
  downloadText,
  groupKey,
  isTotpCode,
  nextStep,
  normalizeCode,
  previousStep,
  stepNumber,
  totpSecret,
  type SetupStep,
} from "./two-factor.ts";

export interface TwoFactorSetupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The code checked out: two-step sign-in is on (the dialog stays open on the backup codes). */
  onEnabled: () => void;
  username: string;
}

export function TwoFactorSetup({ open, onOpenChange, onEnabled, username }: TwoFactorSetupProps): React.JSX.Element {
  const [step, setStep] = React.useState<SetupStep>("password");
  const [enrollment, setEnrollment] = React.useState<TotpEnrollment | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const ids = { password: React.useId(), code: React.useId() };

  const reset = () => {
    setStep("password");
    setEnrollment(null);
    setError(null);
    setPending(false);
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };
  // The backup codes are the only copy: leaving them takes "I saved these".
  const onDialogOpenChange = (next: boolean) => {
    if (next) onOpenChange(true);
    else if (step !== "codes" && !pending) close();
  };

  const run = async (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(securityErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const submitPassword = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = field(new FormData(e.currentTarget), "password");
    void run(async () => {
      setEnrollment(await enableTwoFactor(password));
      setStep(nextStep("password"));
    });
  };

  const submitCode = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = normalizeCode(field(new FormData(e.currentTarget), "code"));
    if (!isTotpCode(code)) {
      setError(t("d7Security.error.code"));
      return;
    }
    void run(async () => {
      await verifyTotp(code);
      trackUi("settings.security", "submit", "totp");
      onEnabled();
      setStep("codes");
    });
  };

  const secret = enrollment ? totpSecret(enrollment.totpURI) : "";
  const back = previousStep(step);

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent data-testid="security-2fa-dialog" data-step={step} showCloseButton={step !== "codes"}>
        <DialogHeader>
          <DialogTitle>{t("d7Security.setup.title")}</DialogTitle>
          <DialogDescription>
            {t("d7Security.setup.step", { current: String(stepNumber(step)), total: String(SETUP_STEPS.length) })}
          </DialogDescription>
        </DialogHeader>

        {step === "password" && (
          <form onSubmit={submitPassword}>
            <FieldGroup>
              <p className="text-sm text-muted-foreground">{t("d7Security.setup.passwordBody")}</p>
              <Field>
                <FieldLabel htmlFor={ids.password}>{t("d7Security.password.current")}</FieldLabel>
                <Input
                  id={ids.password}
                  data-testid="security-2fa-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              {error && <FormError>{error}</FormError>}
              <DialogFooter>
                <Button
                  type="submit"
                  data-testid="security-2fa-continue"
                  disabled={pending}
                  aria-busy={pending || undefined}
                >
                  {t("d7Security.setup.continue")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}

        {step === "scan" && enrollment && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("d7Security.setup.scanBody")}</p>
            <div className="flex justify-center">
              <QrCode value={enrollment.totpURI} label={t("d7Security.setup.qrLabel")} data-testid="security-2fa-qr" />
            </div>
            <CopyField
              label={t("d7Security.setup.manualLabel")}
              value={groupKey(secret)}
              secret
              showLabel={t("d7Security.setup.reveal")}
              hideLabel={t("d7Security.setup.hide")}
              copyLabel={t("d7Security.setup.copy")}
              copiedLabel={t("d7Security.setup.copied")}
              copyFailedLabel={t("d7Security.setup.copyFailed")}
              data-value-testid="security-2fa-key"
              data-reveal-testid="security-2fa-key-reveal"
            />
            <DialogFooter>
              <Button type="button" data-testid="security-2fa-next" onClick={() => setStep(nextStep("scan"))}>
                {t("d7Security.setup.continue")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "code" && (
          <form onSubmit={submitCode}>
            <FieldGroup>
              <p className="text-sm text-muted-foreground">{t("d7Security.setup.codeBody")}</p>
              <Field>
                <FieldLabel htmlFor={ids.code}>{t("d7Security.setup.codeLabel")}</FieldLabel>
                <Input
                  id={ids.code}
                  data-testid="security-2fa-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={9}
                  required
                />
              </Field>
              {error && <FormError>{error}</FormError>}
              <DialogFooter>
                {back && (
                  <Button type="button" variant="outline" onClick={() => setStep(back)}>
                    {t("d7Security.setup.back")}
                  </Button>
                )}
                <Button
                  type="submit"
                  data-testid="security-2fa-verify"
                  disabled={pending}
                  aria-busy={pending || undefined}
                >
                  {t("d7Security.setup.verify")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}

        {step === "codes" && enrollment && (
          <BackupCodes
            codes={enrollment.backupCodes}
            username={username}
            doneLabel={t("d7Security.setup.saved")}
            doneTestId="security-2fa-saved"
            onDone={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The backup codes, a download and the button that closes their dialog. */
export function BackupCodes({
  codes,
  username,
  doneLabel,
  doneTestId,
  onDone,
}: {
  codes: readonly string[];
  username: string;
  doneLabel: string;
  doneTestId: "security-2fa-saved" | "security-codes-done";
  onDone: () => void;
}): React.JSX.Element {
  const labelId = React.useId();
  const download = () =>
    downloadText(`${SITE.name.toLowerCase()}-backup-codes.txt`, backupCodesFile(codes, SITE.name, username));
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("d7Security.setup.codesBody")}</p>
      <p id={labelId} className="text-sm font-medium">
        {t("d7Security.setup.codesLabel")}
      </p>
      <ul aria-labelledby={labelId} data-testid="security-backup-codes" className="grid grid-cols-2 gap-2 text-sm">
        {codes.map((code) => (
          <li key={code} className="bg-muted px-2 py-1 text-center tabular-nums">
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" variant="outline" data-testid="security-codes-download" onClick={download}>
          {t("d7Security.setup.download")}
        </Button>
        {doneTestId === "security-2fa-saved" ? (
          <Button type="button" data-testid="security-2fa-saved" onClick={onDone}>
            {doneLabel}
          </Button>
        ) : (
          <Button type="button" data-testid="security-codes-done" onClick={onDone}>
            {doneLabel}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
