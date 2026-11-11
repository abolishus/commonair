// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/admin` home (overhaul wave 4, D7.5, AA-11): one tile per queue the role can open (from
 * `admin.overview`), each linking to its queue, overdue and due-soon work called out in words and
 * colour, and (wave 5) when the next deadline falls; below them, for admins, the latest staff
 * actions from the audit log.
 */
import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { StatCard } from "@commonair/ui/blocks/data";

import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Alert02Icon, CheckmarkCircle02Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { Link, useNavigate } from "@tanstack/react-router";
import type { AdminQueue } from "@commonair/contracts/enums";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { useLoad } from "../money/use-load.ts";
import { isSafetyStaff, mayOpenAdminPage } from "../safety/access.ts";
import type { AdminQueueCountDto, AuditEntryDto, ConsoleClient } from "./console-client.ts";
import { QUEUE_HAS_DEADLINE, QUEUE_PAGE, auditActionLabel, queueLabel, subjectTypeLabel } from "./console-labels.ts";

/** How many staff actions the home lists (README D7.5: "the last 20"). */
export const RECENT_ACTIONS = 20;

type Me = { role: string } | null | undefined;

/** The queue's own page, filtered where the queue is one tab of a bigger page. */
function QueueLink({ queue, children }: { queue: AdminQueue; children: React.ReactNode }): React.JSX.Element {
  const props = { "data-testid": "admin-home-queue-link", "data-queue": queue } as const;
  switch (queue) {
    case "moderation":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/admin/moderation" />}>
          {children}
        </Button>
      );
    case "ncii":
      return (
        <Button
          variant="outline"
          size="sm"
          render={<Link {...props} to="/admin/moderation" search={{ tab: "ncii" }} />}
        >
          {children}
        </Button>
      );
    case "legal":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/admin/legal" />}>
          {children}
        </Button>
      );
    case "appeals":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/admin/appeals" />}>
          {children}
        </Button>
      );
    case "dmca":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/admin/dmca" />}>
          {children}
        </Button>
      );
    case "integrity":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/admin/integrity" />}>
          {children}
        </Button>
      );
    case "incidents":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/admin/incidents" />}>
          {children}
        </Button>
      );
    case "apps_review":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/admin/apps" />}>
          {children}
        </Button>
      );
    case "payments":
      return (
        <Button variant="outline" size="sm" render={<Link {...props} to="/treasury" />}>
          {children}
        </Button>
      );
  }
}

export function QueueTile({ count, me }: { count: AdminQueueCountDto; me: Me }): React.JSX.Element {
  const hot = count.overdue > 0;
  const clocked = QUEUE_HAS_DEADLINE[count.queue];
  return (
    <StatCard
      data-testid="admin-home-tile"
      data-queue={count.queue}
      data-open={count.open}
      data-overdue={count.overdue}
      data-due-soon={count.dueSoon}
      data-next-due={count.nextDueAt ?? undefined}
      tone={hot ? "destructive" : "default"}
      label={queueLabel(count.queue)}
      value={t("d7Admin.home.open", { count: count.open })}
      hint={
        count.oldestAt ? (
          <>
            {t("d7Admin.home.oldest")} <RelativeTime date={count.oldestAt} />
          </>
        ) : (
          t("d7Admin.home.nothingWaiting")
        )
      }
      footer={
        <>
          {clocked && (count.overdue > 0 || count.dueSoon > 0) ? (
            <div className="flex flex-wrap gap-2">
              {count.overdue > 0 ? (
                <StatusBadge tone="danger" icon={Alert02Icon}>
                  {t("d7Admin.home.overdue", { count: count.overdue })}
                </StatusBadge>
              ) : null}
              {count.dueSoon > 0 ? (
                <StatusBadge tone="warning" icon={Clock01Icon}>
                  {t("d7Admin.home.dueSoon", { count: count.dueSoon })}
                </StatusBadge>
              ) : null}
            </div>
          ) : null}
          {clocked && count.nextDueAt ? (
            <p className="text-sm text-muted-foreground">
              {t("w5Admin.home.nextDue")} <RelativeTime date={count.nextDueAt} />
            </p>
          ) : null}
          {count.unassigned !== null && count.open > 0 ? (
            <p className="text-xs text-muted-foreground">{t("d7Admin.home.unassigned", { count: count.unassigned })}</p>
          ) : null}
          {/* An admin sees the payments count but the treasury is the treasurer's page. */}
          {mayOpenAdminPage(QUEUE_PAGE[count.queue], me) ? (
            <div>
              <QueueLink queue={count.queue}>
                {t("d7Admin.home.openQueue", { queue: queueLabel(count.queue) })}
              </QueueLink>
            </div>
          ) : null}
        </>
      }
    />
  );
}

