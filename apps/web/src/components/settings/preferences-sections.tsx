// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings → Preferences beyond the language (D7.1 P7: how the site behaves): the theme, the same
 * choice as the account menu's, and playback on this device: data saver by default, sharing with
 * other viewers (P2P, moved here from Privacy). Each saves at once with a toast; all of it lives
 * in this browser, so nothing is sent to the server.
 */
import type { Theme } from "@commonair/ui";
import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { ThemeContext } from "../../lib/theme-context.ts";
import { localStore, readDataModeChoice, saveDataModeChoice } from "../../player/budget.ts";
import { setP2PPreference } from "../../player/p2p/preference.ts";
import { p2pSwitchOn, useMounted, useOperatorP2PDefault, useP2PPrefs } from "../../player/p2p/use-p2p.ts";

const THEME_CHOICES = ["system", "dark", "light"] as const satisfies readonly Theme[];

function themeLabel(theme: Theme): string {
  switch (theme) {
    case "system":
      return t("d7Settings.prefs.theme.system");
    case "dark":
      return t("d7Settings.prefs.theme.dark");
    case "light":
      return t("d7Settings.prefs.theme.light");
  }
}

/** Saved on this device, or the browser said no: say which. */
function savedToast(kept: boolean): void {
  if (kept) toast.success(t("d7Settings.saved"));
  else toast.warning(t("d7Settings.prefs.notKept"));
}

export function ThemeSection(): React.JSX.Element {
  const { theme, setTheme } = React.useContext(ThemeContext);
  const id = React.useId();
  return (
    <SettingsSection
      data-testid="preferences-theme"
      title={t("d7Settings.prefs.theme.title")}
      description={t("d7Settings.prefs.theme.intro")}
    >
      <div className="px-4 py-4 sm:px-6">
        <RadioGroup
          data-testid="preferences-theme-choice"
          data-value={theme}
          aria-label={t("d7Settings.prefs.theme.title")}
          value={theme}
          onValueChange={(value) => {
            const next = THEME_CHOICES.find((c) => c === value);
            if (!next || next === theme) return;
            setTheme(next);
            toast.success(t("d7Settings.saved"));
          }}
        >
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-system`} value="system" data-testid="preferences-theme-system" />
            <FieldLabel htmlFor={`${id}-system`} className="font-normal">
              {themeLabel("system")}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-dark`} value="dark" data-testid="preferences-theme-dark" />
            <FieldLabel htmlFor={`${id}-dark`} className="font-normal">
              {themeLabel("dark")}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-light`} value="light" data-testid="preferences-theme-light" />
            <FieldLabel htmlFor={`${id}-light`} className="font-normal">
              {themeLabel("light")}
            </FieldLabel>
          </Field>
        </RadioGroup>
      </div>
    </SettingsSection>
  );
}

export function PlaybackSection(): React.JSX.Element {
  const mounted = useMounted();
  const dataId = React.useId();
  const p2pId = React.useId();
  const p2pHint = React.useId();

  // Device state is unknown on the server: read only once mounted, so hydration matches. A choice
  // made here wins for this page, also when the browser refused to keep it.
  const [chosen, setChosen] = React.useState<{ dataSaver?: boolean }>({});
  const dataSaver = chosen.dataSaver ?? (mounted && readDataModeChoice(localStore()).choice.on);

  const operatorDefault = useOperatorP2PDefault();
  const prefs = useP2PPrefs();
  const p2pOn = mounted && p2pSwitchOn(prefs, operatorDefault);

  return (
    <SettingsSection
      data-testid="preferences-playback"
      title={t("d7Settings.prefs.playback.title")}
      description={t("d7Settings.prefs.playback.intro")}
    >
      <SettingsRow
        label={t("d7Settings.prefs.dataSaver.label")}
        hint={t("d7Settings.prefs.dataSaver.hint")}
        controlId={dataId}
      >
        <Switch
          id={dataId}
          data-testid="preferences-data-saver"
          checked={dataSaver}
          disabled={!mounted}
          onCheckedChange={(on) => {
            const store = localStore();
            const { choice } = readDataModeChoice(store);
            setChosen((c) => ({ ...c, dataSaver: on }));
            savedToast(saveDataModeChoice(store, { ...choice, on }));
          }}
        />
      </SettingsRow>
      <SettingsRow
        label={t("p2p.dialog.switch")}
        hint={
          <>
            {/* The disclosure sits next to every switch that turns P2P on (ADR 0005 amendment 1). */}
            <span id={p2pHint}>{t("p2p.disclosure")}</span>{" "}
            {operatorDefault === "on" ? t("p2p.dialog.defaultOn") : t("p2p.dialog.default")}{" "}
            {t("p2p.settings.nextStart")}
          </>
        }
        controlId={p2pId}
      >
        <Switch
          id={p2pId}
          data-testid="privacy-p2p-toggle"
          aria-describedby={p2pHint}
          checked={p2pOn}
          disabled={!mounted}
          onCheckedChange={(on) => {
            setP2PPreference(on ? "on" : "off");
            toast.success(t("d7Settings.saved"));
          }}
        />
      </SettingsRow>
      <p className="px-4 py-3 text-sm text-muted-foreground sm:px-6">{t("d7Settings.prefs.playback.perDevice")}</p>
    </SettingsSection>
  );
}
