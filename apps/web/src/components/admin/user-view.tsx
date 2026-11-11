// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/users/$username` (overhaul wave 4, D7.5): where staff go from a report to a person. The
 * account and its standing (`admin.user`), suspensions with suspend and lift (`safety.suspend`),
 * open reports and cases, statements of reasons, legal holds, the deletion and the audit trail.
 * The email is never loaded with the page: an admin reveals it with a reason (audited), and it
 * lives only in this component's state.
 */
import { ConfirmDialog, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { DangerZone, NoteDialog, SelectField, SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { NotFoundState } from "../not-found.tsx";
import { useLoad } from "../money/use-load.ts";
import { categoryLabel } from "../safety/labels.ts";
import type { AdminUserViewDto, ConsoleClient } from "./console-client.ts";
import { RecentActions } from "./overview.tsx";

const REASON_MAX = 2000;
const REVEAL_REASON_MAX = 500;

/** The guidelines clauses a staff suspension may cite (`illegal.ncii` is the NCII process's own). */
export const SUSPEND_CLAUSES = [
  "guidelines.general",
  "decency.harassment",
  "decency.hate",
  "decency.intimate-images",
  "honesty.spam",
  "honesty.impersonation",
  "safety.violence",
  "safety.minors",
  "safety.illegal-activity",
  "safety.sexual-explicit",
  "safety.graphic-violence",
  "safety.weapons",
  "safety.self-harm",
  "mature.unlabelled",
  "creative.copyright",
] as const;
type SuspendClause = (typeof SUSPEND_CLAUSES)[number];
const CLAUSE_LABEL: Record<SuspendClause, MessageKey> = {
  "guidelines.general": "d7Admin.clause.guidelinesGeneral",
  "decency.harassment": "d7Admin.clause.harassment",
  "decency.hate": "d7Admin.clause.hate",
  "decency.intimate-images": "d7Admin.clause.intimateImages",
  "honesty.spam": "d7Admin.clause.spam",
  "honesty.impersonation": "d7Admin.clause.impersonation",
  "safety.violence": "d7Admin.clause.violence",
  "safety.minors": "d7Admin.clause.minors",
  "safety.illegal-activity": "d7Admin.clause.illegalActivity",
  "safety.sexual-explicit": "d7Admin.clause.sexualExplicit",
  "safety.graphic-violence": "d7Admin.clause.graphicViolence",
  "safety.weapons": "d7Admin.clause.weapons",
  "safety.self-harm": "d7Admin.clause.selfHarm",
  "mature.unlabelled": "d7Admin.clause.matureUnlabelled",
  "creative.copyright": "d7Admin.clause.copyright",
};
const isClause = (v: string): v is SuspendClause => (SUSPEND_CLAUSES as readonly string[]).includes(v);

const DURATIONS = ["86400", "604800", "2592000", "indefinite"] as const;
const DURATION_LABEL: Record<(typeof DURATIONS)[number], MessageKey> = {
  "86400": "d7Admin.user.duration.day",
  "604800": "d7Admin.user.duration.week",
  "2592000": "d7Admin.user.duration.month",
  indefinite: "d7Admin.user.duration.indefinite",
};

type Me = { id: string; role: string } | null | undefined;

function SuspendForm({
  hasChannel,
  onSuspend,
}: {
  hasChannel: boolean;
  onSuspend: (input: {
    target: "user" | "channel";
    clauseId: string;
    reason: string;
    durationSeconds?: number;
  }) => Promise<void>;
}): React.JSX.Element {
  const [target, setTarget] = React.useState<"user" | "channel">("user");
  const [clause, setClause] = React.useState<SuspendClause>("guidelines.general");
  const [duration, setDuration] = React.useState<(typeof DURATIONS)[number]>("604800");
  const [reason, setReason] = React.useState("");
  const reasonId = React.useId();
  const ready = reason.trim() !== "";
  return (
    <div data-testid="admin-user-suspend-form" className="flex flex-col gap-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-3">
        <SelectField
          label={t("d7Admin.user.suspendTarget")}
          value={target}
          onValueChange={(v) => {
            if (v === "user" || (v === "channel" && hasChannel)) setTarget(v);
          }}
          options={[
            { value: "user", label: t("d7Admin.user.target.user") },
            ...(hasChannel ? [{ value: "channel", label: t("d7Admin.user.target.channel") }] : []),
          ]}
          triggerProps={{ "data-testid": "admin-user-suspend-target" }}
        />
        <SelectField
          label={t("d7Admin.user.clause")}
          value={clause}
          onValueChange={(v) => {
            if (isClause(v)) setClause(v);
          }}
          options={SUSPEND_CLAUSES.map((c) => ({ value: c, label: t(CLAUSE_LABEL[c]) }))}
          triggerProps={{ "data-testid": "admin-user-suspend-clause" }}
        />
        <SelectField
          label={t("d7Admin.user.duration")}
          value={duration}
          onValueChange={(v) => {
            const found = DURATIONS.find((d) => d === v);
            if (found) setDuration(found);
          }}
          options={DURATIONS.map((d) => ({ value: d, label: t(DURATION_LABEL[d]) }))}
          triggerProps={{ "data-testid": "admin-user-suspend-duration" }}
        />
      </div>
      <Field>
        <FieldLabel htmlFor={reasonId}>{t("d7Admin.user.reason")}</FieldLabel>
        <Textarea
          id={reasonId}
          data-testid="admin-user-suspend-reason"
          rows={3}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
        <FieldDescription>{t("d7Admin.user.reasonHint")}</FieldDescription>
      </Field>
      <div>
        <ConfirmDialog
          trigger={
            <Button data-testid="admin-user-suspend" variant="destructive" disabled={!ready}>
              {t("d7Admin.user.suspend")}
            </Button>
          }
          title={t("d7Admin.user.suspendConfirm")}
          description={t("d7Admin.user.suspendConfirmBody")}
          confirmLabel={t("d7Admin.user.suspend")}
          variant="destructive"
          onConfirm={async () => {
            await onSuspend({
              target,
              clauseId: clause,
              reason: reason.trim(),
              durationSeconds: duration === "indefinite" ? undefined : Number(duration),
            });
            setReason("");
          }}
          onError={(err) => toastActionError(err, t("d7Admin.user.suspendFailed"))}
        />
      </div>
    </div>
  );
}

function EmailReveal({ username, client }: { username: string; client: ConsoleClient }): React.JSX.Element {
  const [email, setEmail] = React.useState<string | null>(null);
  if (email !== null)
    return (
      <span data-testid="admin-user-email" className="break-all">
        {email}
      </span>
    );
  return (
    <NoteDialog
      trigger={
        <Button data-testid="admin-user-reveal" variant="outline" size="sm">
          {t("d7Admin.user.reveal")}
        </Button>
      }
      title={t("d7Admin.user.revealTitle")}
      description={t("d7Admin.user.revealBody")}
      noteLabel={t("d7Admin.user.revealReason")}
      noteRequired
      maxLength={REVEAL_REASON_MAX}
      submitLabel={t("d7Admin.user.reveal")}
      errorText={t("d7Admin.user.revealFailed")}
      noteProps={{ "data-testid": "admin-user-reveal-reason" }}
      submitProps={{ "data-testid": "admin-user-reveal-submit" }}
      onSubmit={async (reason) => {
        setEmail((await client.revealEmail(username, reason)).email);
      }}
    />
  );
}

function CaseRows({ cases }: { cases: AdminUserViewDto["openCases"] }): React.JSX.Element {
  if (cases.length === 0) return <p className="text-sm text-muted-foreground">{t("d7Admin.user.noCases")}</p>;
  return (
    <ItemGroup>
      {cases.map((c) => (
        <Item
          key={c.id}
          data-testid="admin-user-case"
          data-case-id={c.id}
          data-tier={c.tier}
          size="xs"
          variant="outline"
        >
          <ItemContent>
            <ItemTitle>{c.category ? categoryLabel(c.category) : t("d7Admin.user.caseNoCategory")}</ItemTitle>
            <ItemDescription>
              {t("d7Admin.user.caseLine", { tier: c.tier.toUpperCase(), status: c.status })}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <RelativeTime date={c.createdAt} className="text-xs text-muted-foreground" />
            {c.tier === "t0" ? (
              <Button variant="outline" size="sm" render={<Link to="/admin/legal" />}>
                {t("d7Admin.user.openCase")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" render={<Link to="/admin/moderation" search={{ case: c.id }} />}>
                {t("d7Admin.user.openCase")}
              </Button>
            )}
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}

export function UserStanding({
  view,
  me,
  client,
  onChanged,
  names,
}: {
  view: AdminUserViewDto;
  me: Me;
  client: ConsoleClient;
  onChanged: () => void;
  names: ReadonlyMap<string, string>;
}): React.JSX.Element {
  const { user, channel } = view;
  const isAdmin = me?.role === "admin";
  // `safety.suspend` is the platform moderators' and admins' (not `legal` alone).
  const maySuspend = me?.role === "admin" || me?.role === "moderator";
  const self = me?.id === user.id;
  const suspend = async (input: {
    target: "user" | "channel";
    clauseId: string;
    reason: string;
    durationSeconds?: number;
  }) => {
    await client.suspend({ username: user.username, suspended: true, ...input });
    toast.success(t("d7Admin.user.suspended"));
    onChanged();
  };
  return (
    <div data-testid="admin-user" data-user-id={user.id} className="flex flex-col gap-6">
      <SettingsSection title={t("d7Admin.user.account")}>
        <KeyValueList
          rows={[
            { term: t("d7Admin.user.username"), value: `@${user.username}` },
            { term: t("d7Admin.user.role"), value: user.role },
            { term: t("d7Admin.user.accountType"), value: user.accountType },
            { term: t("d7Admin.user.created"), value: <RelativeTime date={user.createdAt} /> },
            {
              term: t("d7Admin.user.emailVerified"),
              value: user.emailVerified ? t("d7Admin.user.yes") : t("d7Admin.user.no"),
            },
            {
              term: t("d7Admin.user.twoFactor"),
              value: user.twoFactorEnabled ? t("d7Admin.user.yes") : t("d7Admin.user.no"),
            },
            ...(channel
              ? [
                  {
                    term: t("d7Admin.user.channel"),
                    value: (
                      <Link className="underline" to="/$channel" params={{ channel: channel.slug }}>
                        {channel.displayName}
                      </Link>
                    ),
                  },
                ]
              : []),
            ...(user.deletedAt
              ? [{ term: t("d7Admin.user.deleted"), value: <RelativeTime date={user.deletedAt} /> }]
              : []),
          ]}
        />
        {isAdmin && !user.deletedAt ? (
          <SettingsRow label={t("d7Admin.user.email")} hint={t("d7Admin.user.emailHint")}>
            <EmailReveal username={user.username} client={client} />
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("d7Admin.user.standing")} description={t("d7Admin.user.standingHint")}>
        <KeyValueList
          rows={[
            { term: t("d7Admin.user.openReports"), value: t("d7Admin.user.reportsCount", { count: view.openReports }) },
            {
              term: t("d7Admin.user.statements"),
              value: t("d7Admin.user.statementsCount", { count: view.enforcement.length }),
            },
          ]}
        />
        {view.suspensions.length === 0 ? (
          <p data-testid="admin-user-not-suspended" className="text-sm text-muted-foreground">
            {t("d7Admin.user.notSuspended")}
          </p>
        ) : (
          <ItemGroup>
            {view.suspensions.map((s) => (
              <Item
                key={s.target}
                data-testid="admin-user-suspension"
                data-target={s.target}
                size="xs"
                variant="outline"
              >
                <ItemContent>
                  <ItemTitle>
                    <StatusBadge tone="danger">
                      {s.target === "user" ? t("d7Admin.user.suspendedUser") : t("d7Admin.user.suspendedChannel")}
                    </StatusBadge>
                  </ItemTitle>
                  <ItemDescription>
                    {t("d7Admin.user.since")} <RelativeTime date={s.since} />
                    {s.until ? (
                      <>
                        {t("common.listSeparator")}
                        {t("d7Admin.user.until")} <RelativeTime date={s.until} />
                      </>
                    ) : null}
                  </ItemDescription>
                </ItemContent>
                {maySuspend && !self ? (
                  <ItemActions>
                    <NoteDialog
                      trigger={
                        <Button data-testid="admin-user-unsuspend" variant="outline" size="sm">
                          {t("d7Admin.user.unsuspend")}
                        </Button>
                      }
                      title={t("d7Admin.user.unsuspendTitle")}
                      noteLabel={t("d7Admin.user.reason")}
                      noteRequired
                      maxLength={REASON_MAX}
                      submitLabel={t("d7Admin.user.unsuspend")}
                      errorText={t("d7Admin.user.unsuspendFailed")}
                      onSubmit={async (reason) => {
                        await client.suspend({ username: user.username, target: s.target, suspended: false, reason });
                        toast.success(t("d7Admin.user.unsuspended"));
                        onChanged();
                      }}
                    />
                  </ItemActions>
                ) : null}
              </Item>
            ))}
          </ItemGroup>
        )}
      </SettingsSection>

      <SettingsSection title={t("d7Admin.user.cases")}>
        <CaseRows cases={view.openCases} />
      </SettingsSection>

      <SettingsSection title={t("d7Admin.user.enforcement")}>
        {view.enforcement.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("d7Admin.user.noStatements")}</p>
        ) : (
          <ItemGroup>
            {view.enforcement.map((s) => (
              <Item
                key={s.id}
                data-testid="admin-user-statement"
                data-source-action={s.sourceAction}
                size="xs"
                variant="outline"
              >
                <ItemContent>
                  <ItemTitle>{s.sourceAction}</ItemTitle>
                  <ItemDescription>
                    {t("d7Admin.user.statementLine", {
                      kind: s.restriction.kind,
                      detail: s.restriction.detail,
                      clause: s.ground.clauseId,
                    })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <RelativeTime date={s.createdAt} className="text-xs text-muted-foreground" />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </SettingsSection>

      <SettingsSection title={t("d7Admin.user.holds")} description={t("d7Admin.user.holdsHint")}>
        {view.legalHolds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("d7Admin.user.noHolds")}</p>
        ) : (
          <ItemGroup>
            {view.legalHolds.map((h) => (
              <Item
                key={h.id}
                data-testid="admin-user-hold"
                data-reason-code={h.reasonCode}
                size="xs"
                variant="outline"
              >
                <ItemContent>
                  <ItemTitle>{h.reasonCode}</ItemTitle>
                  <ItemDescription>
                    {h.releasedAt ? t("d7Admin.user.holdReleased") : t("d7Admin.user.holdActive")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <RelativeTime date={h.createdAt} className="text-xs text-muted-foreground" />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </SettingsSection>

      <SettingsSection title={t("d7Admin.user.recentAudit")}>
        <RecentActions entries={view.recentAudit} names={names} />
      </SettingsSection>

      {maySuspend && !self && !user.deletedAt ? (
        <DangerZone title={t("d7Admin.user.danger")} description={t("d7Admin.user.dangerHint")}>
          <SuspendForm hasChannel={channel !== null} onSuspend={suspend} />
          {view.deletion ? (
            <p data-testid="admin-user-deletion" className="text-sm text-muted-foreground">
              {t("d7Admin.user.deletionScheduled")} <RelativeTime date={view.deletion.scheduledFor} />
            </p>
          ) : null}
        </DangerZone>
      ) : view.deletion ? (
        <p data-testid="admin-user-deletion" className="text-sm text-muted-foreground">
          {t("d7Admin.user.deletionScheduled")} <RelativeTime date={view.deletion.scheduledFor} />
        </p>
      ) : null}
    </div>
  );
}

export function AdminUserPage({
  username,
  client,
  me,
}: {
  username: string;
  client: ConsoleClient;
  me: Me;
}): React.JSX.Element {
  const [missing, setMissing] = React.useState(false);
  const loaded = useLoad(`admin-user|${username}`, async () => {
    try {
      const view = await client.user(username);
      const ids = view.recentAudit.flatMap((a) => (a.actorId ? [a.actorId] : []));
      return { view, names: ids.length ? await client.userNames(ids) : new Map<string, string>() };
    } catch (err) {
      if (errorCode(err) === "NOT_FOUND") setMissing(true);
      throw err;
    }
  });
  if (missing) return <NotFoundState />;
  if (loaded.data)
    return (
      <UserStanding
        view={loaded.data.view}
        names={loaded.data.names}
        me={me}
        client={client}
        onChanged={loaded.reload}
      />
    );
  if (loaded.failed) return <SectionLoadError section={t("d7Admin.user.title")} load={loaded} alone />;
  return (
    <SkeletonGroup label={t("d7Admin.user.loading")}>
      <SkeletonText lines={4} />
    </SkeletonGroup>
  );
}