export function RecentActions({
  entries,
  names,
}: {
  entries: AuditEntryDto[];
  names: ReadonlyMap<string, string>;
}): React.JSX.Element {
  if (entries.length === 0)
    return (
      <EmptyState
        icon={CheckmarkCircle02Icon}
        title={t("d7Admin.home.recentEmpty")}
        description={t("d7Admin.home.recentEmptyHint")}
        headingLevel={3}
      />
    );
  return (
    <ItemGroup data-testid="admin-home-recent">
      {entries.map((a) => {
        const label = auditActionLabel(a.action);
        const actor = a.actorId ? (names.get(a.actorId) ?? t("d7Admin.audit.unknownActor")) : t("d7Admin.audit.system");
        return (
          <Item key={a.id} data-testid="admin-home-recent-row" data-action={a.action} size="xs" variant="outline">
            <ItemContent>
              <ItemTitle>{label ?? a.action}</ItemTitle>
              <ItemDescription>
                {t("d7Admin.home.recentLine", { actor, subject: subjectTypeLabel(a.subjectType) })}
              </ItemDescription>
              {label ? <span className="text-xs text-muted-foreground tabular-nums">{a.action}</span> : null}
            </ItemContent>
            <ItemActions>
              <RelativeTime date={a.createdAt} className="text-xs text-muted-foreground" />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

const USERNAME = /^[a-z0-9_]{3,25}$/;

/** Safety staff go from a name to the person's standing (`/admin/users/$username`). */
export function UserLookup(): React.JSX.Element {
  const navigate = useNavigate();
  const [value, setValue] = React.useState("");
  const username = value.trim().replace(/^@/, "").toLowerCase();
  const valid = USERNAME.test(username);
  return (
    <form
      data-testid="admin-home-lookup"
      className="flex min-w-0 flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void navigate({ to: "/admin/users/$username", params: { username } });
      }}
    >
      <Field className="min-w-0 flex-1">
        <FieldLabel htmlFor="admin-home-lookup-input">{t("d7Admin.home.lookupLabel")}</FieldLabel>
        <Input
          id="admin-home-lookup-input"
          data-testid="admin-home-lookup-input"
          maxLength={26}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <FieldDescription>{t("d7Admin.home.lookupHint")}</FieldDescription>
      </Field>
      <Button data-testid="admin-home-lookup-submit" type="submit" variant="outline" disabled={!valid}>
        {t("d7Admin.home.lookupSubmit")}
      </Button>
    </form>
  );
}

function Loading(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("d7Admin.home.loading")}>
      <SkeletonText lines={3} />
    </SkeletonGroup>
  );
}

export function AdminHome({ client, me }: { client: ConsoleClient; me: Me }): React.JSX.Element {
  const isAdmin = me?.role === "admin";
  const overview = useLoad("admin-overview", () => client.overview());
  const recent = useLoad(isAdmin ? "admin-recent" : "admin-recent-none", async () => {
    if (!isAdmin) return { entries: [], names: new Map<string, string>() };
    const page = await client.auditLog({});
    const entries = page.items.slice(0, RECENT_ACTIONS);
    const ids = entries.flatMap((a) => (a.actorId ? [a.actorId] : []));
    return { entries, names: ids.length ? await client.userNames(ids) : new Map<string, string>() };
  });
  return (
    <div data-testid="admin-home" className="flex flex-col gap-8">
      <Section heading={t("d7Admin.home.queues")}>
        {overview.data ? (
          overview.data.queues.length === 0 ? (
            <EmptyState
              icon={CheckmarkCircle02Icon}
              title={t("d7Admin.home.noQueues")}
              description={t("d7Admin.home.noQueuesHint")}
              headingLevel={3}
            />
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {overview.data.queues.map((q) => (
                <QueueTile key={q.queue} count={q} me={me} />
              ))}
            </div>
          )
        ) : overview.failed ? (
          <SectionLoadError section={t("d7Admin.home.queues")} load={overview} headingLevel={3} />
        ) : (
          <Loading />
        )}
      </Section>
      {isSafetyStaff(me) ? (
        <Section heading={t("d7Admin.home.lookup")}>
          <UserLookup />
        </Section>
      ) : null}
      {isAdmin ? (
        <Section
          heading={t("d7Admin.home.recent")}
          action={
            <Button variant="ghost" size="sm" render={<Link data-testid="admin-home-audit-link" to="/admin/audit" />}>
              {t("d7Admin.home.allActions")}
            </Button>
          }
        >
          {recent.data ? (
            <RecentActions entries={recent.data.entries} names={recent.data.names} />
          ) : recent.failed ? (
            <SectionLoadError section={t("d7Admin.home.recent")} load={recent} headingLevel={3} />
          ) : (
            <Loading />
          )}
        </Section>
      ) : null}
    </div>
  );
}
