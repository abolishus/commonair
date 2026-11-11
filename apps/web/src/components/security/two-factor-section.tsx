// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Security, section 2 (D7.2): two-step sign-in. Off: "Set up" opens the stepper. On: new backup
 * codes and "Turn off", each behind the password. The API keeps no "on since" date, so none is shown.
 */
import { StatusBadge } from "@commonair/ui";
import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@commonair/ui/components/dialog";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { ConfirmDialog } from "@commonair/ui";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { FormError } from "../form-error.tsx";
import { disableTwoFactor, generateBackupCodes } from "./api.ts";
import { securityErrorMessage } from "./errors.ts";
import { BackupCodes, TwoFactorSetup } from "./two-factor-setup.tsx";

export function TwoFactorSection({
  initiallyEnabled,
  username,
}: {
  initiallyEnabled: boolean;
  username: string;
}): React.JSX.Element {
  const [enabled, setEnabled] = React.useState(initiallyEnabled);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [codes, setCodes] = React.useState<string[] | null>(null);

  return (
    <SettingsSection
      title={t("d7Security.twoFactor.title")}
      description={t("d7Security.twoFactor.intro")}
      data-testid="security-2fa"
    >
      <SettingsRow
        data-testid="security-2fa-row"
        data-state={enabled ? "on" : "off"}
        label={
          <span className="inline-flex flex-wrap items-center gap-2">
            {t("d7Security.twoFactor.appLabel")}
            <StatusBadge tone={enabled ? "success" : "neutral"}>
              {enabled ? t("d7Security.twoFactor.on") : t("d7Security.twoFactor.off")}
            </StatusBadge>
          </span>
        }
        hint={enabled ? t("d7Security.twoFactor.onHint") : t("d7Security.twoFactor.offHint")}
      >
        {enabled ? (
          <>
            <PasswordConfirm
              trigger={
                <Button type="button" variant="outline" size="sm" data-testid="security-2fa-regenerate">
                  {t("d7Security.twoFactor.regenerate")}
                </Button>
              }
              title={t("d7Security.twoFactor.regenerateTitle")}
              description={t("d7Security.twoFactor.regenerateBody")}
              confirmLabel={t("d7Security.twoFactor.regenerate")}
              onConfirm={async (password) => setCodes(await generateBackupCodes(password))}
            />
            <PasswordConfirm
              trigger={
                <Button type="button" variant="destructive" size="sm" data-testid="security-2fa-off">
                  {t("d7Security.twoFactor.turnOff")}
                </Button>
              }
              title={t("d7Security.twoFactor.turnOffTitle")}
              description={t("d7Security.twoFactor.turnOffBody")}
              confirmLabel={t("d7Security.twoFactor.turnOff")}
              destructive
              onConfirm={async (password) => {
                await disableTwoFactor(password);
                setEnabled(false);
                toast.success(t("d7Security.twoFactor.turnedOff"));
              }}
            />
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="security-2fa-setup"
            onClick={() => setSetupOpen(true)}
          >
            {t("d7Security.twoFactor.setUp")}
          </Button>
        )}
      </SettingsRow>
      <TwoFactorSetup
        open={setupOpen}
        onOpenChange={setSetupOpen}
        username={username}
        onEnabled={() => {
          setEnabled(true);
          toast.success(t("d7Security.twoFactor.turnedOn"));
        }}
      />
      <Dialog open={codes !== null} onOpenChange={(open) => !open && setCodes(null)}>
        <DialogContent data-testid="security-codes-dialog">
          <DialogHeader>
            <DialogTitle>{t("d7Security.codes.title")}</DialogTitle>
          </DialogHeader>
          {codes && (
            <BackupCodes
              codes={codes}
              username={username}
              doneLabel={t("d7Security.codes.done")}
              doneTestId="security-codes-done"
              onDone={() => setCodes(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

/** A `ConfirmDialog` that asks for the password first; a wrong one keeps it open with the reason. */
function PasswordConfirm({
  trigger,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  trigger: React.ReactElement;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (password: string) => Promise<void>;
}): React.JSX.Element {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();
  return (
    <ConfirmDialog
      trigger={trigger}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      variant={destructive ? "destructive" : "default"}
      confirmDisabled={password.length === 0}
      onOpenChange={() => {
        setPassword("");
        setError(null);
      }}
      onConfirm={async () => {
        setError(null);
        await onConfirm(password);
      }}
      onError={(err) => setError(securityErrorMessage(err))}
    >
      <Field>
        <FieldLabel htmlFor={id}>{t("d7Security.password.current")}</FieldLabel>
        <Input
          id={id}
          data-testid="security-confirm-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </Field>
      {error && <FormError>{error}</FormError>}
    </ConfirmDialog>
  );
}
