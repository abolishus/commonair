// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's ActivityPub federation section on the stream manager (`/dashboard`; ADR 0030,
 * docs/testing/b7-selectors.md "Federation"): the on/off switch (off asks first), the
 * `@slug@domain` handle with a copy button, the plain-language notes on what federation does and
 * does not do, and the remote followers. Hidden while `instance.info().features.federation` is
 * false (and while the API says the instance does not federate).
 */
import { ConfirmDialog, IconButton, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { FormError } from "../form-error.tsx";
import { federationClient, type FederationClient, type FederationSettingsDto } from "./client.ts";
import { FederationFollowers } from "./followers.tsx";

export interface FederationSettingsProps {
  /** The streamer's channel slug (`federation.settings.get` / `update`). */
  channel: string;
  /** Tests pass a fake; the API otherwise. */
  client?: FederationClient;
}

/** The `/dashboard` mount: nothing at all unless the instance federates. */
export function FederationSettings({ channel, client }: FederationSettingsProps): React.JSX.Element | null {
  const { instance } = useBootstrap();
  if (instance.federation !== true) return null;
  return <FederationSettingsSection channel={channel} client={client} />;
}

export function FederationSettingsSection({
  channel,
  client: clientProp,
}: FederationSettingsProps): React.JSX.Element | null {
  const client = React.useMemo(() => clientProp ?? federationClient(), [clientProp]);
  const [settings, setSettings] = React.useState<FederationSettingsDto | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmOff, setConfirmOff] = React.useState(false);
  const switchId = React.useId();

  React.useEffect(() => {
    let cancelled = false;
    client
      .get(channel)
      .then((s) => !cancelled && setSettings(s))
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
  }, [client, channel]);

  // The bootstrap's instance info is cached; the API's answer is the fresher word.
  if (settings !== null && !settings.instanceEnabled) return null;

  const save = async (enabled: boolean) => {
    const next = await client.update(channel, enabled);
    setSettings(next);
    toast.success(next.enabled ? t("federation.settings.turnedOn") : t("federation.settings.turnedOff"));
  };

  const turnOn = async () => {
    setSaving(true);
    try {
      await save(true);
    } catch (err) {
      toastActionError(err, t("federation.settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const onToggle = (on: boolean) => {
    if (saving) return;
    if (on) void turnOn();
    else setConfirmOff(true);
  };

  return (
    <Card data-testid="federation-settings">
      <CardHeader>
        <CardTitle>{t("federation.settings.title")}</CardTitle>
        <CardDescription>{t("federation.settings.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        {loadFailed ? (
          <FormError>{t("federation.settings.loadFailed")}</FormError>
        ) : settings === null ? (
          <SkeletonGroup label={t("federation.settings.loading")}>
            <SkeletonText lines={4} />
          </SkeletonGroup>
        ) : (
          <>
            <Field orientation="horizontal">
              <Switch
                id={switchId}
                data-testid="federation-enabled"
                data-state={settings.enabled ? "on" : "off"}
                checked={settings.enabled}
                disabled={saving}
                onCheckedChange={onToggle}
              />
              <FieldLabel htmlFor={switchId}>{t("federation.settings.enabled")}</FieldLabel>
            </Field>
            {settings.handle !== null && settings.enabled && <HandleRow handle={settings.handle} />}
            <FederationNotes />
            {(settings.enabled || settings.followers > 0) && (
              <FederationFollowers
                channel={channel}
                client={client}
                handle={settings.enabled ? settings.handle : null}
                onRemoved={() => setSettings((s) => (s ? { ...s, followers: Math.max(0, s.followers - 1) } : s))}
              />
            )}
          </>
        )}
        <ConfirmDialog
          open={confirmOff}
          onOpenChange={setConfirmOff}
          title={t("federation.settings.offTitle")}
          description={t("federation.settings.offBody")}
          confirmLabel={t("federation.settings.offConfirm")}
          variant="destructive"
          contentProps={{ "data-testid": "federation-off-confirm" }}
          onConfirm={() => save(false)}
          onError={(err) => toastActionError(err, t("federation.settings.saveFailed"))}
        />
      </CardContent>
    </Card>
  );
}

function HandleRow({ handle }: { handle: string }): React.JSX.Element {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(handle);
      toast.success(t("federation.settings.handleCopied"));
    } catch {
      toast.error(t("federation.settings.handleCopyFailed"));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-medium">{t("federation.settings.handleLabel")}</span>
      <div className="flex min-w-0 items-center gap-2">
        <code
          data-testid="federation-handle"
          data-handle={handle}
          className="min-w-0 break-all rounded-md bg-muted px-2 py-1 font-mono text-sm"
        >
          {handle}
        </code>
        <IconButton
          type="button"
          data-testid="federation-handle-copy"
          icon={Copy01Icon}
          label={t("federation.settings.handleCopy")}
          onClick={() => void copy()}
        />
      </div>
      <FieldDescription>{t("federation.settings.handleHint")}</FieldDescription>
    </div>
  );
}

/** What federation does and does not do, in plain words (the brief's five notes). */
function FederationNotes(): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="text-sm font-medium">
        {t("federation.notes.title")}
      </h3>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-sm/relaxed text-muted-foreground">
        <li data-testid="federation-note-posted">{t("federation.notes.posted")}</li>
        <li data-testid="federation-note-mature">{t("federation.notes.mature")}</li>
        <li data-testid="federation-note-replies">{t("federation.notes.replies")}</li>
        <li data-testid="federation-note-delete">{t("federation.notes.delete")}</li>
        <li data-testid="federation-note-refollow">{t("federation.notes.refollow")}</li>
      </ul>
    </section>
  );
}
