// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A followed channel's go-live alert controls on `/following` (overhaul wave 5, moved from
 * `/settings/notifications`): the bell (`follows.notify`, `notify-channel-bell`) and, while it is
 * on, "Email and push" (`following-alert-options`), the channel's email and push overrides
 * (`notifications.preferences.set` with `channel`). The preferences load once per page, the first
 * time someone opens the options, so the page itself makes no extra request.
 */
import { IconButton, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import { Label } from "@commonair/ui/components/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@commonair/ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { toast } from "@commonair/ui/toast";
import { Notification01Icon, NotificationOff01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import {
  type ChannelMedium,
  type NotificationPreferencesDto,
  type OverrideChoice,
  type SetPreferenceInput,
  applyPreference,
  choiceEnabled,
  copyPreferenceCell,
  isOverrideChoice,
  overrideChoice,
} from "../../lib/notifications.ts";

export interface AlertChannel {
  id: string;
  slug: string;
  displayName: string;
}

/** The go-live preference calls the options make; the page passes the API, tests a fake. */
export interface AlertPreferencesClient {
  preferences(): Promise<NotificationPreferencesDto>;
  setPreference(input: SetPreferenceInput): Promise<NotificationPreferencesDto>;
}

export type AlertPrefsState = "idle" | "loading" | "loaded" | "failed";

export interface AlertPreferences {
  prefs: NotificationPreferencesDto | null;
  state: AlertPrefsState;
  /** Load the preferences if nothing has asked yet, or again after a failure. */
  ensure: () => void;
  change: (channel: AlertChannel, medium: ChannelMedium, choice: OverrideChoice) => Promise<void>;
}

/**
 * The page's one go-live preferences read, and its optimistic changes: each cell keeps its own
 * request order (an older answer never overwrites a newer choice) and rolls back on failure.
 */
export function useAlertPreferences(client: AlertPreferencesClient): AlertPreferences {
  const [prefs, setPrefs] = React.useState<NotificationPreferencesDto | null>(null);
  const [state, setState] = React.useState<AlertPrefsState>("idle");
  const asked = React.useRef(false);
  const prefsRef = React.useRef(prefs);
  React.useLayoutEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  const seq = React.useRef(new Map<string, number>());

  const ensure = React.useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    setState("loading");
    client.preferences().then(
      (loaded) => {
        setPrefs(loaded);
        setState("loaded");
      },
      () => {
        // A later open (or Retry) asks again.
        asked.current = false;
        setState("failed");
      },
    );
  }, [client]);

  const change = React.useCallback(
    async (channel: AlertChannel, medium: ChannelMedium, choice: OverrideChoice) => {
      const before = prefsRef.current;
      if (before === null) return;
      const input: SetPreferenceInput = { medium, channel: channel.slug, enabled: choiceEnabled(choice) };
      const cell = `${channel.slug}:${medium}`;
      const mine = (seq.current.get(cell) ?? 0) + 1;
      seq.current.set(cell, mine);
      setPrefs((p) => (p ? applyPreference(p, input, channel) : p));
      try {
        const answer = await client.setPreference(input);
        if (seq.current.get(cell) === mine) setPrefs((p) => (p ? copyPreferenceCell(p, answer, input) : p));
        toast.success(
          <span data-testid="following-alert-saved">
            {t("w5Watch.alerts.saved", { medium, channel: channel.displayName, choice })}
          </span>,
        );
      } catch (err) {
        if (seq.current.get(cell) === mine) setPrefs((p) => (p ? copyPreferenceCell(p, before, input) : p));
        const message = t("d3Home.followingPage.alertFailed", { channel: channel.displayName });
        if (isSessionExpired(err)) toastActionError(err, message);
        else toast.error(<span data-testid="following-alert-error">{message}</span>);
      }
    },
    [client],
  );

  return { prefs, state, ensure, change };
}

export interface AlertControlsProps {
  channel: AlertChannel;
  notify: boolean;
  /** The bell's save is in flight. */
  busy: boolean;
  onToggle: () => void;
  alerts: AlertPreferences;
}

/** The bell plus, while it is on, the email and push options (`notify-channel`, `data-slug`). */
export function AlertControls({ channel, notify, busy, onToggle, alerts }: AlertControlsProps): React.JSX.Element {
  return (
    <div data-testid="notify-channel" data-slug={channel.slug} className="flex shrink-0 items-center gap-1">
      {notify ? <AlertOptions channel={channel} alerts={alerts} /> : null}
      <IconButton
        data-testid="notify-channel-bell"
        data-state={notify ? "on" : "off"}
        variant={notify ? "secondary" : "ghost"}
        icon={notify ? Notification01Icon : NotificationOff01Icon}
        aria-pressed={notify}
        disabled={busy}
        label={
          notify
            ? t("d3Home.followingPage.alertOn", { channel: channel.displayName })
            : t("d3Home.followingPage.alertOff", { channel: channel.displayName })
        }
        onClick={onToggle}
      />
    </div>
  );
}

