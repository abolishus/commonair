// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NotifyMedium, PreferenceType } from "@commonair/contracts/enums";
import { SkeletonGroup, SkeletonText } from "@commonair/ui";
import { SettingsSection } from "@commonair/ui/blocks/forms";
import { toast } from "@commonair/ui/toast";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import {
  type NotificationPreferencesDto,
  type OtherPreferenceType,
  type PreferenceTypesClient,
  type SetPreferenceInput,
  type SettingsClient,
  applyPreference,
  copyPreferenceCell,
  preferenceTypesClient,
  settingsClient,
} from "../../lib/notifications.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { objectKey, useRetryingLoad, type LoadState } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { PushToggle } from "../pwa/push-toggle.tsx";
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
 * In app, Email and Push, and this browser's push. Every change is optimistic, saves at once and
 * rolls back on failure. Each channel's own alerts live on `/following` (overhaul wave 5), linked
 * from here.
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
  // A layout effect, so a click right after the load lands (a passive effect may not have run yet).
  const prefsRef = React.useRef(prefs);
  React.useLayoutEffect(() => {
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
    async (input: SetPreferenceInput) => {
      const cell = `${input.channel ?? ""}:${input.medium}`;
      const mine = (seq.current.get(cell) ?? 0) + 1;
      seq.current.set(cell, mine);
      const before = prefsRef.current;
      if (before === null) return;
      setPrefs((p) => (p ? applyPreference(p, input) : p));
      try {
        const answer = await client.setPreference(input);
        // Only this cell: taking the whole answer would undo other cells still being saved.
        if (seq.current.get(cell) === mine) setPrefs((p) => (p ? copyPreferenceCell(p, answer, input) : p));
        saved(input.medium);
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
      <ChannelAlertsLink />
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

/** Per-channel alerts moved to `/following`, where each followed channel already is. */
function ChannelAlertsLink(): React.JSX.Element {
  return (
    <SettingsSection title={t("notifySettings.channels.title")} description={t("w5Watch.settings.channelsIntro")}>
      <div className="px-4 py-4 sm:px-6">
        <Link
          data-testid="notify-following-link"
          to="/following"
          className="text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {t("d7Notify.channels.following")}
        </Link>
      </div>
    </SettingsSection>
  );
}
