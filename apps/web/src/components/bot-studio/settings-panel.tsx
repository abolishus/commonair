// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel bot's settings on `/bot`, owner and editors only (docs/testing/e8-selectors.md
 * "Channel bot"): on/off, display name, chat filters, points and song requests, saved together.
 * The first enable creates the bot account, which is shown once saved.
 */
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { FieldSeparator } from "@commonair/ui/components/field";
import { toast } from "@commonair/ui/toast";
import { Settings02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  BOT_LIMITS,
  botSettingsDraft,
  botSettingsInput,
  createdBotAccount,
  type BotSettingsDraft,
  type BotSettingsDto,
  type BotSettingsField,
} from "../../lib/bot-studio.ts";
import type { FieldErrors } from "../../lib/interact-studio.ts";
import { StudioSection, TextField, ToggleField, type StudioApi } from "../interact-studio/shared.tsx";

export function BotSettingsPanel({
  channel,
  initial,
  client,
}: {
  channel: string;
  initial: BotSettingsDto;
  client: StudioApi;
}): React.JSX.Element {
  const [saved, setSaved] = React.useState(initial);
  const [draft, setDraft] = React.useState<BotSettingsDraft>(() => botSettingsDraft(initial));
  const [errors, setErrors] = React.useState<FieldErrors<BotSettingsField>>({});
  const [created, setCreated] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = <K extends keyof BotSettingsDraft>(key: K, value: BotSettingsDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    const checked = botSettingsInput(channel, draft, saved.config);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const next = await client.bot.updateSettings(checked.input);
      const account = createdBotAccount(saved, next);
      if (account !== null) setCreated(account);
      setSaved(next);
      setDraft(botSettingsDraft(next));
      toast.success(t("bot.settings.saved"));
    } catch (err) {
      toastActionError(err, t("bot.settings.saveFailed"));
    } finally {
      setPending(false);
    }
  };

  const username = saved.botUser?.username ?? "";
  return (
    <StudioSection icon={Settings02Icon} title={t("bot.settings.title")} description={t("bot.settings.intro")}>
      <form
        data-testid="bot-settings"
        noValidate
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4"
        aria-label={t("bot.settings.title")}
      >
        <ToggleField
          label={t("bot.settings.enabled")}
          description={t("bot.settings.enabledHint")}
          checked={draft.enabled}
          onChange={(v) => set("enabled", v)}
          data-testid="bot-enabled"
        />
        <p data-testid="bot-account" data-username={username} className="text-sm text-muted-foreground">
          {username ? t("bot.settings.account", { username }) : t("bot.settings.noAccount")}
        </p>
        {created ? (
          <AlertCallout
            tone="info"
            live
            title={t("bot.settings.createdTitle")}
            description={t("bot.settings.created", { username: created })}
          />
        ) : null}
        <TextField
          label={t("bot.settings.displayName")}
          value={draft.displayName}
          onChange={(v) => set("displayName", v)}
          data-testid="bot-display-name"
          error={errors.displayName}
          description={t("bot.settings.displayNameHint", { max: BOT_LIMITS.displayNameMax })}
        />
        <FieldSeparator />
        <h3 className="text-sm font-medium">{t("bot.settings.filters")}</h3>
        <ToggleField
          label={t("bot.settings.filterSpam")}
          description={t("bot.settings.filterSpamHint")}
          checked={draft.spam}
          onChange={(v) => set("spam", v)}
          data-testid="bot-filter-spam"
        />
        <ToggleField
          label={t("bot.settings.filterLinks")}
          description={t("bot.settings.filterLinksHint")}
          checked={draft.links}
          onChange={(v) => set("links", v)}
          data-testid="bot-filter-links"
        />
        <ToggleField
          label={t("bot.settings.filterCaps")}
          description={t("bot.settings.filterCapsHint")}
          checked={draft.caps}
          onChange={(v) => set("caps", v)}
          data-testid="bot-filter-caps"
        />
        <TextField
          label={t("bot.settings.timeout")}
          value={draft.timeout}
          onChange={(v) => set("timeout", v)}
          data-testid="bot-filter-timeout"
          numeric
          error={errors.timeout}
          description={t("bot.settings.timeoutHint")}
        />
        <FieldSeparator />
        <h3 className="text-sm font-medium">{t("bot.settings.points")}</h3>
        <ToggleField
          label={t("bot.settings.pointsEnabled")}
          description={t("bot.settings.pointsEnabledHint")}
          checked={draft.pointsEnabled}
          onChange={(v) => set("pointsEnabled", v)}
          data-testid="bot-points-enabled"
        />
        <TextField
          label={t("bot.settings.pointsName")}
          value={draft.pointsName}
          onChange={(v) => set("pointsName", v)}
          data-testid="bot-points-name"
          error={errors.pointsName}
          description={t("bot.settings.pointsNameHint", { max: BOT_LIMITS.pointsNameMax })}
        />
        <FieldSeparator />
        <h3 className="text-sm font-medium">{t("bot.settings.songRequests")}</h3>
        <ToggleField
          label={t("bot.settings.srEnabled")}
          description={t("bot.settings.srEnabledHint")}
          checked={draft.srEnabled}
          onChange={(v) => set("srEnabled", v)}
          data-testid="bot-sr-enabled"
        />
        <TextField
          label={t("bot.settings.srMax")}
          value={draft.srMax}
          onChange={(v) => set("srMax", v)}
          data-testid="bot-sr-max"
          numeric
          error={errors.srMax}
          description={t("bot.settings.srMaxHint", { min: BOT_LIMITS.srMin, max: BOT_LIMITS.srMax })}
        />
        <Button type="submit" data-testid="bot-save" disabled={pending} className="self-start">
          {t("bot.settings.save")}
        </Button>
      </form>
    </StudioSection>
  );
}
