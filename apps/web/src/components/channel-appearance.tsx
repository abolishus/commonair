// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MAX_UPLOAD_BYTES, type ChannelTheme } from "@commonair/contracts/shapes";
import { ChannelAvatar, SkeletonText, type Accent } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { FormError } from "./form-error.tsx";
import {
  checkUploadFile,
  uploadAccept,
  uploadChannelFile,
  uploadClient,
  uploadFailureMessage,
  type UploadClient,
} from "./safety/upload.ts";

/** What the card needs of a channel (a subset of `channels.get`). */
export interface AppearanceChannel {
  displayName: string;
  theme: ChannelTheme;
  avatarUrl: string | null;
  bannerUrl: string | null;
}

export interface AppearanceClient {
  get(channel: string): Promise<AppearanceChannel>;
  /** `channels.update` replaces the whole theme, so callers send the merged one. */
  updateTheme(channel: string, theme: ChannelTheme): Promise<AppearanceChannel>;
  upload: UploadClient;
}

export const appearanceClient = (): AppearanceClient => ({
  get: (channel) => api().channels.get({ channel }),
  updateTheme: (channel, theme) => api().channels.update({ channel, theme }),
  upload: uploadClient(),
});

type Slot = "avatar" | "banner";

const SLOT: Record<
  Slot,
  {
    themeKey: "avatarKey" | "bannerKey";
    label: () => string;
    hint: () => string;
    upload: () => string;
    remove: () => string;
    saved: () => string;
    removed: () => string;
  }
> = {
  avatar: {
    themeKey: "avatarKey",
    label: () => t("appearance.avatar"),
    hint: () => t("appearance.avatarHint", { mb: MAX_MB }),
    upload: () => t("appearance.uploadAvatar"),
    remove: () => t("appearance.removeAvatar"),
    saved: () => t("appearance.avatarSaved"),
    removed: () => t("appearance.avatarRemoved"),
  },
  banner: {
    themeKey: "bannerKey",
    label: () => t("appearance.banner"),
    hint: () => t("appearance.bannerHint", { mb: MAX_MB }),
    upload: () => t("appearance.uploadBanner"),
    remove: () => t("appearance.removeBanner"),
    saved: () => t("appearance.bannerSaved"),
    removed: () => t("appearance.bannerRemoved"),
  },
};

const MAX_MB = MAX_UPLOAD_BYTES / 1_000_000;

/**
 * The `/dashboard` avatar and banner controls: check the file against the contract's limits,
 * upload it through `uploadChannelFile` (presigned PUT, then the scanning commit), then point
 * `theme.avatarKey`/`bannerKey` at the committed key. One operation runs at a time, so two
 * slots cannot race each other's theme write.
 */