function AlertOptions({ channel, alerts }: { channel: AlertChannel; alerts: AlertPreferences }): React.JSX.Element {
  const { prefs, state, ensure, change } = alerts;
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) ensure();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="following-alert-options"
            // WCAG 2.5.3: the name starts with the visible text, then says which channel.
            aria-label={t("w5Watch.alerts.optionsLabel", { channel: channel.displayName })}
          />
        }
      >
        {t("w5Watch.alerts.options")}
      </PopoverTrigger>
      <PopoverContent data-testid="following-alert-popover" align="end" className="flex flex-col gap-3">
        <PopoverHeader>
          <PopoverTitle>{t("w5Watch.alerts.title", { channel: channel.displayName })}</PopoverTitle>
          <PopoverDescription>{t("w5Watch.alerts.intro")}</PopoverDescription>
        </PopoverHeader>
        {prefs ? (
          <div className="flex flex-wrap items-end gap-3">
            <OverrideSelect
              medium="email"
              channel={channel.displayName}
              value={overrideChoice(prefs, channel.slug, "email")}
              defaultOn={prefs.defaults.email}
              onChange={(choice) => void change(channel, "email", choice)}
            />
            <OverrideSelect
              medium="push"
              channel={channel.displayName}
              value={overrideChoice(prefs, channel.slug, "push")}
              defaultOn={prefs.defaults.push}
              onChange={(choice) => void change(channel, "push", choice)}
            />
          </div>
        ) : state === "failed" ? (
          <Alert data-testid="following-alert-load-error" variant="destructive">
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>{t("w5Watch.alerts.loadFailed")}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="following-alert-retry"
                onClick={() => ensure()}
              >
                {t("w5Watch.alerts.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <SkeletonGroup label={t("notifySettings.loading")}>
            <SkeletonText lines={2} />
          </SkeletonGroup>
        )}
      </PopoverContent>
    </Popover>
  );
}

function OverrideSelect({
  medium,
  channel,
  value,
  defaultOn,
  onChange,
}: {
  medium: ChannelMedium;
  channel: string;
  value: OverrideChoice;
  defaultOn: boolean;
  onChange: (choice: OverrideChoice) => void;
}): React.JSX.Element {
  const id = React.useId();
  const labels: Record<OverrideChoice, string> = {
    default: defaultOn ? t("notifySettings.option.defaultOn") : t("notifySettings.option.defaultOff"),
    on: t("notifySettings.option.on"),
    off: t("notifySettings.option.off"),
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {medium === "email" ? t("notifySettings.channels.emailLabel") : t("notifySettings.channels.pushLabel")}
      </Label>
      <Select<OverrideChoice>
        value={value}
        items={labels}
        onValueChange={(v) => {
          if (isOverrideChoice(v) && v !== value) onChange(v);
        }}
      >
        {medium === "email" ? (
          <SelectTrigger
            id={id}
            data-testid="notify-channel-email"
            data-value={value}
            aria-label={t("notifySettings.channels.email", { channel })}
            className="w-36"
          >
            <SelectValue />
          </SelectTrigger>
        ) : (
          <SelectTrigger
            id={id}
            data-testid="notify-channel-push"
            data-value={value}
            aria-label={t("notifySettings.channels.push", { channel })}
            className="w-36"
          >
            <SelectValue />
          </SelectTrigger>
        )}
        <SelectContent>
          {medium === "email" ? (
            <>
              <SelectItem data-testid="notify-channel-email-default" value="default">
                {labels.default}
              </SelectItem>
              <SelectItem data-testid="notify-channel-email-on" value="on">
                {labels.on}
              </SelectItem>
              <SelectItem data-testid="notify-channel-email-off" value="off">
                {labels.off}
              </SelectItem>
            </>
          ) : (
            <>
              <SelectItem data-testid="notify-channel-push-default" value="default">
                {labels.default}
              </SelectItem>
              <SelectItem data-testid="notify-channel-push-on" value="on">
                {labels.on}
              </SelectItem>
              <SelectItem data-testid="notify-channel-push-off" value="off">
                {labels.off}
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
