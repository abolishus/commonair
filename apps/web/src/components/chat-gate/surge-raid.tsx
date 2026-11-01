// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Surge raids on the web (batch 7 decision (w), docs/testing/b7-selectors.md "Surge raids"): the
 * studio "Protect raids" switch under the surge guard, and the moderator banner's raid line, which
 * names the source and its verified count while a raid holds chat watchers-only.
 */
import { RAID_RULES } from "@commonair/contracts/enums";
import { RelativeTime } from "@commonair/ui";
import { SwitchField } from "@commonair/ui/blocks/forms";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { fillNode } from "../../lib/fill.tsx";
import type { ChatGateClient } from "./features.ts";

/** "Protect raids" (`surgeGuard.onRaid`) and the note that verified raiders chat at once. */
export function ProtectRaidsField({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  // A variable, not a literal: the data attributes are not in the switch's prop type.
  const switchProps = { "data-testid": "surge-guard-on-raid", "data-state": checked ? "on" : "off" };
  return (
    <div className="flex flex-col gap-2">
      <SwitchField
        label={t("surgeRaids.protect.label")}
        description={t("surgeRaids.protect.hint", { minutes: RAID_RULES.surgeMinutes })}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        switchProps={switchProps}
      />
      <p data-testid="surge-guard-on-raid-note" className="text-sm text-muted-foreground">
        {t("surgeRaids.protect.note")}
      </p>
    </div>
  );
}

/** What the banner line shows: the raid from `chat.surge.state` and when surge mode ends. */
export interface SurgeRaidView {
  fromChannel: string;
  verifiedCount: number;
  until: string | null;
}

/** The raid line's content, or null when the state names no raid (or surge mode is not on). Pure. */
export function surgeRaidView(s: {
  state: "off" | "on" | "suppressed";
  until: string | null;
  raid?: { fromChannel: string; verifiedCount: number } | null;
}): SurgeRaidView | null {
  if (s.state !== "on" || !s.raid) return null;
  return { fromChannel: s.raid.fromChannel, verifiedCount: s.raid.verifiedCount, until: s.until };
}

/** The raid line itself. */
export function SurgeRaidText({ view }: { view: SurgeRaidView }): React.JSX.Element {
  const line = t("surgeRaids.banner.from", { channel: view.fromChannel, count: view.verifiedCount });
  return (
    <p
      data-testid="surge-raid"
      data-from={view.fromChannel}
      data-verified-count={view.verifiedCount}
      data-until={view.until ?? ""}
      className="break-words"
    >
      {line}{" "}
      {view.until
        ? fillNode(t("surgeRaids.banner.until"), "time", <RelativeTime date={view.until} tooltip={false} />)
        : t("surgeRaids.banner.watchersOnly")}
    </p>
  );
}

/**
 * The moderator banner's raid line. It reads `chat.surge.state` on mount and again whenever a
 * `surge` frame turns surge mode on (the frame says nothing about raids), and renders nothing while
 * the latest frame is not `on` or the state names no raid.
 */
export function SurgeRaidLine({
  channel,
  surge,
  client,
}: {
  channel: string;
  /** The latest `surge` frame (`SurgeBannerProps["surge"]`); null before one arrives. */
  surge: { state: "off" | "on" | "suppressed"; until: string | null } | null;
  client?: ChatGateClient;
}): React.JSX.Element | null {
  const [view, setView] = React.useState<SurgeRaidView | null>(null);
  const frameOn = surge === null || surge.state === "on";
  React.useEffect(() => {
    if (!frameOn) return;
    let live = true;
    Promise.resolve()
      .then(() => (client ?? api()).chat.surge.state({ channel }))
      .then(
        (s) => {
          if (live) setView(surgeRaidView(s));
        },
        // The banner still shows surge mode; only the raid line is missing.
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [client, channel, surge, frameOn]);
  if (!frameOn || !view) return null;
  // A newer frame's `until` (an extension) wins over the read's.
  return <SurgeRaidText view={surge?.until ? { ...view, until: surge.until } : view} />;
}