export function ChannelAppearanceCard({
  channel,
  client: clientProp,
}: {
  channel: string;
  /** Tests pass a fake; the API otherwise. */
  client?: AppearanceClient;
}): React.JSX.Element {
  const client = React.useMemo(() => clientProp ?? appearanceClient(), [clientProp]);
  const [data, setData] = React.useState<AppearanceChannel | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [busy, setBusy] = React.useState<Slot | null>(null);
  const [errors, setErrors] = React.useState<Partial<Record<Slot, string>>>({});
  /** A local preview of the file being uploaded, shown until the commit answers. */
  const [pendingPreview, setPendingPreview] = React.useState<{ slot: Slot; url: string } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    client
      .get(channel)
      .then((c) => {
        if (!cancelled) setData(c);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, channel]);

  React.useEffect(() => () => (pendingPreview ? URL.revokeObjectURL(pendingPreview.url) : undefined), [pendingPreview]);

  const setError = (slot: Slot, message: string | undefined) => setErrors((prev) => ({ ...prev, [slot]: message }));

  /**
   * Merge into the theme as the server has it now, not as it was when the card loaded: a
   * takedown or another tab may have changed it, and the update replaces the whole theme.
   */
  const saveTheme = async (
    slot: Slot,
    change: (current: ChannelTheme) => ChannelTheme,
    done: () => string,
  ): Promise<boolean> => {
    try {
      const current = await client.get(channel);
      setData(await client.updateTheme(channel, change(current.theme)));
      toast.success(done());
      return true;
    } catch {
      setError(slot, t("appearance.saveFailed"));
      return false;
    }
  };

  const onFile = async (slot: Slot, file: File) => {
    if (!data || busy) return;
    setError(slot, undefined);
    const checked = checkUploadFile(slot, file);
    if (!checked.ok) {
      setError(
        slot,
        checked.reason === "type"
          ? t("appearance.wrongType")
          : checked.reason === "size"
            ? t("appearance.tooLarge", { mb: MAX_MB })
            : t("appearance.empty"),
      );
      return;
    }
    setBusy(slot);
    setPendingPreview({ slot, url: URL.createObjectURL(file) });
    try {
      const result = await uploadChannelFile(client.upload, {
        channel,
        purpose: slot,
        file,
        contentType: checked.contentType,
      });
      if (!result.ok) {
        setError(slot, uploadFailureMessage(result.reason));
        return;
      }
      await saveTheme(slot, (current) => ({ ...current, [SLOT[slot].themeKey]: result.key }), SLOT[slot].saved);
    } finally {
      setPendingPreview(null);
      setBusy(null);
    }
  };

  const onRemove = async (slot: Slot) => {
    if (!data || busy) return;
    setError(slot, undefined);
    setBusy(slot);
    try {
      await saveTheme(
        slot,
        (current) => {
          const { [SLOT[slot].themeKey]: _removed, ...rest } = current;
          return rest;
        },
        SLOT[slot].removed,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-testid="channel-appearance">
      <CardHeader>
        <CardTitle>{t("appearance.title")}</CardTitle>
        <CardDescription>{t("appearance.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <FormError>{t("appearance.loadFailed")}</FormError>
        ) : !data ? (
          <SkeletonText lines={3} />
        ) : (
          <FieldGroup>
            {(["avatar", "banner"] as const).map((slot) => {
              const preview =
                pendingPreview?.slot === slot
                  ? pendingPreview.url
                  : slot === "avatar"
                    ? data.avatarUrl
                    : data.bannerUrl;
              return (
                <AppearanceSlot
                  key={slot}
                  slot={slot}
                  channelName={data.displayName}
                  accent={(data.theme.accent as Accent | undefined) ?? null}
                  preview={preview}
                  hasKey={Boolean(data.theme[SLOT[slot].themeKey])}
                  busy={busy}
                  error={errors[slot]}
                  onFile={(file) => void onFile(slot, file)}
                  onRemove={() => void onRemove(slot)}
                />
              );
            })}
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
}

function AppearanceSlot({
  slot,
  channelName,
  accent,
  preview,
  hasKey,
  busy,
  error,
  onFile,
  onRemove,
}: {
  slot: Slot;
  channelName: string;
  accent: Accent | null;
  preview: string | null;
  hasKey: boolean;
  busy: Slot | null;
  error: string | undefined;
  onFile: (file: File) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const input = React.useRef<HTMLInputElement>(null);
  const s = SLOT[slot];
  const inputId = `appearance-${slot}-file`;
  const hintId = `appearance-${slot}-hint`;
  return (
    <Field data-testid="appearance-slot" data-purpose={slot} aria-busy={busy === slot || undefined}>
      <FieldLabel htmlFor={inputId}>{s.label()}</FieldLabel>
      {/* `data-src` is what is shown (a local blob while uploading), readable before the image loads. */}
      <div data-testid="appearance-preview" data-src={preview ?? ""}>
        {slot === "avatar" ? (
          <ChannelAvatar name={channelName} src={preview} accent={accent} size="xl" />
        ) : preview ? (
          <AspectRatio ratio={6}>
            <img src={preview} alt={t("appearance.bannerAlt")} className="size-full rounded-md border object-cover" />
          </AspectRatio>
        ) : (
          <AspectRatio
            ratio={6}
            className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
          >
            {t("appearance.noBanner")}
          </AspectRatio>
        )}
      </div>
      <FieldDescription id={hintId}>{s.hint()}</FieldDescription>
      {/* The native picker stays in the DOM (and in the label) but out of sight; the button opens it. */}
      <Input
        ref={input}
        id={inputId}
        data-testid="appearance-file"
        type="file"
        accept={uploadAccept(slot)}
        className="sr-only"
        tabIndex={-1}
        aria-describedby={hintId}
        disabled={busy !== null}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Clear it so picking the same file again still fires a change.
          e.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
      {error && <FormError>{error}</FormError>}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="appearance-upload"
          type="button"
          variant="outline"
          disabled={busy !== null}
          aria-busy={busy === slot || undefined}
          aria-describedby={hintId}
          onClick={() => input.current?.click()}
        >
          {busy === slot ? t("appearance.uploading") : s.upload()}
        </Button>
        {hasKey && (
          <Button
            data-testid="appearance-remove"
            type="button"
            variant="ghost"
            disabled={busy !== null}
            onClick={onRemove}
          >
            {s.remove()}
          </Button>
        )}
      </div>
    </Field>
  );
}
