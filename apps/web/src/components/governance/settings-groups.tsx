// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, useLocale } from "@commonair/ui";
import { ProtectedBadge } from "@commonair/ui/blocks/coop";
import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { SettingDto } from "../../lib/coop.ts";
import {
  SETTING_THEMES,
  settingSummary,
  settingTheme,
  settingTitle,
  themeHint,
  themeLabel,
  type SettingTheme,
} from "../../lib/coop-settings-format.ts";
import { rich } from "./rich.tsx";

/** The settings by theme, in theme order; a theme with no settings is left out. */
export function groupSettings<S extends Pick<SettingDto, "key">>(
  settings: readonly S[],
): { theme: SettingTheme; items: S[] }[] {
  return SETTING_THEMES.map((theme) => ({
    theme,
    items: settings.filter((s) => settingTheme(s.key) === theme),
  })).filter((g) => g.items.length > 0);
}

/** "Changed by <proposal>" (linked), or "Founding value" for a setting no proposal has changed. */
export function ChangedBy({ setting }: { setting: SettingDto }): React.JSX.Element {
  const when = <RelativeTime date={setting.updatedAt} />;
  if (!setting.updatedByProposalId) return <>{rich((v) => t("d6Governance.settings.founding", v), { when })}</>;
  const link = (
    <Link
      to="/coop/proposals/$id"
      params={{ id: setting.updatedByProposalId }}
      data-testid="setting-changed-by"
      className="text-foreground underline underline-offset-4"
    >
      {setting.updatedByProposalTitle ?? t("d6Governance.settings.aProposal")}
    </Link>
  );
  return <>{rich((v) => t("d6Governance.settings.changedBy", v), { proposal: link, when })}</>;
}

/**
 * `/coop/settings` (overhaul D6.2): every governance setting in plain words, grouped by theme
 * (Money, Governance, Membership, Discovery, Safety, Features). A row is the setting's title, its
 * value in words, the neutral Protected lock and the decision that last changed it; the raw key
 * is meta text only.
 */
export function GovernanceSettingsGroups({ settings }: { settings: readonly SettingDto[] }): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <div data-testid="settings-groups" className="flex min-w-0 flex-col gap-6">
      {groupSettings(settings).map((group) => (
        <SettingsSection
          key={group.theme}
          data-testid="settings-group"
          data-theme={group.theme}
          title={themeLabel(group.theme)}
          description={themeHint(group.theme)}
        >
          {group.items.map((s) => (
            <SettingsRow
              key={s.key}
              data-testid="setting-row"
              data-key={s.key}
              data-protected={String(s.protected)}
              data-updated-by={s.updatedByProposalId ?? ""}
              label={settingTitle(s.key)}
              hint={
                <>
                  <span data-testid="setting-value" className="block text-foreground wrap-anywhere">
                    {settingSummary(s.key, s.value, locale)}
                  </span>
                  <span className="mt-1 block text-xs">
                    <ChangedBy setting={s} />
                  </span>
                  <span className="mt-0.5 block text-xs">
                    {rich((v) => t("d6Governance.settings.key", v), {
                      key: <code className="font-mono wrap-anywhere">{s.key}</code>,
                    })}
                  </span>
                </>
              }
            >
              {s.protected ? <ProtectedBadge label={t("d6Governance.protected")} /> : null}
            </SettingsRow>
          ))}
        </SettingsSection>
      ))}
    </div>
  );
}
