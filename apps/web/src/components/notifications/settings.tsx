// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NotifyMedium, PreferenceType } from "@commonair/contracts/enums";
import { ChannelAvatar, EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { SettingsSection } from "@commonair/ui/blocks/forms";
import { Label } from "@commonair/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import {
  type ChannelMedium,
  type FollowDto,
  type NotificationPreferencesDto,
  type OtherPreferenceType,
  type OverrideChoice,
  type PreferenceTypesClient,
  type SetPreferenceInput,
  type SettingsClient,
  applyPreference,
  choiceEnabled,
  copyPreferenceCell,
  isOverrideChoice,
  overrideChoice,
  preferenceTypesClient,
  settingsClient,
} from "../../lib/notifications.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { objectKey, useRetryingLoad, type LoadState } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { PushToggle } from "../pwa/push-toggle.tsx";
import { ListLoadMore, ListSearch, NoMatch, useListWindow } from "../settings/list-window.tsx";
import { PreferenceGrid } from "./grid.tsx";

/** The failure toast carries `notify-save-error` so the harness and tests can see it. */
function saveFailed(err: unknown): void {
  if (isSessionExpired(err)) toastActionError(err, t("notifySettings.saveFailed"));
  else toast.error(<span data-testid="notify-save-error">{t("notifySettings.saveFailed")}</span>);
}

export interface NotificationSettingsProps {
  /** Tests pass a fixture client; the app uses the API. */
  client?: SettingsClient;
  /**
   * The other preference types (governance, payout, creator, the weekly digest). The app uses the
   * API; a test that passes only `client` gets the go-live row alone.
   */
  typesClient?: PreferenceTypesClient | null;
}

const OTHER_TYPES = [
  "governance",
  "payout",
  "creator",
  "digest_weekly",
] as const satisfies readonly OtherPreferenceType[];
type OtherPrefs = Partial<Record<OtherPreferenceType, NotificationPreferencesDto>>;

/**
 * `/settings/notifications` (overhaul wave 4, D7.3): the grid of every notification type against
 * In app, Email and Push, this browser's push, and each followed channel's bell and go-live
 * email/push overrides. Every change is optimistic, saves at once and rolls back on failure.
 */
export function NotificationSettings({
  client: given,
  typesClient: givenTypes,
}: NotificationSettingsProps = {}): React.JSX.Element {
  const client = React.useMemo(() => given ?? settingsClient(), [given]);
  const typesClient = React.useMemo(
    () => (givenTypes !== undefined ? givenTypes : given ? null : preferenceTypesClient()),
    [given, givenTypes],
  );
  React.useEffect(() => {
    trackUi("settings.notifications", "view");
  }, []);
  // The defaults retry by itself on a busy API and have their own Retry (F3); the rest of the page stays.
  const loaded = useRetryingLoad(`prefs|${objectKey(client)}`, () => client.preferences());
  const [prefs, setPrefs] = React.useState<NotificationPreferencesDto | null>(null);
  const [shown, setShown] = React.useState<NotificationPreferencesDto | null>(null);
  // A new answer replaces the edited copy during render, so the switches never flash empty.
  if (loaded.data !== null && loaded.data !== shown) {
    setShown(loaded.data);
    setPrefs(loaded.data);
  }
  const load: LoadState =
    loaded.data !== null && loaded.data === shown ? "loaded" : loaded.state === "failed" ? "failed" : "loading";
  // The latest request per cell: an older answer never overwrites a newer choice.
  const seq = React.useRef(new Map<string, number>());
  // What a failed change rolls its cell back to: the state the member saw when they made it.
  const prefsRef = React.useRef(prefs);
  React.useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // Turning browser push on may also have turned the go-live push default on, outside this page.
  const adoptPushDefault = React.useCallback(async () => {
    const cell = ":push";
    const mine = (seq.current.get(cell) ?? 0) + 1;
    seq.current.set(cell, mine);
    try {
      const answer = await client.preferences();
      if (seq.current.get(cell) === mine)
        setPrefs((p) => (p ? copyPreferenceCell(p, answer, { medium: "push", channel: null }) : p));
    } catch {
      // The switch already reports push itself; the default shows its last known state.
    }
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
        if (input.channel === null) saved(input.medium);
      } catch (err) {
        if (seq.current.get(cell) === mine) setPrefs((p) => (p ? copyPreferenceCell(p, before, input) : p));
        saveFailed(err);
      }
    },
    [client],
  );

  const others = useOtherTypes(typesClient);

  return (
    <div className="flex flex-col gap-6">
      {load === "loading" ? (
        <SkeletonGroup label={t("notifySettings.loading")}>
          <SkeletonText lines={6} />
        </SkeletonGroup>
      ) : load === "failed" || prefs === null ? (
        <DefaultsFrame>
          <SectionLoadError
            data-testid="notify-defaults-load-error"
            retryTestId="notify-defaults-retry"
            section={t("d7Notify.grid.title")}
            load={loaded}
            headingLevel={3}
          />
        </DefaultsFrame>
      ) : (
        <PreferenceGrid
          goLive={prefs}
          onGoLive={(medium, enabled) => void change({ medium, channel: null, enabled })}
          others={others.prefs}
          onOther={(type, medium, enabled) => void others.change(type, medium, enabled)}
          othersStatus={others.status}
        />
      )}
      <SettingsSection title={t("notifySettings.push.title")}>
        <div className="px-4 py-4 sm:px-6">
          <PushToggle onPushOn={() => void adoptPushDefault()} />
        </div>
      </SettingsSection>
      <ChannelsSection client={client} prefs={prefs} onChange={(input, channel) => void change(input, channel)} />
    </div>
  );
}

