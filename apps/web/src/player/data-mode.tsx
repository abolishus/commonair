// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data saver (ADR 0018, feature-wins §4.6): the toggle, the budget picker, the usage meter, the
 * estimate and the notices. Test ids in docs/testing/w1-selectors.md ("Data mode"). The panel
 * only reports and asks; the player owns the choice and the controller applies it.
 */
import { formatBytes, formatNumber, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Label } from "@commonair/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import { Switch } from "@commonair/ui/components/switch";
import * as React from "react";
import { DATA_MODE } from "@commonair/contracts/enums";
import { t } from "../i18n/index.ts";
import type { MessageKey } from "../i18n/keys/index.gen.ts";
import { DATA_MODE_PRESETS, clampBudget, isPreset, planBudget, type DataModeChoice, type LevelInfo } from "./budget.ts";
import type { DataUsage } from "./stats.ts";

export type DataModeNoticeReason = "native-reload" | "dvr" | "vod";

const NOTICE_KEYS: Record<DataModeNoticeReason, MessageKey> = {
  "native-reload": "dataMode.notice.nativeReload",
  dvr: "dataMode.notice.dvr",
  vod: "dataMode.notice.vod",
};

const PRESET_KEYS: Record<(typeof DATA_MODE.presetsMbPerHour)[number], MessageKey> = {
  50: "dataMode.budget.audio",
  800: "dataMode.budget.low",
  1900: "dataMode.budget.medium",
};

/**
 * Why data mode does not apply here (DVR, VODs), or what a change costs (native HLS reloads the
 * stream). VOD playback mounts it with `vod` (ADR 0018 decision 7).
 */
export function DataModeNotice({ reason }: { reason: DataModeNoticeReason }): React.JSX.Element {
  return (
    <p data-testid="data-mode-notice" data-reason={reason} className="text-xs text-muted-foreground">
      {t(NOTICE_KEYS[reason])}
    </p>
  );
}

/** What this session downloaded, and the recent rate. `null` usage: the browser cannot tell. */
export function DataUsageView({ usage }: { usage: DataUsage | null }): React.JSX.Element {
  const { locale } = useLocale();
  if (usage === null)
    return (
      <p data-testid="data-usage" data-unknown="true" className="text-xs text-muted-foreground">
        {t("dataMode.usage.unknown")}
      </p>
    );
  const used = formatBytes(usage.bytes, locale);
  const rate = Math.round(usage.mbPerHour);
  return (
    <p
      data-testid="data-usage"
      data-bytes={String(Math.round(usage.bytes))}
      data-mb-per-hour={String(rate)}
      className="text-xs"
    >
      <output aria-live="off">
        {usage.mbPerHour > 0
          ? t("dataMode.usage.rate", { used, rate: formatNumber(rate, locale) })
          : t("dataMode.usage.value", { used })}
      </output>
    </p>
  );
}

/** The custom budget: a number within the bounds, applied on submit. */
function CustomBudget({
  value,
  disabled,
  onApply,
}: {
  value: number;
  disabled: boolean;
  onApply: (mbPerHour: number) => void;
}): React.JSX.Element {
  const id = React.useId();
  const { locale } = useLocale();
  // Keyed on `value` by the panel, so a new budget starts a fresh draft.
  const [draft, setDraft] = React.useState(String(value));
  const parsed = clampBudget(Number(draft));
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed !== null) onApply(parsed);
      }}
    >
      <Field className="w-32">
        <FieldLabel htmlFor={id}>{t("dataMode.budget.customLabel")}</FieldLabel>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={DATA_MODE.minMbPerHour}
          max={DATA_MODE.maxMbPerHour}
          step={1}
          value={draft}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
      </Field>
      <Button type="submit" size="sm" variant="secondary" disabled={disabled || parsed === null}>
        {t("dataMode.budget.customSave")}
      </Button>
      <FieldDescription id={`${id}-hint`} className="w-full">
        {t("dataMode.budget.customHint", {
          min: formatNumber(DATA_MODE.minMbPerHour, locale),
          max: formatNumber(DATA_MODE.maxMbPerHour, locale),
        })}
      </FieldDescription>
    </form>
  );
}

