// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLocale } from "@commonair/ui";
import { SettingChangeView, type SettingChangeLabels } from "@commonair/ui/blocks/coop";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ProposalDto } from "../../lib/coop.ts";
import { settingDiff } from "../../lib/coop-settings-format.ts";

export function changeLabels(): SettingChangeLabels {
  return {
    to: t("d6Governance.change.to"),
    none: t("d6Governance.change.notSet"),
    technical: t("d6Governance.change.technical"),
    currentValue: t("d6Governance.change.currentValue"),
    proposedValue: t("d6Governance.change.proposedValue"),
    key: t("d6Governance.change.key"),
  };
}

/** One setting change in words: "Creators keep 90% → 85%", the changed fields, the JSON behind a disclosure. */
export function SettingChange({
  settingKey,
  from,
  to,
  isProtected,
  ...props
}: {
  settingKey: string;
  from: unknown;
  to: unknown;
  isProtected: boolean;
} & { [key: `data-${string}`]: string | undefined }): React.JSX.Element {
  const { locale } = useLocale();
  const diff = settingDiff(settingKey, from, to, locale);
  return (
    <SettingChangeView
      {...props}
      settingKey={settingKey}
      title={diff.title}
      fromSummary={diff.fromSummary}
      toSummary={diff.toSummary}
      fields={diff.fields}
      note={
        !diff.changed
          ? t("d6Governance.change.unchanged")
          : diff.otherChanged
            ? t("d6Governance.change.otherChanged")
            : undefined
      }
      protectedLabel={isProtected ? t("d6Governance.protected") : undefined}
      from={from}
      to={to}
      labels={changeLabels()}
    />
  );
}

/** A proposal's "What changes" (`proposal-change-summary` per setting). */
export function ProposalChanges({ changes }: { changes: ProposalDto["changes"] }): React.JSX.Element {
  if (changes.length === 0) return <p className="text-muted-foreground">{t("coop.proposal.noChanges")}</p>;
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {changes.map((c) => (
        <li key={c.key} data-testid="proposal-change-summary" data-key={c.key} data-protected={String(c.protected)}>
          <SettingChange settingKey={c.key} from={c.from} to={c.to} isProtected={c.protected} />
        </li>
      ))}
    </ul>
  );
}