/** The autosave confirmation, and the step the metric counts (the digest opt-in is its own). */
function saved(medium: NotifyMedium, type: PreferenceType = "go_live"): void {
  toast.success(<span data-testid="notify-saved">{t("d7Notify.saved")}</span>);
  trackUi(
    "settings.notifications",
    "submit",
    type === "digest_weekly" ? "weekly" : medium === "email" ? "email" : medium === "push" ? "push" : "none",
  );
}

/**
 * The other types' defaults: loaded together (one Retry for all), each cell optimistic with its
 * own request order, as for go-live.
 */
function useOtherTypes(typesClient: PreferenceTypesClient | null): {
  prefs: OtherPrefs | null;
  status: React.ReactNode;
  change: (type: OtherPreferenceType, medium: NotifyMedium, enabled: boolean) => Promise<void>;
} {
  const loaded = useRetryingLoad(`types|${typesClient ? objectKey(typesClient) : "none"}`, async () => {
    if (typesClient === null) return null;
    const all = await Promise.all(OTHER_TYPES.map((type) => typesClient.get(type)));
    const out: OtherPrefs = {};
    OTHER_TYPES.forEach((type, i) => {
      const p = all[i];
      if (p) out[type] = p;
    });
    return out;
  });
  const [prefs, setPrefs] = React.useState<OtherPrefs | null>(null);
  const [shown, setShown] = React.useState<OtherPrefs | null>(null);
  if (loaded.data !== null && loaded.data !== shown) {
    setShown(loaded.data);
    setPrefs(loaded.data);
  }
  const seq = React.useRef(new Map<string, number>());
  const change = async (type: OtherPreferenceType, medium: NotifyMedium, enabled: boolean) => {
    if (typesClient === null) return;
    const cell = `${type}:${medium}`;
    const mine = (seq.current.get(cell) ?? 0) + 1;
    seq.current.set(cell, mine);
    const setCell = (value: boolean, builtIn: boolean) =>
      setPrefs((all) => {
        const p = all?.[type];
        if (!all || !p) return all;
        return {
          ...all,
          [type]: {
            ...p,
            defaults: { ...p.defaults, [medium]: value },
            builtIn: { ...p.builtIn, [medium]: builtIn },
          },
        };
      });
    const before = prefs?.[type];
    setCell(enabled, false);
    try {
      const answer = await typesClient.set(type, medium, enabled);
      if (seq.current.get(cell) === mine) setCell(answer.defaults[medium], answer.builtIn[medium]);
      saved(medium, type);
    } catch (err) {
      if (seq.current.get(cell) === mine && before) setCell(before.defaults[medium], before.builtIn[medium]);
      saveFailed(err);
    }
  };
  const status =
    typesClient === null || loaded.data !== null ? null : loaded.state === "failed" ? (
      <SectionLoadError
        data-testid="notify-types-load-error"
        retryTestId="notify-types-retry"
        section={t("d7Notify.grid.title")}
        load={loaded}
        headingLevel={3}
      />
    ) : (
      <SkeletonGroup label={t("notifySettings.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  return { prefs, status, change };
}

/** The defaults' heading and intro, with their load error. */
function DefaultsFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <SettingsSection title={t("d7Notify.grid.title")} description={t("d7Notify.grid.intro")}>
      <div className="px-4 py-4 sm:px-6">{children}</div>
    </SettingsSection>
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
  const bellLabelId = `${bellId}-label`;
  const nameId = `${bellId}-name`;
  return (
    <li data-testid="notify-channel" data-slug={c.slug} className="flex flex-col gap-3 py-4">
      {/* F39: the bell sits on the name line, with a visible label. */}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChannelAvatar name={c.displayName} src={c.avatarUrl} accent={c.accent} size="sm" decorative />
          <span id={nameId} className="min-w-0 truncate font-medium">
            {c.displayName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Label id={bellLabelId} htmlFor={bellId} className="text-sm font-normal">
            {t("settings.notifications.bell")}
          </Label>
          <Switch
            id={bellId}
            data-testid="notify-channel-bell"
            data-state={follow.notify ? "on" : "off"}
            // WCAG 2.5.3: the name starts with the visible label, then says which channel.
            aria-labelledby={`${bellLabelId} ${nameId}`}
            checked={follow.notify}
            onCheckedChange={onBell}
          />
        </div>
      </div>
      {prefs && (
        <div className="flex flex-wrap items-end gap-4 sm:ps-11">
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
        </div>
      )}
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
  const first = useRetryingLoad(`follows|${objectKey(client)}`, () => client.follows(null));
  const [follows, setFollows] = React.useState<FollowDto[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState<typeof first.data>(null);
  const [more, setMore] = React.useState(false);
  if (first.data !== null && first.data !== shown) {
    setShown(first.data);
    setFollows(first.data.items);
    setCursor(first.data.nextCursor);
  }
  const load: LoadState =
    first.data !== null && first.data === shown ? "loaded" : first.state === "failed" ? "failed" : "loading";

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

  const list = useListWindow(follows, (f) => [f.channel.displayName, f.channel.slug], {
    serverHasMore: cursor !== null,
    onServerMore: () => void loadMore(),
  });

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
    <SettingsSection
      title={t("notifySettings.channels.title")}
      description={t("notifySettings.channels.intro")}
      action={
        <Link
          data-testid="notify-following-link"
          to="/following"
          className="text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {t("d7Notify.channels.following")}
        </Link>
      }
    >
      <div className="flex flex-col gap-2 px-4 py-4 sm:px-6">
        {load === "loading" ? (
          <SkeletonGroup label={t("notifySettings.loading")}>
            <SkeletonText lines={3} />
          </SkeletonGroup>
        ) : load === "failed" ? (
          <SectionLoadError
            data-testid="notify-channels-load-error"
            retryTestId="notify-channels-retry"
            section={t("notifySettings.channels.title")}
            load={first}
            headingLevel={3}
          />
        ) : follows.length === 0 ? (
          <EmptyState
            icon={UserGroupIcon}
            title={t("notifySettings.channels.empty")}
            description={t("notifySettings.channels.emptyBody")}
            headingLevel={3}
          />
        ) : (
          <>
            <ListSearch
              data-testid="notify-channels-search"
              label={t("settings.notifications.search")}
              value={list.query}
              onValueChange={list.setQuery}
              loadedCount={follows.length}
              partial={cursor !== null}
            />
            {list.matched.length === 0 ? (
              <NoMatch query={list.query} />
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {list.shown.map((f) => (
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
            {list.hasMore && (
              <ListLoadMore
                data-testid="notify-channels-more"
                label={t("notifySettings.channels.loadMore")}
                loading={more}
                onClick={list.loadMore}
              />
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
