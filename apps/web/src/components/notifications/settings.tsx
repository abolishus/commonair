// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar, EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import { Label } from "@commonair/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import { MailAtSign01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import {
  type ChannelMedium,
  type FollowDto,
  type NotificationPreferencesDto,
  type OverrideChoice,
  type SetPreferenceInput,
  type SettingsClient,
  applyPreference,
  choiceEnabled,
  copyPreferenceCell,
  isOverrideChoice,
  overrideChoice,
  settingsClient,
} from "../../lib/notifications.ts";
import { PushToggle } from "../pwa/push-toggle.tsx";

/** The failure toast carries `notify-save-error` so the harness and tests can see it. */
function saveFailed(err: unknown): void {
  if (isSessionExpired(err)) toastActionError(err, t("notifySettings.saveFailed"));
  else toast.error(<span data-testid="notify-save-error">{t("notifySettings.saveFailed")}</span>);
}

type Load = "loading" | "loaded" | "failed";

export interface NotificationSettingsProps {
  /** Tests pass a fixture client; the app uses the API. */
  client?: SettingsClient;
}

/**
 * `/settings/notifications`: go-live defaults per medium, this browser's push, and each followed
 * channel's bell and email/push overrides. Every change is optimistic and rolls back on failure.
 */
export function NotificationSettings({ client: given }: NotificationSettingsProps = {}): React.JSX.Element {
  const client = React.useMemo(() => given ?? settingsClient(), [given]);
  const [prefs, setPrefs] = React.useState<NotificationPreferencesDto | null>(null);
  const [load, setLoad] = React.useState<Load>("loading");
  // The latest request per cell: an older answer never overwrites a newer choice.
  const seq = React.useRef(new Map<string, number>());
  // What a failed change rolls its cell back to: the state the member saw when they made it.
  const prefsRef = React.useRef(prefs);
  React.useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  React.useEffect(() => {
    let live = true;
    client.preferences().then(
      (p) => {
        if (!live) return;
        setPrefs(p);
        setLoad("loaded");
      },
      () => {
        if (live) setLoad("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const change = React.useCallback(
    async (input: SetPreferenceInput, channel?: { id: string; slug: string; displayName: string }) => {
      const cell = `${input.channel ?? ""}:${input.medium}`;
      const mine = (seq.current.get(cell) ?? 0) + 1;
      seq.current.set(cell, mine);
      const before = prefsRef.current;
      if (before === null) return;
      setPrefs((p) => (p ? applyPreference(p, input, channel) : p));
      try {
        const answer = await client.setPreference(input);
        // Only this cell: taking the whole answer would undo other cells still being saved.
        if (seq.current.get(cell) === mine) setPrefs((p) => (p ? copyPreferenceCell(p, answer, input) : p));
      } catch (err) {
        if (seq.current.get(cell) === mine) setPrefs((p) => (p ? copyPreferenceCell(p, before, input) : p));
        saveFailed(err);
      }
    },
    [client],
  );

  return (
    <div className="flex flex-col gap-8">
      {load === "loading" ? (
        <SkeletonGroup label={t("notifySettings.loading")}>
          <SkeletonText lines={4} />
        </SkeletonGroup>
      ) : load === "failed" || prefs === null ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("notifySettings.loadFailed")}
        </p>
      ) : (
        <DefaultsSection
          prefs={prefs}
          onChange={(medium, enabled) => void change({ medium, channel: null, enabled })}
        />
      )}
      <section aria-labelledby="notify-push-title" className="flex flex-col gap-3">
        <h2 id="notify-push-title" className="text-base font-medium">
          {t("notifySettings.push.title")}
        </h2>
        <PushToggle />
      </section>
      <ChannelsSection client={client} prefs={prefs} onChange={(input, channel) => void change(input, channel)} />
    </div>
  );
}

// ------------------------------------------------------------------ defaults

function DefaultSwitch({
  medium,
  prefs,
  onChange,
}: {
  medium: "in_app" | "email" | "push";
  prefs: NotificationPreferencesDto;
  onChange: (medium: "in_app" | "email" | "push", enabled: boolean) => void;
}): React.JSX.Element {
  const id = React.useId();
  const hint = `${id}-hint`;
  const checked = prefs.defaults[medium];
  const builtIn = prefs.builtIn[medium];
  const common = {
    id,
    "aria-describedby": hint,
    checked,
    "data-state": checked ? "on" : "off",
    "data-builtin": builtIn ? "true" : "false",
    onCheckedChange: (on: boolean) => onChange(medium, on),
  };
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>
          {medium === "in_app"
            ? t("notifySettings.medium.in_app")
            : medium === "email"
              ? t("notifySettings.medium.email")
              : t("notifySettings.medium.push")}
        </Label>
        <p id={hint} className="text-xs text-muted-foreground">
          {medium === "in_app"
            ? t("notifySettings.medium.in_app.hint")
            : medium === "email"
              ? t("notifySettings.medium.email.hint")
              : t("notifySettings.medium.push.hint")}
          {builtIn && <span className="ms-1">{t("notifySettings.builtIn")}</span>}
        </p>
      </div>
      {medium === "in_app" ? (
        <Switch data-testid="notify-default-in_app" {...common} />
      ) : medium === "email" ? (
        <Switch data-testid="notify-default-email" {...common} />
      ) : (
        <Switch data-testid="notify-default-push" {...common} />
      )}
    </div>
  );
}

function DefaultsSection({
  prefs,
  onChange,
}: {
  prefs: NotificationPreferencesDto;
  onChange: (medium: "in_app" | "email" | "push", enabled: boolean) => void;
}): React.JSX.Element {
  return (
    <section aria-labelledby="notify-defaults-title" className="flex flex-col gap-2">
      <h2 id="notify-defaults-title" className="text-base font-medium">
        {t("notifySettings.defaults.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("notifySettings.defaults.intro")}</p>
      <div className="flex flex-col divide-y divide-border">
        <DefaultSwitch medium="in_app" prefs={prefs} onChange={onChange} />
        <DefaultSwitch medium="email" prefs={prefs} onChange={onChange} />
        <DefaultSwitch medium="push" prefs={prefs} onChange={onChange} />
      </div>
      {!prefs.emailVerified && (
        <Alert data-testid="notify-email-unverified">
          <HugeiconsIcon icon={MailAtSign01Icon} strokeWidth={2} aria-hidden />
          <AlertDescription>{t("notifySettings.emailUnverified")}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ channels

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
  const defaultLabel = defaultOn ? t("notifySettings.option.defaultOn") : t("notifySettings.option.defaultOff");
  const labels: Record<OverrideChoice, string> = {
    default: defaultLabel,
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

function ChannelRow({
  follow,
  prefs,
  onBell,
  onChange,
}: {
  follow: FollowDto;
  prefs: NotificationPreferencesDto | null;
  onBell: (notify: boolean) => void;
  onChange: (medium: ChannelMedium, choice: OverrideChoice) => void;
}): React.JSX.Element {
  const c = follow.channel;
  const bellId = React.useId();
  return (
    <li
      data-testid="notify-channel"
      data-slug={c.slug}
      className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ChannelAvatar name={c.displayName} src={c.avatarUrl} accent={c.accent} size="sm" decorative />
        <span className="min-w-0 truncate font-medium">{c.displayName}</span>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={bellId} className="sr-only">
            {t("notifySettings.channels.bell", { channel: c.displayName })}
          </Label>
          <Switch
            id={bellId}
            data-testid="notify-channel-bell"
            data-state={follow.notify ? "on" : "off"}
            checked={follow.notify}
            onCheckedChange={onBell}
          />
        </div>
        {prefs && (
          <>
            <OverrideSelect
              medium="email"
              channel={c.displayName}
              value={overrideChoice(prefs, c.slug, "email")}
              defaultOn={prefs.defaults.email}
              onChange={(choice) => onChange("email", choice)}
            />
            <OverrideSelect
              medium="push"
              channel={c.displayName}
              value={overrideChoice(prefs, c.slug, "push")}
              defaultOn={prefs.defaults.push}
              onChange={(choice) => onChange("push", choice)}
            />
          </>
        )}
      </div>
    </li>
  );
}

function ChannelsSection({
  client,
  prefs,
  onChange,
}: {
  client: SettingsClient;
  prefs: NotificationPreferencesDto | null;
  onChange: (input: SetPreferenceInput, channel: { id: string; slug: string; displayName: string }) => void;
}): React.JSX.Element {
  const [follows, setFollows] = React.useState<FollowDto[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [load, setLoad] = React.useState<Load>("loading");
  const [more, setMore] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    client.follows(null).then(
      (page) => {
        if (!live) return;
        setFollows(page.items);
        setCursor(page.nextCursor);
        setLoad("loaded");
      },
      () => {
        if (live) setLoad("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const loadMore = async () => {
    if (cursor === null || more) return;
    setMore(true);
    try {
      const page = await client.follows(cursor);
      setFollows((list) => {
        const seen = new Set(list.map((f) => f.channel.id));
        return [...list, ...page.items.filter((f) => !seen.has(f.channel.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      toast.error(t("notifySettings.loadFailed"));
    } finally {
      setMore(false);
    }
  };

  const setNotify = (slug: string, notify: boolean) =>
    setFollows((list) => list.map((f) => (f.channel.slug === slug ? { ...f, notify } : f)));

  // The latest bell request per channel, and the value before it: as for the preference cells,
  // an older answer never overwrites a newer click, and a failure restores what the member saw.
  const bellSeq = React.useRef(new Map<string, number>());
  const bell = async (follow: FollowDto, notify: boolean) => {
    const slug = follow.channel.slug;
    const mine = (bellSeq.current.get(slug) ?? 0) + 1;
    bellSeq.current.set(slug, mine);
    const previous = follow.notify;
    setNotify(slug, notify);
    try {
      await client.setBell(slug, notify);
    } catch (err) {
      if (bellSeq.current.get(slug) === mine) setNotify(slug, previous);
      saveFailed(err);
    }
  };

  return (
    <section aria-labelledby="notify-channels-title" className="flex flex-col gap-2">
      <h2 id="notify-channels-title" className="text-base font-medium">
        {t("notifySettings.channels.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("notifySettings.channels.intro")}</p>
      {load === "loading" ? (
        <SkeletonGroup label={t("notifySettings.loading")}>
          <SkeletonText lines={3} />
        </SkeletonGroup>
      ) : load === "failed" ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("notifySettings.loadFailed")}
        </p>
      ) : follows.length === 0 ? (
        <EmptyState
          icon={UserGroupIcon}
          title={t("notifySettings.channels.empty")}
          description={t("notifySettings.channels.emptyBody")}
          headingLevel={3}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {follows.map((f) => (
            <ChannelRow
              key={f.channel.id}
              follow={f}
              prefs={prefs}
              onBell={(notify) => void bell(f, notify)}
              onChange={(medium, choice) =>
                onChange(
                  { medium, channel: f.channel.slug, enabled: choiceEnabled(choice) },
                  { id: f.channel.id, slug: f.channel.slug, displayName: f.channel.displayName },
                )
              }
            />
          ))}
        </ul>
      )}
      {cursor !== null && load === "loaded" && (
        <Button variant="outline" size="sm" className="self-start" disabled={more} onClick={() => void loadMore()}>
          {t("notifySettings.channels.loadMore")}
        </Button>
      )}
    </section>
  );
}
