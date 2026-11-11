// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Security, section 3 (D7.2): passkeys, each with its name and when it was added (the API keeps
 * no "last used"), renamed or removed per row. "Add a passkey" shows only where the browser can
 * make one (WebAuthn in a secure context).
 */
import { ConfirmDialog, RelativeTime, SkeletonText } from "@commonair/ui";
import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@commonair/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { field } from "../../lib/form.ts";
import { fillNode } from "../../lib/fill.tsx";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import { FormError } from "../form-error.tsx";
import { deletePasskey, listPasskeys, renamePasskey, type PasskeyRow } from "./api.ts";
import { securityErrorMessage } from "./errors.ts";
import { isCancelled, usePasskeysSupported, registerPasskey } from "./webauthn.ts";

const NAME_MAX = 64;

export function PasskeysSection(): React.JSX.Element {
  const loaded = useRetryingLoad("security:passkeys", listPasskeys);
  // Known only in the browser: hidden in the server render, then shown where it works.
  const supported = usePasskeysSupported();
  const [adding, setAdding] = React.useState(false);

  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      await registerPasskey();
      trackUi("settings.security", "submit", "passkey");
      toast.success(t("d7Security.passkeys.added"));
      loaded.reload();
    } catch (err) {
      toast.error(isCancelled(err) ? t("d7Security.passkeys.cancelled") : securityErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const title = t("d7Security.passkeys.title");
  const rows = loaded.data ?? [];
  return (
    <SettingsSection
      title={title}
      description={t("d7Security.passkeys.intro")}
      data-testid="security-passkeys"
      action={
        supported ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="security-passkey-add"
            disabled={adding}
            aria-busy={adding || undefined}
            onClick={() => void add()}
          >
            {t("d7Security.passkeys.add")}
          </Button>
        ) : undefined
      }
    >
      {loaded.state === "loading" && (
        <div className="px-4 py-4 sm:px-6">
          <SkeletonText lines={2} />
        </div>
      )}
      {loaded.state === "failed" && (
        <div className="px-4 py-4 sm:px-6">
          <SectionLoadError section={title} load={loaded} headingLevel={3} />
        </div>
      )}
      {loaded.state === "loaded" && rows.length === 0 && (
        <SettingsRow
          data-testid="security-passkeys-empty"
          label={t("d7Security.passkeys.empty")}
          hint={supported ? undefined : t("d7Security.passkeys.unsupported")}
        />
      )}
      {rows.length > 0 && (
        <ul aria-label={t("d7Security.passkeys.list")} className="divide-y">
          {rows.map((p) => (
            <li key={p.id}>
              <PasskeyItem passkey={p} onChanged={loaded.reload} />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function PasskeyItem({ passkey, onChanged }: { passkey: PasskeyRow; onChanged: () => void }): React.JSX.Element {
  const name = passkey.name?.trim() || t("d7Security.passkeys.unnamed");
  return (
    <SettingsRow
      data-testid="security-passkey-row"
      data-passkey-id={passkey.id}
      label={name}
      hint={fillNode(t("d7Security.passkeys.created"), "time", <RelativeTime date={passkey.createdAt} live={false} />)}
    >
      <RenamePasskey passkey={passkey} current={passkey.name?.trim() ?? ""} onRenamed={onChanged} />
      <ConfirmDialog
        trigger={
          <Button type="button" variant="ghost" size="sm" data-testid="security-passkey-remove">
            {t("d7Security.passkeys.remove")}
          </Button>
        }
        title={t("d7Security.passkeys.removeTitle")}
        description={t("d7Security.passkeys.removeBody", { name })}
        confirmLabel={t("d7Security.passkeys.remove")}
        variant="destructive"
        onConfirm={async () => {
          await deletePasskey(passkey.id);
          toast.success(t("d7Security.passkeys.removed"));
          onChanged();
        }}
        onError={(err) => toast.error(securityErrorMessage(err))}
      />
    </SettingsRow>
  );
}

function RenamePasskey({
  passkey,
  current,
  onRenamed,
}: {
  passkey: PasskeyRow;
  current: string;
  onRenamed: () => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const id = React.useId();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const name = field(new FormData(e.currentTarget), "name").trim();
    if (!name) return;
    setPending(true);
    setError(null);
    try {
      await renamePasskey(passkey.id, name);
      setOpen(false);
      toast.success(t("d7Security.passkeys.renamed"));
      onRenamed();
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
        variant="ghost"
        size="sm"
        data-testid="security-passkey-rename"
        onClick={() => setOpen(true)}
      >
        {t("d7Security.passkeys.rename")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("d7Security.passkeys.renameTitle")}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => void onSubmit(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={id}>{t("d7Security.passkeys.nameLabel")}</FieldLabel>
                <Input id={id} name="name" defaultValue={current} maxLength={NAME_MAX} required />
              </Field>
              {error && <FormError>{error}</FormError>}
              <DialogFooter>
                <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
                  {t("d7Security.passkeys.save")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
