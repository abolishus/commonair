// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearse page's content (W2-rehearsal; docs/testing/w2-selectors.md "Rehearsal"), drawn from
 * props so tests render every state: arm with the countdown, the stream key reminder, invitees,
 * the live checklist, the owner's player and the report.
 */
import {
  ConfirmDialog,
  EmptyState,
  formatDuration,
  formatInteger,
  IconButton,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  useLocale,
  type StatusTone,
} from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Cancel01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import type { RehearsalReport, RehearsalStatus } from "@commonair/contracts/dto";
import { t } from "../../i18n/index.ts";
import { FormError } from "../form-error.tsx";
import {
  CHECK_KEYS,
  CHECK_STATE_KEYS,
  checklist,
  dips,
  ENDED_BY_KEYS,
  endedBy,
  MAX_INVITEES,
  remainingSeconds,
  RULE_KEYS,
  RULES,
  total,
  viewState,
  type CheckState,
  type ViewState,
} from "./lib.ts";

export interface RehearsalPanelProps {
  /** Null while the first status loads. */
  status: RehearsalStatus | null;
  report: RehearsalReport | null;
  nowMs: number;
  /** The active stream key's prefix; null without a key, undefined while it loads. */
  keyPrefix: string | null | undefined;
  /** Followers the picker suggests (not excluded, not invited yet). */
  suggestions: readonly string[];
  loadFailed: boolean;
  /** The channel invitees watch (`/rehearse?channel=…`). */
  channel: string;
  /** The absolute link invitees open, shown as text. */
  watchHref: string;
  /** The owner's player, shown while rehearsing. */
  player?: React.ReactNode;
  onArm(): Promise<void>;
  onDisarm(): Promise<void>;
  onInvite(username: string): Promise<void>;
  onRemove(username: string): Promise<void>;
}

const STATUS_TONE: Record<ViewState, StatusTone> = {
  idle: "neutral",
  armed: "info",
  rehearsing: "warning",
  ended: "neutral",
};

export function RehearsalPanel(props: RehearsalPanelProps): React.JSX.Element {
  const { status, report } = props;
  const view = viewState(status, report);
  return (
    <div data-testid="rehearse-page" className="flex min-w-0 flex-col gap-6">
      {props.loadFailed && <FormError>{t("rehearsal.loadFailed")}</FormError>}
      <StatusCard {...props} view={view} />
      <InviteesCard {...props} />
      {view === "rehearsing" && props.player}
      {(view === "armed" || view === "rehearsing" || report) && <Checklist report={report} />}
      {report && <ReportCard report={report} />}
    </div>
  );
}

