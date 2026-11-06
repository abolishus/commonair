// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's live DVR settings on the stream manager (`/dashboard`; ADR 0016,
 * docs/testing/w2-selectors.md "Live DVR"): on/off and how far back viewers may rewind, up to the
 * instance cap (`DVR_MAX_WINDOW_SECONDS`, from `channels.mediaSettings`). DVR reads the VOD
 * recording, so it needs VODs; it is source quality only and served by this instance's origin.
 */
import { DVR_RULES } from "@commonair/contracts/enums";
import { formatUnit, SkeletonText, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { FormError } from "./form-error.tsx";

/** What the section reads of `channels.mediaSettings`. */
export interface DvrMediaSettings {
  dvr: { enabled: boolean; windowSeconds: number };
  dvrMaxWindowSeconds: number;
}

export interface DvrSettingsClient {
  get(channel: string): Promise<DvrMediaSettings>;
  update(channel: string, dvr: { enabled: boolean; windowSeconds: number }): Promise<DvrMediaSettings>;
}

export const dvrSettingsClient = (): DvrSettingsClient => ({
  get: (channel) => api().channels.mediaSettings({ channel }),
  update: (channel, dvr) => api().channels.updateMediaSettings({ channel, dvr }),
});

/** The windows offered, in seconds (5 min to the 2 h default cap). */
export const DVR_WINDOW_PRESETS = [300, 600, 900, 1800, 3600, 7200] as const;

/**
 * The windows to offer: the presets up to the instance cap, the cap itself when it is not one,
 * and the saved value (always clamped by the server) so the trigger can show it.
 */
export function dvrWindowOptions(capSeconds: number, current: number): number[] {
  if (capSeconds < DVR_RULES.minWindowSeconds) return [];
  const out = new Set<number>(DVR_WINDOW_PRESETS.filter((s) => s <= capSeconds));
  out.add(Math.min(capSeconds, DVR_RULES.maxWindowSeconds));
  if (current >= DVR_RULES.minWindowSeconds && current <= capSeconds) out.add(current);
  return [...out].sort((a, b) => a - b);
}

/** "30 minutes", "2 hours", "90 seconds", in the viewer's language. */
export function dvrWindowLabel(seconds: number, locale: string): string {
  const long = { unitDisplay: "long" as const, maximumFractionDigits: 0 };
  if (seconds % 3600 === 0) return formatUnit(seconds / 3600, "hour", locale, long);
  if (seconds % 60 === 0) return formatUnit(seconds / 60, "minute", locale, long);
  return formatUnit(seconds, "second", locale, long);
}

export function DvrSettings({
  channel,
  client: clientProp,
}: {
  channel: string;
  /** Tests pass a fake; the API otherwise. */
  client?: DvrSettingsClient;
}): React.JSX.Element {
  const client = React.useMemo(() => clientProp ?? dvrSettingsClient(), [clientProp]);
  const { locale } = useLocale();
  const [saved, setSaved] = React.useState<DvrMediaSettings | null>(null);
  const [draft, setDraft] = React.useState<{ enabled: boolean; windowSeconds: number } | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const switchId = React.useId();
  const windowId = React.useId();

  React.useEffect(() => {
    let cancelled = false;
    client
      .get(channel)
      .then((s) => {
        if (cancelled) return;
        setSaved(s);
        setDraft(s.dvr);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, channel]);

  const cap = saved?.dvrMaxWindowSeconds ?? 0;
  const instanceOff = saved !== null && cap < DVR_RULES.minWindowSeconds;
  const options = draft ? dvrWindowOptions(cap, draft.windowSeconds) : [];
  const items = Object.fromEntries(options.map((s) => [String(s), dvrWindowLabel(s, locale)]));
  const dirty =
    saved !== null &&
    draft !== null &&
    (draft.enabled !== saved.dvr.enabled || draft.windowSeconds !== saved.dvr.windowSeconds);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const next = await client.update(channel, draft);
      setSaved(next);
      setDraft(next.dvr);
      toast.success(t("dvr.settings.saved"));
    } catch (err) {
      toastActionError(err, t("dvr.settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="dvr-settings">
      <CardHeader>
        <CardTitle>{t("dvr.settings.title")}</CardTitle>
        <CardDescription>{t("dvr.settings.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <FormError>{t("dvr.settings.loadFailed")}</FormError>
        ) : !draft ? (
          <SkeletonText lines={3} />
        ) : (
          <FieldGroup>
            {instanceOff && <FieldDescription>{t("dvr.settings.instanceOff")}</FieldDescription>}
            <Field orientation="horizontal">
              <Switch
                id={switchId}
                data-testid="dvr-enabled"
                data-state={draft.enabled ? "on" : "off"}
                checked={draft.enabled}
                disabled={instanceOff || saving}
                onCheckedChange={(on: boolean) => setDraft({ ...draft, enabled: on })}
              />
              <FieldLabel htmlFor={switchId}>{t("dvr.settings.enabled")}</FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor={windowId}>{t("dvr.settings.window")}</FieldLabel>
              <Select<string>
                value={String(draft.windowSeconds)}
                items={items}
                disabled={instanceOff || !draft.enabled || saving}
                onValueChange={(v) => {
                  const seconds = Number(v);
                  if (Number.isInteger(seconds) && seconds > 0) setDraft({ ...draft, windowSeconds: seconds });
                }}
              >
                <SelectTrigger
                  id={windowId}
                  data-testid="dvr-window"
                  data-value={String(draft.windowSeconds)}
                  className="w-48"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((s) => (
                    <SelectItem key={s} data-testid={`dvr-window-${s}`} value={String(s)}>
                      {items[String(s)]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!instanceOff && (
                <FieldDescription>
                  {t("dvr.settings.windowHint", { max: dvrWindowLabel(cap, locale) })}
                </FieldDescription>
              )}
            </Field>
            {/* Notes take the field hints' size, not a larger body size (F35). */}
            <FieldDescription data-testid="dvr-needs-vods">{t("dvr.settings.needsVods")}</FieldDescription>
            <FieldDescription>{t("dvr.settings.sourceOnly")}</FieldDescription>
            <FieldDescription>{t("dvr.settings.originOnly")}</FieldDescription>
          </FieldGroup>
        )}
      </CardContent>
      {draft && !loadError && (
        <CardFooter>
          <Button data-testid="dvr-save" disabled={!dirty || saving || instanceOff} onClick={() => void save()}>
            {t("dvr.settings.save")}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
