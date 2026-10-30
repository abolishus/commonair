// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton, Kbd } from "@commonair/ui";
import { Label } from "@commonair/ui/components/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@commonair/ui/components/popover";
import { Slider } from "@commonair/ui/components/slider";
import { Switch } from "@commonair/ui/components/switch";
import { Leaf01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { RATE_MAX, RATE_MIN } from "./governor.ts";
import {
  DEFAULT_CALM_SETTINGS,
  readCalmSettings,
  subscribeCalmSettings,
  writeCalmSettings,
  type CalmSettings,
} from "./settings.ts";

/** The device's Calm Chat settings, live (every panel and tab follows a change). */
export function useCalmSettings(): CalmSettings {
  return React.useSyncExternalStore(subscribeCalmSettings, readCalmSettings, () => DEFAULT_CALM_SETTINGS);
}

/** The keys the chat list answers while focus is in it (Calm Chat's keyboard help lists them). */
export const CALM_KEYS = { next: "j", previous: "k", mention: "m" } as const;

/**
 * The chat header's Calm Chat controls: the on/off toggle (`calm-toggle`) and a settings popover
 * (rows per second, subscriber priority, keyboard help). Not rendered for moderators, who always
 * see raw chat.
 */
export function CalmControls({ settings }: { settings: CalmSettings }): React.JSX.Element {
  const rateId = React.useId();
  const subsId = React.useId();
  return (
    <>
      <IconButton
        data-testid="calm-toggle"
        data-state={settings.enabled ? "on" : "off"}
        aria-pressed={settings.enabled}
        label={t("calmChat.toggle")}
        tooltip={settings.enabled ? t("calmChat.toggleOn") : t("calmChat.toggleOff")}
        icon={Leaf01Icon}
        size="icon-xs"
        variant={settings.enabled ? "secondary" : "ghost"}
        onClick={() => writeCalmSettings({ enabled: !settings.enabled })}
      />
      <Popover>
        <PopoverTrigger
          render={<IconButton label={t("calmChat.settings.open")} icon={Settings02Icon} size="icon-xs" />}
        />
        <PopoverContent align="end" className="gap-3">
          <PopoverTitle>{t("calmChat.settings.title")}</PopoverTitle>
          <PopoverDescription>{t("calmChat.settings.intro")}</PopoverDescription>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label id={rateId}>{t("calmChat.settings.rate")}</Label>
              <output className="text-muted-foreground tabular-nums">
                {t("calmChat.settings.rateValue", { count: settings.rowsPerSecond })}
              </output>
            </div>
            <Slider
              aria-labelledby={rateId}
              min={RATE_MIN}
              max={RATE_MAX}
              step={1}
              value={[settings.rowsPerSecond]}
              onValueChange={(v) => {
                const n = Array.isArray(v) ? v[0] : v;
                if (typeof n === "number") writeCalmSettings({ rowsPerSecond: n });
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={subsId}>{t("calmChat.settings.subscriberPriority")}</Label>
            <Switch
              id={subsId}
              checked={settings.subscriberPriority}
              onCheckedChange={(on) => writeCalmSettings({ subscriberPriority: on })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-medium">{t("calmChat.keys.title")}</p>
            <ul className="flex flex-col gap-1">
              <li className="flex items-center gap-2">
                <Kbd>{CALM_KEYS.next}</Kbd>
                {t("calmChat.keys.next")}
              </li>
              <li className="flex items-center gap-2">
                <Kbd>{CALM_KEYS.previous}</Kbd>
                {t("calmChat.keys.previous")}
              </li>
              <li className="flex items-center gap-2">
                <Kbd>{CALM_KEYS.mention}</Kbd>
                {t("calmChat.keys.mention")}
              </li>
            </ul>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
