// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/settings/account` (overhaul wave 4, D7.2; account-admin.md P2): the profile (display name
 * with an explicit Save, the fixed username, the picture), the email address and its
 * verification, what channels see, and a danger zone that sends deletion to its one home on
 * Privacy & data. Switches save at once; the name waits for Save and shows its error after blur
 * or submit.
 */
import { SECURITY_SETTINGS_PATH } from "@commonair/contracts/auth";
import type { Me } from "@commonair/contracts/dto";
import { MAX_UPLOAD_BYTES } from "@commonair/contracts/shapes";
import { ChannelAvatar, ConfirmDialog, SkeletonText, StatusBadge, formatDateTime, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { DangerZone, SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { FieldError } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import { Link, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { AuthRequestError } from "../../lib/auth.ts";
import { fillNode } from "../../lib/fill.tsx";
import { checkUploadFile, uploadAccept, uploadChannelFile, uploadFailureMessage } from "../safety/upload.ts";
import { accountClient, type AccountClient } from "./account-client.ts";
import { DISPLAY_NAME_MAX, displayNameProblem, maskEmail } from "./account-model.ts";

const MAX_MB = MAX_UPLOAD_BYTES / 1_000_000;

export function AccountSettings({ client: clientProp }: { client?: AccountClient }): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? accountClient());
  const [me, setMe] = React.useState<Me | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    client.me().then(
      (m) => {
        if (!live) return;
        setMe(m);
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, attempt]);

  if (!me && failed)
    return (
      <AlertCallout
        data-testid="account-load-error"
        tone="danger"
        live
        description={t("d7Settings.account.loadFailed")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  if (!me) return <SkeletonText data-testid="account-loading" lines={6} />;
  return (
    <>
      <ProfileSection me={me} client={client} onChange={setMe} />
      <EmailSection me={me} client={client} />
      <VisibilitySection me={me} client={client} onChange={setMe} />
      <DangerZone
        data-testid="account-danger"
        title={t("d7Settings.account.danger.title")}
        description={t("d7Settings.account.danger.body")}
      >
        <div className="px-4 py-4 sm:px-6">
          <Button
            variant="destructive"
            size="sm"
            nativeButton={false}
            render={<Link data-testid="account-delete-link" to="/settings/privacy" hash="delete-account" />}
          >
            {t("d7Settings.account.danger.link")}
          </Button>
        </div>
      </DangerZone>
    </>
  );
}

function ProfileSection({
  me,
  client,
  onChange,
}: {
  me: Me;
  client: AccountClient;
  onChange: (me: Me) => void;
}): React.JSX.Element {
  const router = useRouter();
  const nameId = React.useId();
  const errorId = React.useId();
  const [name, setName] = React.useState(me.displayName);
  const [shown, setShown] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const problem = displayNameProblem(name);
  const unchanged = name.trim() === me.displayName;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setShown(true);
    if (problem || unchanged || saving) return;
    setSaving(true);
    try {
      const next = await client.update({ displayName: name.trim() });
      onChange(next);
      setName(next.displayName);
      setShown(false);
      toast.success(t("d7Settings.saved"));
      // The header and the account menu read the name from the root loader.
      void router.invalidate();
    } catch (err) {
      toastActionError(err, t("d7Settings.account.name.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      data-testid="account-profile"
      title={t("d7Settings.account.profile.title")}
      description={t("d7Settings.account.profile.intro")}
    >
      <SettingsRow
        label={t("d7Settings.account.name.label")}
        hint={t("d7Settings.account.name.hint", { max: DISPLAY_NAME_MAX })}
        controlId={nameId}
      >
        <form noValidate onSubmit={(e) => void save(e)} className="flex w-full flex-col gap-2 sm:w-80">
          <div className="flex gap-2">
            <Input
              id={nameId}
              data-testid="account-display-name"
              value={name}
              maxLength={DISPLAY_NAME_MAX}
              autoComplete="nickname"
              aria-invalid={shown && problem !== null ? true : undefined}
              aria-describedby={shown && problem ? errorId : undefined}
              onChange={(e) => setName(e.currentTarget.value)}
              onBlur={() => setShown(true)}
            />
            <Button
              type="submit"
              variant="outline"
              data-testid="account-display-name-save"
              disabled={saving || unchanged}
              aria-busy={saving || undefined}
            >
              {t("d7Settings.save")}
            </Button>
          </div>
          {shown && problem ? (
            <FieldError id={errorId} data-testid="account-display-name-error">
              {problem === "empty"
                ? t("d7Settings.account.name.empty")
                : t("d7Settings.account.name.tooLong", { max: DISPLAY_NAME_MAX })}
            </FieldError>
          ) : null}
        </form>
      </SettingsRow>
      <SettingsRow label={t("d7Settings.account.username.label")} hint={t("d7Settings.account.username.hint")}>
        <span data-testid="account-username" className="font-medium tabular-nums">
          @{me.username}
        </span>
      </SettingsRow>
      <AvatarRow me={me} client={client} onChange={onChange} />
    </SettingsSection>
  );
}

function AvatarRow({
  me,
  client,
  onChange,
}: {
  me: Me;
  client: AccountClient;
  onChange: (me: Me) => void;
}): React.JSX.Element {
  const router = useRouter();
  const input = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const channel = me.channelSlug;

  const apply = async (key: string | null, done: string) => {
    await client.setImage(key);
    onChange(await client.me());
    toast.success(done);
    void router.invalidate();
  };

  const onFile = async (file: File) => {
    if (!channel || busy) return;
    setError(null);
    const checked = checkUploadFile("avatar", file);
    if (!checked.ok) {
      setError(
        checked.reason === "type"
          ? t("appearance.wrongType")
          : checked.reason === "size"
            ? t("d7Settings.account.avatar.tooLarge", { mb: MAX_MB })
            : t("appearance.empty"),
      );
      return;
    }
    setBusy(true);
    try {
      const result = await uploadChannelFile(client.upload, {
        channel,
        purpose: "avatar",
        file,
        contentType: checked.contentType,
      });
      if (!result.ok) {
        setError(uploadFailureMessage(result.reason));
        return;
      }
      await apply(result.key, t("d7Settings.account.avatar.saved"));
    } catch (err) {
      setError(
        err instanceof AuthRequestError && err.code === "INVALID_IMAGE"
          ? uploadFailureMessage("rejected")
          : t("d7Settings.account.avatar.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await apply(null, t("d7Settings.account.avatar.removed"));
    } catch {
      setError(t("d7Settings.account.avatar.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      data-testid="account-avatar"
      label={t("d7Settings.account.avatar.label")}
      hint={channel ? t("d7Settings.account.avatar.hint", { mb: MAX_MB }) : t("d7Settings.account.avatar.noChannel")}
    >
      <ChannelAvatar name={me.displayName} src={me.avatarUrl} size="lg" decorative />
      {channel ? (
        <>
          {/* The native picker stays in the DOM, out of sight; the button opens it. */}
          <Input
            ref={input}
            id={inputId}
            data-testid="account-avatar-file"
            type="file"
            accept={uploadAccept("avatar")}
            className="sr-only"
            tabIndex={-1}
            aria-label={t("d7Settings.account.avatar.change")}
            disabled={busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void onFile(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="account-avatar-change"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => input.current?.click()}
          >
            {busy ? t("appearance.uploading") : t("d7Settings.account.avatar.change")}
          </Button>
          {me.avatarUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="account-avatar-remove"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("d7Settings.account.avatar.remove")}
            </Button>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p data-testid="account-avatar-error" role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}

function EmailSection({ me, client }: { me: Me; client: AccountClient }): React.JSX.Element {
  const [sending, setSending] = React.useState(false);
  const resend = async () => {
    setSending(true);
    try {
      await client.resendVerification(me.email);
      toast.success(t("d7Settings.account.email.sent"));
    } catch (err) {
      if (errorCode(err) === "RATE_LIMITED" || (err instanceof AuthRequestError && err.status === 429))
        toast.error(t("d7Settings.account.email.rateLimited"));
      else toastActionError(err, t("d7Settings.account.email.failed"));
    } finally {
      setSending(false);
    }
  };
  return (
    <SettingsSection
      data-testid="account-email"
      title={t("d7Settings.account.email.title")}
      description={t("d7Settings.account.email.intro")}
    >
      <SettingsRow
        label={
          <span className="flex flex-wrap items-center gap-2">
            <span data-testid="account-email-address" className="break-all">
              {maskEmail(me.email)}
            </span>
            <StatusBadge
              data-testid="account-email-status"
              data-verified={String(me.emailVerified)}
              tone={me.emailVerified ? "success" : "warning"}
            >
              {me.emailVerified ? t("d7Settings.account.email.verified") : t("d7Settings.account.email.unverified")}
            </StatusBadge>
          </span>
        }
        hint={t("d7Settings.account.email.masked")}
      >
        {me.emailVerified ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="account-email-resend"
            disabled={sending}
            aria-busy={sending || undefined}
            onClick={() => void resend()}
          >
            {t("d7Settings.account.email.resend")}
          </Button>
        )}
        {/* Changing the address is a security step, built on /settings/security. */}
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<a data-testid="account-email-change" href={`${SECURITY_SETTINGS_PATH}#email`} aria-label={t("d7Settings.account.email.change")} />}
        >
          {t("d7Settings.account.email.change")}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}

function VisibilitySection({
  me,
  client,
  onChange,
}: {
  me: Me;
  client: AccountClient;
  onChange: (me: Me) => void;
}): React.JSX.Element {
  const { locale, timeZone } = useLocale();
  const shareId = React.useId();
  const [saving, setSaving] = React.useState(false);
  const share = async (on: boolean) => {
    setSaving(true);
    // Shown at once; put back if the save fails.
    onChange({ ...me, shareEmailWithFollowedChannels: on });
    try {
      onChange(await client.update({ shareEmailWithFollowedChannels: on }));
      toast.success(t("d7Settings.saved"));
    } catch (err) {
      onChange({ ...me, shareEmailWithFollowedChannels: !on });
      toastActionError(err, t("d7Settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const withdraw = async () => {
    onChange(await client.update({ matureConfirmed: false }));
    toast.success(t("d7Settings.account.mature.withdrawn"));
  };
  const confirmedAt = me.matureConfirmedAt ? new Date(me.matureConfirmedAt) : null;
  return (
    <SettingsSection
      data-testid="account-visibility"
      title={t("d7Settings.account.visibility.title")}
      description={t("d7Settings.account.visibility.intro")}
    >
      <SettingsRow
        label={t("d7Settings.account.shareEmail.label")}
        hint={t("d7Settings.account.shareEmail.hint")}
        controlId={shareId}
      >
        <Switch
          id={shareId}
          data-testid="account-share-email"
          checked={me.shareEmailWithFollowedChannels}
          disabled={saving}
          onCheckedChange={(on) => void share(on)}
        />
      </SettingsRow>
      <SettingsRow
        data-testid="account-mature"
        data-confirmed={String(me.matureConfirmed)}
        label={t("d7Settings.account.mature.label")}
        hint={
          me.matureConfirmed && confirmedAt && !Number.isNaN(confirmedAt.getTime())
            ? fillNode(
                t("d7Settings.account.mature.confirmedOn"),
                "date",
                <time dateTime={confirmedAt.toISOString()}>{formatDateTime(confirmedAt, locale, timeZone)}</time>,
              )
            : me.matureConfirmed
              ? t("d7Settings.account.mature.confirmed")
              : t("d7Settings.account.mature.notConfirmed")
        }
      >
        {me.matureConfirmed ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline" size="sm" data-testid="account-mature-withdraw">
                {t("d7Settings.account.mature.withdraw")}
              </Button>
            }
            title={t("d7Settings.account.mature.confirmTitle")}
            description={t("d7Settings.account.mature.confirmBody")}
            confirmLabel={t("d7Settings.account.mature.withdraw")}
            onConfirm={withdraw}
            onError={(err) => toastActionError(err, t("d7Settings.saveFailed"))}
            contentProps={{ "data-testid": "account-mature-dialog" }}
          />
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