export interface DataModePanelProps {
  choice: DataModeChoice;
  onChoice: (choice: DataModeChoice) => void;
  /** The ceiling the session's token carries (null when off or not started). */
  applied: number | null;
  /** The ceiling the choice asks for. */
  wanted: number | null;
  /** The session plays through native HLS: a change reloads the stream. */
  native: boolean;
  /** The browser asked to save data and the viewer has not chosen yet. */
  suggested: boolean;
  levels: readonly LevelInfo[];
  /** Undefined until playing; null when the browser cannot tell. */
  usage: DataUsage | null | undefined;
  /** Watching behind live (DVR, W2): data mode does not apply there. */
  dvr: boolean;
}

/** The data-saver section under the player. */
export function DataModePanel({
  choice,
  onChoice,
  applied,
  wanted,
  native,
  suggested,
  levels,
  usage,
  dvr,
}: DataModePanelProps): React.JSX.Element {
  const id = React.useId();
  const { locale } = useLocale();
  const plan = planBudget(choice.mbPerHour, levels);
  const custom = !isPreset(choice.mbPerHour);
  const [customOpen, setCustomOpen] = React.useState(custom);
  const selected = customOpen || custom ? "custom" : String(choice.mbPerHour);
  const estimate = plan.estimateMbPerHour === null ? null : Math.round(plan.estimateMbPerHour);
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-3 rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${id}-title`} className="font-medium">
            {t("dataMode.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("dataMode.intro")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Label htmlFor={`${id}-toggle`}>{t("dataMode.toggle")}</Label>
          <Switch
            id={`${id}-toggle`}
            data-testid="data-mode-toggle"
            data-state={choice.on ? "on" : "off"}
            aria-describedby={`${id}-toggle-hint`}
            checked={choice.on}
            onCheckedChange={(on) => onChoice({ ...choice, on })}
          />
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {choice.on ? t("dataMode.state.on") : t("dataMode.state.off")}
          </span>
        </div>
      </div>
      <p id={`${id}-toggle-hint`} className="text-xs text-muted-foreground">
        {t("dataMode.toggleHint")}
      </p>
      {suggested && !choice.on && <p className="text-xs">{t("dataMode.suggested")}</p>}

      <FieldSet disabled={!choice.on}>
        <FieldLegend variant="label">{t("dataMode.budget.label")}</FieldLegend>
        <RadioGroup
          data-testid="data-mode-budget"
          value={selected}
          disabled={!choice.on}
          onValueChange={(value) => {
            if (value === "custom") {
              setCustomOpen(true);
              return;
            }
            const mb = DATA_MODE_PRESETS.find((p) => String(p) === value);
            if (mb === undefined) return;
            setCustomOpen(false);
            onChoice({ ...choice, mbPerHour: mb });
          }}
        >
          {DATA_MODE_PRESETS.map((mb) => (
            <Field key={mb} orientation="horizontal">
              <RadioGroupItem id={`${id}-${mb}`} value={String(mb)} data-testid={`data-mode-budget-${mb}`} />
              <FieldLabel htmlFor={`${id}-${mb}`} className="font-normal">
                {t(PRESET_KEYS[mb], { mb: formatNumber(mb, locale) })}
              </FieldLabel>
            </Field>
          ))}
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-custom`} value="custom" data-testid="data-mode-budget-custom" />
            <FieldLabel htmlFor={`${id}-custom`} className="font-normal">
              {t("dataMode.budget.custom")}
            </FieldLabel>
          </Field>
        </RadioGroup>
        {selected === "custom" && (
          <CustomBudget
            key={choice.mbPerHour}
            value={choice.mbPerHour}
            disabled={!choice.on}
            onApply={(mbPerHour) => onChoice({ ...choice, mbPerHour })}
          />
        )}
      </FieldSet>

      {choice.on && estimate !== null && (
        <p data-testid="data-mode-estimate" data-mb-per-hour={String(estimate)} className="text-xs">
          {plan.level?.audioOnly
            ? t("dataMode.estimate.audio", { mb: formatNumber(estimate, locale) })
            : t("dataMode.estimate.video", { mb: formatNumber(estimate, locale) })}
        </p>
      )}
      {choice.on && plan.overBudget && <p className="text-xs">{t("dataMode.overBudget")}</p>}
      {wanted !== applied && <output className="block text-xs text-muted-foreground">{t("dataMode.pending")}</output>}
      {usage !== undefined && <DataUsageView usage={usage} />}
      {native && <DataModeNotice reason="native-reload" />}
      {dvr && choice.on && <DataModeNotice reason="dvr" />}
    </section>
  );
}