function StatusCard(props: RehearsalPanelProps & { view: ViewState }): React.JSX.Element {
  const { status, view, nowMs } = props;
  const remaining = remainingSeconds(status, nowMs);
  const label =
    view === "armed"
      ? t("rehearsal.status.armed", { time: formatDuration(remaining ?? 0) })
      : view === "rehearsing"
        ? t("rehearsal.status.rehearsing", { time: formatDuration(remaining ?? 0) })
        : view === "ended"
          ? t("rehearsal.status.ended")
          : t("rehearsal.status.idle");
  const canArm = status !== null && status.state === "idle";
  const disarmLabel = view === "rehearsing" ? t("rehearsal.endNow") : t("rehearsal.disarm");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("rehearsal.status.title")}</CardTitle>
        <CardDescription>{t("rehearsal.armHint")}</CardDescription>
        <CardAction>
          {status ? (
            <StatusBadge
              tone={STATUS_TONE[view]}
              data-testid="rehearsal-status"
              data-state={view}
              data-remaining-seconds={remaining === null ? "" : String(remaining)}
            >
              {label}
            </StatusBadge>
          ) : (
            <SkeletonGroup label={t("rehearsal.loading")}>
              <SkeletonText lines={1} />
            </SkeletonGroup>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <KeyReminder keyPrefix={props.keyPrefix} />
        <div className="flex flex-wrap gap-2">
          {canArm && (
            <Button data-testid="rehearsal-arm" onClick={() => void props.onArm()}>
              {t("rehearsal.arm")}
            </Button>
          )}
          {status && status.state !== "idle" && (
            <ConfirmDialog
              trigger={
                <Button data-testid="rehearsal-disarm" variant="outline">
                  {disarmLabel}
                </Button>
              }
              title={view === "rehearsing" ? t("rehearsal.disarmTitle") : t("rehearsal.disarmArmedTitle")}
              description={view === "rehearsing" ? t("rehearsal.disarmBody") : t("rehearsal.disarmArmedBody")}
              confirmLabel={disarmLabel}
              variant="destructive"
              onConfirm={() => props.onDisarm()}
              contentProps={{ "data-testid": "rehearsal-disarm-confirm" }}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The key line is a note: the card's hint size under a label, not a larger body size (F35). */
function KeyReminder({ keyPrefix }: { keyPrefix: string | null | undefined }): React.JSX.Element {
  return (
    <div data-testid="rehearsal-key-reminder" className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-medium">{t("rehearsal.key.title")}</span>
      {keyPrefix === undefined ? (
        <SkeletonText lines={1} />
      ) : keyPrefix === null ? (
        <FieldDescription>
          {t("rehearsal.key.none")}{" "}
          <Link to="/dashboard" className="underline">
            {t("rehearsal.key.dashboard")}
          </Link>
        </FieldDescription>
      ) : (
        <FieldDescription className="break-words">
          {t("rehearsal.key.reminder", { prefix: keyPrefix })}
        </FieldDescription>
      )}
    </div>
  );
}

function InviteesCard(props: RehearsalPanelProps): React.JSX.Element {
  const { status } = props;
  const inputId = React.useId();
  const hintId = React.useId();
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const invitees = status?.invitees ?? [];
  const armed = status !== null && status.state !== "idle";
  const full = invitees.length >= MAX_INVITEES;
  const add = async (username: string) => {
    const u = username.trim().toLowerCase();
    if (!u || busy) return;
    setBusy(true);
    try {
      await props.onInvite(u);
      setName("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("rehearsal.invitees.title")}</CardTitle>
        <CardDescription>{t("rehearsal.invitees.hint", { max: MAX_INVITEES })}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {!armed && <FieldDescription className="nth-last-2:mt-0">{t("rehearsal.invitees.notArmed")}</FieldDescription>}
        {armed && invitees.length === 0 && (
          <EmptyState
            icon={UserGroupIcon}
            title={t("rehearsal.invitees.empty")}
            description={t("rehearsal.invitees.emptyHint")}
            headingLevel={3}
          />
        )}
        {invitees.length > 0 && (
          <ul className="flex min-w-0 flex-col gap-2" aria-label={t("rehearsal.invitees.title")}>
            {invitees.map((i) => (
              <li
                key={i.id}
                data-testid="rehearsal-invitee"
                data-username={i.username}
                className="flex min-w-0 items-center justify-between gap-2"
              >
                <span className="min-w-0 truncate">{i.displayName}</span>
                <IconButton
                  data-testid="rehearsal-invitee-remove"
                  label={t("rehearsal.invitees.remove", { username: i.username })}
                  icon={Cancel01Icon}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void props.onRemove(i.username)}
                />
              </li>
            ))}
          </ul>
        )}
        {full ? (
          <FieldDescription data-testid="rehearsal-invitee-limit" className="nth-last-2:mt-0">
            {t("rehearsal.invitees.limit", { max: MAX_INVITEES })}
          </FieldDescription>
        ) : (
          armed && (
            <form
              className="flex min-w-0 flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add(name);
              }}
            >
              <Field>
                <FieldLabel htmlFor={inputId}>{t("rehearsal.invitees.label")}</FieldLabel>
                <div className="flex min-w-0 gap-2">
                  <Input
                    id={inputId}
                    data-testid="rehearsal-invitee-input"
                    autoComplete="off"
                    spellCheck={false}
                    value={name}
                    aria-describedby={hintId}
                    onChange={(e) => setName(e.currentTarget.value)}
                    className="min-w-0 flex-1"
                  />
                  <Button data-testid="rehearsal-invitee-add" type="submit" disabled={busy || name.trim() === ""}>
                    {t("rehearsal.invitees.add")}
                  </Button>
                </div>
                <FieldDescription id={hintId}>{t("rehearsal.invitees.inputHint")}</FieldDescription>
              </Field>
              {props.suggestions.length > 0 && (
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs/relaxed text-muted-foreground">{t("rehearsal.invitees.suggestions")}</span>
                  <div className="flex flex-wrap gap-1">
                    {props.suggestions.slice(0, 12).map((u) => (
                      <Button key={u} type="button" variant="outline" size="sm" onClick={() => setName(u)}>
                        {u}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </form>
          )
        )}
        {armed && (
          <FieldDescription className="break-words nth-last-2:mt-0">
            {t("rehearsal.invitees.watchLink")}{" "}
            <Link to="/rehearse" search={{ channel: props.channel }} className="break-all underline">
              {props.watchHref}
            </Link>
          </FieldDescription>
        )}
      </CardContent>
    </Card>
  );
}

const STATE_TONE: Record<CheckState, StatusTone> = { pending: "neutral", ok: "success", warn: "warning" };

function Checklist({ report }: { report: RehearsalReport | null }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("rehearsal.checklist.title")}</CardTitle>
        <CardDescription>{t("rehearsal.checklist.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul data-testid="rehearsal-checklist" aria-live="polite" className="flex min-w-0 flex-col gap-2">
          {checklist(report).map((c) => (
            <li
              key={c.check}
              data-testid="rehearsal-check"
              data-check={c.check}
              data-state={c.state}
              className="flex min-w-0 items-center justify-between gap-2"
            >
              <span className="min-w-0">{t(CHECK_KEYS[c.check])}</span>
              <StatusBadge tone={STATE_TONE[c.state]}>{t(CHECK_STATE_KEYS[c.state])}</StatusBadge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ReportCard({ report }: { report: RehearsalReport }): React.JSX.Element {
  const { locale } = useLocale();
  const by = endedBy(report.endReason);
  const held = total(report.chat.held);
  const rejected = total(report.chat.rejected);
  const dipRows = dips(report);
  const n = (v: number) => formatInteger(v, locale);
  return (
    <Card data-testid="rehearsal-report" data-ended-by={by ?? ""}>
      <CardHeader>
        <CardTitle>{t("rehearsal.report.title")}</CardTitle>
        <CardDescription>
          {t("rehearsal.report.startedAt")} <RelativeTime date={report.startedAt} />
          {" · "}
          {by ? t(ENDED_BY_KEYS[by]) : t("rehearsal.report.running")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        {by === "safety" ? (
          <p className="text-sm">{t("rehearsal.report.safety")}</p>
        ) : (
          <>
            <section
              data-testid="rehearsal-report-chat"
              data-accepted={String(report.chat.accepted)}
              data-held={String(held)}
              data-rejected={String(rejected)}
              className="flex min-w-0 flex-col gap-2"
            >
              <h3 className="text-sm font-medium">{t("rehearsal.report.chat.title")}</h3>
              <p className="text-sm text-muted-foreground">
                {t("rehearsal.report.chat.summary", {
                  accepted: n(report.chat.accepted),
                  held: n(held),
                  rejected: n(rejected),
                })}
              </p>
              <KeyValueList
                dense
                rows={RULES.map((r) => ({
                  term: t(RULE_KEYS[r]),
                  value: t("rehearsal.report.chat.rule", {
                    held: n(report.chat.held[r]),
                    rejected: n(report.chat.rejected[r]),
                  }),
                }))}
              />
            </section>
            <section
              data-testid="rehearsal-report-ingest"
              data-dips={String(dipRows.length)}
              className="flex min-w-0 flex-col gap-2"
            >
              <h3 className="text-sm font-medium">{t("rehearsal.report.ingest.title")}</h3>
              {dipRows.length === 0 ? (
                <p className="flex items-center gap-1 text-sm text-muted-foreground">
                  {report.ingest.length === 0
                    ? t("rehearsal.report.ingest.noSamples")
                    : t("rehearsal.report.ingest.noDips")}
                </p>
              ) : (
                <ul className="flex min-w-0 flex-col gap-1 text-sm">
                  {dipRows.map((d) => (
                    <li key={`${d.kind}:${d.at}`} data-testid="rehearsal-report-dip" data-at={d.at} data-kind={d.kind}>
                      {d.kind === "bitrate"
                        ? t("rehearsal.report.dip.bitrate", {
                            at: formatDuration(d.offsetSeconds),
                            seconds: n(d.seconds),
                          })
                        : t("rehearsal.report.dip.other", {
                            check: t(CHECK_KEYS[d.kind]),
                            at: formatDuration(d.offsetSeconds),
                            seconds: n(d.seconds),
                          })}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-medium">{t("rehearsal.report.moderation.title")}</h3>
              <p className="text-sm text-muted-foreground">
                {report.moderation.flagged
                  ? t("rehearsal.report.moderation.flagged")
                  : t("rehearsal.report.moderation.clean")}
              </p>
            </section>
            <section className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-medium">{t("rehearsal.report.watched.title")}</h3>
              {report.inviteesWatched.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("rehearsal.report.watched.none")}</p>
              ) : (
                <ul className="flex flex-wrap gap-2 text-sm">
                  {report.inviteesWatched.map((u) => (
                    <li key={u.id}>
                      <StatusBadge tone="success">{u.username}</StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
