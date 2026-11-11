// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The notifications grid (overhaul wave 4, D7.3; account-admin.md P4): every preference type
 * against In app, Email and Push, offering only `PREFERENCE_MEDIA[type]` ("–" elsewhere, "Always"
 * for the `LOCKED_CELLS`, such as payout in-app), then the types that always reach the inbox as
 * locked "Always" cells with a tooltip saying why. Below `sm`
 * each row stacks into its own card with three labelled cells. Changes save as they are made.
 */
import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Switch } from "@commonair/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@commonair/ui/components/tooltip";
import { MailAtSign01Icon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { NotifyMedium } from "@commonair/contracts/enums";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import {
  ALWAYS_ROWS,
  GRID_MEDIA,
  GRID_ROWS,
  LOCKED_CELLS,
  type AlwaysRow,
  type NotificationPreferencesDto,
  type OtherPreferenceType,
  PREFERENCE_CELL_TEST_IDS,
  offers,
} from "../../lib/notifications.ts";

const COLUMN_LABEL: Record<NotifyMedium, MessageKey> = {
  in_app: "d7Notify.column.in_app",
  email: "d7Notify.column.email",
  push: "d7Notify.column.push",
};

/** Where each always-on row reaches the member (the rest show "–"). */
const ALWAYS_MEDIA: Record<AlwaysRow, readonly NotifyMedium[]> = {
  moderation: ["in_app", "email"],
  system: ["in_app", "email"],
  export: ["in_app", "email"],
  membership: ["in_app"],
  reports: ["in_app"],
  moderator: ["in_app"],
};

/** One column: the same width in the header and every row, so cells line up from `sm` up. */
const CELL = "flex w-20 flex-col items-center gap-1 text-center";

export interface PreferenceGridProps {
  /** Go-live (the page's own state, shared with the per-channel overrides). */
  goLive: NotificationPreferencesDto;
  onGoLive: (medium: NotifyMedium, enabled: boolean) => void;
  /** The other types; absent until they load (their rows wait), or when the page has none. */
  others: Partial<Record<OtherPreferenceType, NotificationPreferencesDto>> | null;
  onOther: (type: OtherPreferenceType, medium: NotifyMedium, enabled: boolean) => void;
  /** Shown under the rows while the other types load or failed. */
  othersStatus?: React.ReactNode;
}

export function PreferenceGrid({
  goLive,
  onGoLive,
  others,
  onOther,
  othersStatus,
}: PreferenceGridProps): React.JSX.Element {
  const pausedId = React.useId();
  const verified = goLive.emailVerified;
  return (
    <SettingsSection data-testid="notify-grid" title={t("d7Notify.grid.title")} description={t("d7Notify.grid.intro")}>
      <div aria-hidden className="hidden justify-end gap-2 px-6 py-2 text-xs text-muted-foreground sm:flex">
        {GRID_MEDIA.map((m) => (
          <span key={m} className={CELL}>
            {t(COLUMN_LABEL[m])}
          </span>
        ))}
      </div>
      {GRID_ROWS.map((row) => {
        const prefs = row.type === "go_live" ? goLive : (others?.[row.type] ?? null);
        if (prefs === null) return null;
        const label = t(row.label);
        return (
          <SettingsRow
            key={row.type}
            data-testid="notify-grid-row"
            data-type={row.type}
            label={label}
            hint={
              row.type === "digest_weekly" ? (
                <>
                  {t(row.hint)} {t("d7Notify.digest.consent")}
                </>
              ) : (
                t(row.hint)
              )
            }
          >
            {GRID_MEDIA.map((medium) => {
              const locked = LOCKED_CELLS[row.type]?.[medium];
              if (locked !== undefined) return <AlwaysCell key={medium} medium={medium} row={label} why={t(locked)} />;
              const testId = PREFERENCE_CELL_TEST_IDS[row.type][medium];
              if (!offers(row.type, medium) || testId === undefined) return <NoneCell key={medium} medium={medium} />;
              const checked = prefs.defaults[medium];
              const paused = medium === "email" && !verified;
              return (
                <span key={medium} className={CELL}>
                  <span className="text-xs text-muted-foreground sm:sr-only" aria-hidden>
                    {t(COLUMN_LABEL[medium])}
                  </span>
                  <CellSwitch
                    testId={testId}
                    data-state={checked ? "on" : "off"}
                    data-builtin={prefs.builtIn[medium] ? "true" : "false"}
                    aria-label={t("d7Notify.cell.switch", { row: label, medium: t(COLUMN_LABEL[medium]) })}
                    aria-describedby={paused ? pausedId : undefined}
                    checked={checked}
                    onCheckedChange={(on: boolean) =>
                      row.type === "go_live" ? onGoLive(medium, on) : onOther(row.type, medium, on)
                    }
                  />
                </span>
              );
            })}
          </SettingsRow>
        );
      })}
      {othersStatus ? <div className="px-4 py-4 sm:px-6">{othersStatus}</div> : null}
      {ALWAYS_ROWS.map((row) => (
        <SettingsRow key={row.id} data-testid="notify-always-row" data-row={row.id} label={t(row.label)}>
          {GRID_MEDIA.map((medium) =>
            ALWAYS_MEDIA[row.id].includes(medium) ? (
              <AlwaysCell key={medium} medium={medium} row={t(row.label)} why={t(row.why)} />
            ) : (
              <NoneCell key={medium} medium={medium} />
            ),
          )}
        </SettingsRow>
      ))}
      {!verified && (
        <div className="px-4 py-4 sm:px-6">
          <Alert data-testid="notify-email-unverified">
            <HugeiconsIcon icon={MailAtSign01Icon} strokeWidth={2} aria-hidden />
            <AlertDescription id={pausedId}>{t("notifySettings.emailUnverified")}</AlertDescription>
          </Alert>
        </div>
      )}
    </SettingsSection>
  );
}

type SwitchProps = Omit<React.ComponentProps<typeof Switch>, "data-testid">;

/**
 * One choosable cell. Each id is written out (not passed through) so the selector checks, which
 * read source, find every one; `PREFERENCE_CELL_TEST_IDS` lists the same ids for tests.
 */
function CellSwitch({ testId, ...props }: SwitchProps & { testId: string }): React.JSX.Element | null {
  switch (testId) {
    case "notify-default-in_app":
      return <Switch data-testid="notify-default-in_app" {...props} />;
    case "notify-default-email":
      return <Switch data-testid="notify-default-email" {...props} />;
    case "notify-default-push":
      return <Switch data-testid="notify-default-push" {...props} />;
    case "notify-pref-governance-in_app":
      return <Switch data-testid="notify-pref-governance-in_app" {...props} />;
    case "notify-pref-governance-email":
      return <Switch data-testid="notify-pref-governance-email" {...props} />;
    case "notify-pref-payout-email":
      return <Switch data-testid="notify-pref-payout-email" {...props} />;
    case "notify-pref-creator-in_app":
      return <Switch data-testid="notify-pref-creator-in_app" {...props} />;
    case "notify-pref-creator-email":
      return <Switch data-testid="notify-pref-creator-email" {...props} />;
    case "notify-pref-digest_weekly-email":
      return <Switch data-testid="notify-pref-digest_weekly-email" {...props} />;
    default:
      return null;
  }
}

function NoneCell({ medium }: { medium: NotifyMedium }): React.JSX.Element {
  return (
    <span className={CELL} data-testid="notify-cell-none">
      <span className="text-xs text-muted-foreground sm:sr-only" aria-hidden>
        {t(COLUMN_LABEL[medium])}
      </span>
      <span aria-hidden className="text-muted-foreground">
        –
      </span>
      <span className="sr-only">{t("d7Notify.cell.none", { medium: t(COLUMN_LABEL[medium]) })}</span>
    </span>
  );
}

function AlwaysCell({ medium, row, why }: { medium: NotifyMedium; row: string; why: string }): React.JSX.Element {
  const label = t("d7Notify.cell.alwaysLabel", { row, medium: t(COLUMN_LABEL[medium]), why });
  return (
    <span className={CELL}>
      <span className="text-xs text-muted-foreground sm:sr-only" aria-hidden>
        {t(COLUMN_LABEL[medium])}
      </span>
      <Tooltip>
        <TooltipTrigger
          data-testid="notify-cell-always"
          aria-label={label}
          className="inline-flex cursor-help items-center gap-1 text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <HugeiconsIcon icon={SquareLock02Icon} strokeWidth={2} aria-hidden className="size-3.5" />
          {t("d7Notify.cell.always")}
        </TooltipTrigger>
        <TooltipContent>{why}</TooltipContent>
      </Tooltip>
    </span>
  );
}
