// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Security, section 1 (D7.2): the email (changed through a confirmation to the current address) and the password. */
import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { field } from "../../lib/form.ts";
import { FormError } from "../form-error.tsx";
import { changeEmail, changePassword } from "./api.ts";
import { securityErrorMessage } from "./errors.ts";

export function AccountSection({ email }: { email: string }): React.JSX.Element {
  return (
    <SettingsSection title={t("d7Security.account.title")} data-testid="security-account">
      <SettingsRow label={t("d7Security.email.label")} hint={t("d7Security.email.hint", { email })}>
        <ChangeEmailDialog email={email} />
      </SettingsRow>
      <SettingsRow label={t("d7Security.password.label")} hint={t("d7Security.password.hint")}>
        <ChangePasswordDialog />
      </SettingsRow>
    </SettingsSection>
  );
}

function ChangePasswordDialog(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [revokeOthers, setRevokeOthers] = React.useState(true);
  const ids = { current: React.useId(), next: React.useId(), revoke: React.useId(), hint: React.useId() };

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    setError(null);
    setRevokeOthers(true);
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await changePassword({
        currentPassword: field(form, "currentPassword"),
        newPassword: field(form, "newPassword"),
        revokeOtherSessions: revokeOthers,
      });
      setPending(false);
      setOpen(false);
      toast.success(t("d7Security.password.done"));
    } catch (err) {
      setError(securityErrorMessage(err));
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="security-password-change"
        onClick={() => setOpen(true)}
      >
        {t("d7Security.password.change")}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="security-password-dialog">
          <DialogHeader>
            <DialogTitle>{t("d7Security.password.dialogTitle")}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => void onSubmit(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={ids.current}>{t("d7Security.password.current")}</FieldLabel>
                <Input
                  id={ids.current}
                  data-testid="security-password-current"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.next}>{t("d7Security.password.new")}</FieldLabel>
                <Input
                  id={ids.next}
                  data-testid="security-password-new"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  aria-describedby={ids.hint}
                  required
                />
                <FieldDescription id={ids.hint}>{t("d7Security.password.newHint")}</FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id={ids.revoke}
                  data-testid="security-password-revoke"
                  checked={revokeOthers}
                  onCheckedChange={(checked) => setRevokeOthers(checked === true)}
                />
                <FieldLabel htmlFor={ids.revoke}>{t("d7Security.password.revokeOthers")}</FieldLabel>
              </Field>
              {error && <FormError>{error}</FormError>}
              <DialogFooter>
                <Button
                  type="submit"
                  data-testid="security-password-submit"
                  disabled={pending}
                  aria-busy={pending || undefined}
                >
                  {t("d7Security.password.change")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ChangeEmailDialog({ email }: { email: string }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const id = React.useId();

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    setError(null);
    setSent(false);
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const newEmail = field(new FormData(e.currentTarget), "newEmail").trim().toLowerCase();
    if (newEmail === email.toLowerCase()) {
      setError(t("d7Security.email.same"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await changeEmail(newEmail);
      setSent(true);
    } catch (err) {
      setError(securityErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="security-email-change"
        onClick={() => setOpen(true)}
      >
        {t("d7Security.email.change")}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="security-email-dialog">
          <DialogHeader>
            <DialogTitle>{t("d7Security.email.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("d7Security.email.dialogBody")}</DialogDescription>
          </DialogHeader>
          {sent ? (
            <p data-testid="security-email-sent" aria-live="polite" className="text-sm">
              {t("d7Security.email.sent", { email })}
            </p>
          ) : (
            <form onSubmit={(e) => void onSubmit(e)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={id}>{t("d7Security.email.newLabel")}</FieldLabel>
                  <Input
                    id={id}
                    data-testid="security-email-new"
                    name="newEmail"
                    type="email"
                    autoComplete="email"
                    required
                  />
                </Field>
                {error && <FormError>{error}</FormError>}
                <DialogFooter>
                  <Button
                    type="submit"
                    data-testid="security-email-submit"
                    disabled={pending}
                    aria-busy={pending || undefined}
                  >
                    {t("d7Security.email.submit")}
                  </Button>
                </DialogFooter>
              </FieldGroup>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
