// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/audit` (overhaul wave 4, D7.5, AA-10): `safety.auditLog` as a table, newest first. The
 * actor, subject type and subject id filters go to the API; the date range filters the loaded
 * rows (the procedure has no time filter). CSV export writes the rows on screen, in the browser.
 */
import { RelativeTime } from "@commonair/ui";
import { DataTable, FilterBar, type DataTableColumn } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { DateTimeTextField } from "../forms/date-time-field.tsx";
import { usePaged } from "../money/use-load.ts";
import type { AuditEntryDto, AuditFilters, ConsoleClient } from "./console-client.ts";
import {
  AUDIT_SUBJECT_TYPES,
  auditActionLabel,
  isAuditSubjectType,
  shortId,
  subjectTypeLabel,
} from "./console-labels.ts";
import { fromUtcInput } from "./forms.ts";

const ALL = "all";
const SUBJECT_ID_MAX = 200;

/** Rows inside the range (either end may be open); ends are ISO strings. */
export function inRange(row: { createdAt: string }, from: string | null, to: string | null): boolean {
  const at = Date.parse(row.createdAt);
  if (from !== null && at < Date.parse(from)) return false;
  if (to !== null && at > Date.parse(to)) return false;
  return true;
}

/** One CSV cell: quoted when it holds a comma, quote or line break; a leading = + - @ is defused. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The loaded rows as CSV: time, actor, action, subject type, subject id, reason. */
export function auditCsv(rows: readonly AuditEntryDto[], names: ReadonlyMap<string, string>): string {
  const head = ["time", "actor_type", "actor", "action", "subject_type", "subject_id", "reason"];
  const lines = rows.map((r) =>
    [
      r.createdAt,
      r.actorType,
      r.actorId ? (names.get(r.actorId) ?? r.actorId) : "",
      r.action,
      r.subjectType,
      r.subjectId,
      r.reason,
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n");
}

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The subject, linked to the queue item or person it is about where the console has a page for it. */
export function AuditSubject({
  type,
  id,
  names,
}: {
  type: string;
  id: string;
  names: ReadonlyMap<string, string>;
}): React.JSX.Element {
  const label = `${subjectTypeLabel(type)} ${shortId(id)}`;
  const linkProps = {
    "data-testid": "admin-audit-subject",
    "data-subject-type": type,
    className: "underline",
  } as const;
  switch (type) {
    case "moderation_case":
      return (
        <Link {...linkProps} to="/admin/moderation" search={{ case: id }}>
          {label}
        </Link>
      );
    case "report":
      return (
        <Link {...linkProps} to="/admin/moderation" search={{ tab: "reports", case: id }}>
          {label}
        </Link>
      );
    case "ncii_request":
      return (
        <Link {...linkProps} to="/admin/moderation" search={{ tab: "ncii", case: id }}>
          {label}
        </Link>
      );
    case "appeal":
      return (
        <Link {...linkProps} to="/admin/appeals">
          {label}
        </Link>
      );
    case "dmca_notice":
      return (
        <Link {...linkProps} to="/admin/dmca">
          {label}
        </Link>
      );
    case "user": {
      const username = names.get(id);
      return username ? (
        <Link {...linkProps} to="/admin/users/$username" params={{ username }}>
          {`${subjectTypeLabel(type)} @${username}`}
        </Link>
      ) : (
        <span>{label}</span>
      );
    }
    default:
      return <span>{label}</span>;
  }
}

function columns(names: ReadonlyMap<string, string>): DataTableColumn<AuditEntryDto>[] {
  return [
    {
      id: "time",
      header: t("d7Admin.audit.col.time"),
      cell: ({ row }) => <RelativeTime date={row.original.createdAt} />,
    },
    {
      id: "actor",
      header: t("d7Admin.audit.col.actor"),
      cell: ({ row }) => {
        const a = row.original;
        if (!a.actorId) return <span className="text-muted-foreground">{t("d7Admin.audit.system")}</span>;
        const username = names.get(a.actorId);
        return username ? (
          <Link className="underline" to="/admin/users/$username" params={{ username }}>
            {`@${username}`}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("d7Admin.audit.unknownActor")}</span>
        );
      },
    },
    {
      id: "action",
      header: t("d7Admin.audit.col.action"),
      cell: ({ row }) => {
        const label = auditActionLabel(row.original.action);
        return (
          <div className="flex flex-col">
            <span>{label ?? row.original.action}</span>
            {label ? <span className="text-xs text-muted-foreground tabular-nums">{row.original.action}</span> : null}
          </div>
        );
      },
    },
    {
      id: "subject",
      header: t("d7Admin.audit.col.subject"),
      cell: ({ row }) => <AuditSubject type={row.original.subjectType} id={row.original.subjectId} names={names} />,
    },
    {
      id: "reason",
      header: t("d7Admin.audit.col.reason"),
      cell: ({ row }) => <span className="break-words">{row.original.reason}</span>,
    },
  ];
}

interface Draft {
  actor: string;
  subjectType: string;
  subjectId: string;
  from: string;
  to: string;
}
const EMPTY: Draft = { actor: "", subjectType: ALL, subjectId: "", from: "", to: "" };

export function AuditLog({ client, now }: { client: ConsoleClient; now?: Date }): React.JSX.Element {
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [applied, setApplied] = React.useState<{ filters: AuditFilters; from: string | null; to: string | null }>({
    filters: {},
    from: null,
    to: null,
  });
  const [actorError, setActorError] = React.useState<string | null>(null);
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [names, setNames] = React.useState<ReadonlyMap<string, string>>(new Map());
  const key = `audit|${JSON.stringify(applied.filters)}`;
  const paged = usePaged(
    key,
    async (cursor) => {
      const page = await client.auditLog(applied.filters, cursor);
      const ids = [
        ...page.items.flatMap((a) => (a.actorId ? [a.actorId] : [])),
        ...page.items.flatMap((a) => (a.subjectType === "user" ? [a.subjectId] : [])),
      ];
      const found = ids.length ? await client.userNames(ids) : new Map<string, string>();
      setNames((prev) => new Map([...prev, ...found]));
      return page;
    },
    () => toast.error(t("d7Admin.audit.moreFailed")),
  );
  const rows = (paged.items ?? []).filter((r) => inRange(r, applied.from, applied.to));
  const cols = React.useMemo(() => columns(names), [names]);

  const apply = async () => {
    setActorError(null);
    setRangeError(null);
    const from = draft.from ? fromUtcInput(draft.from) : null;
    const to = draft.to ? fromUtcInput(draft.to) : null;
    if ((draft.from && from === null) || (draft.to && to === null))
      return setRangeError(t("d7Admin.audit.rangeInvalid"));
    if (from !== null && to !== null && Date.parse(from) > Date.parse(to))
      return setRangeError(t("d7Admin.audit.rangeOrder"));
    const filters: AuditFilters = {};
    if (isAuditSubjectType(draft.subjectType)) filters.subjectType = draft.subjectType;
    if (draft.subjectId.trim()) filters.subjectId = draft.subjectId.trim();
    const actor = draft.actor.trim().replace(/^@/, "").toLowerCase();
    if (actor) {
      setApplying(true);
      try {
        filters.actorId = (await client.user(actor)).user.id;
      } catch (err) {
        setApplying(false);
        return setActorError(
          errorCode(err) === "NOT_FOUND" ? t("d7Admin.audit.actorUnknown") : t("d7Admin.audit.actorFailed"),
        );
      }
      setApplying(false);
    }
    setApplied({ filters, from, to });
  };
  const clear = () => {
    setDraft(EMPTY);
    setActorError(null);
    setRangeError(null);
    setApplied({ filters: {}, from: null, to: null });
  };

  return (
    <div data-testid="admin-audit" className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <FilterBar
          data-testid="admin-audit-filters"
          searchLabel={t("d7Admin.audit.actor")}
          searchValue={draft.actor}
          onSearchChange={(actor) => setDraft((d) => ({ ...d, actor }))}
          searchInputProps={{ "data-testid": "admin-audit-actor", maxLength: 40, name: "actor" }}
          filters={[
            {
              id: "admin-audit-subject-type",
              label: t("d7Admin.audit.subjectType"),
              value: draft.subjectType,
              onValueChange: (subjectType) => setDraft((d) => ({ ...d, subjectType })),
              options: [
                { value: ALL, label: t("d7Admin.audit.subjectTypeAll") },
                ...AUDIT_SUBJECT_TYPES.map((s) => ({ value: s, label: subjectTypeLabel(s) })),
              ],
              "data-testid": "admin-audit-subject-type",
            },
          ]}
        />
        {actorError ? <FieldError>{actorError}</FieldError> : null}
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="admin-audit-subject-id">{t("d7Admin.audit.subjectId")}</FieldLabel>
            <Input
              id="admin-audit-subject-id"
              data-testid="admin-audit-subject-id"
              maxLength={SUBJECT_ID_MAX}
              value={draft.subjectId}
              onChange={(e) => {
                const subjectId = e.currentTarget.value;
                setDraft((d) => ({ ...d, subjectId }));
              }}
            />
          </Field>
          <DateTimeTextField
            data-testid="admin-audit-from"
            legend={t("d7Admin.audit.from")}
            value={draft.from}
            clearable
            invalid={rangeError !== null}
            now={now}
            onValueChange={(from) => setDraft((d) => ({ ...d, from }))}
          />
          <DateTimeTextField
            data-testid="admin-audit-to"
            legend={t("d7Admin.audit.to")}
            value={draft.to}
            clearable
            invalid={rangeError !== null}
            now={now}
            onValueChange={(to) => setDraft((d) => ({ ...d, to }))}
          />
        </div>
        {rangeError ? <FieldError>{rangeError}</FieldError> : null}
        <p className="text-xs text-muted-foreground">{t("d7Admin.audit.rangeHint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="admin-audit-apply" type="submit" disabled={applying} aria-busy={applying || undefined}>
            {t("d7Admin.audit.apply")}
          </Button>
          <Button type="button" variant="ghost" onClick={clear}>
            {t("d7Admin.audit.clear")}
          </Button>
          <Button
            data-testid="admin-audit-export"
            type="button"
            variant="outline"
            className="ms-auto"
            disabled={rows.length === 0}
            onClick={() => download(auditCsv(rows, names), "audit-log.csv")}
          >
            <HugeiconsIcon icon={Download01Icon} strokeWidth={2} aria-hidden />
            {t("d7Admin.audit.export", { count: rows.length })}
          </Button>
        </div>
      </form>
      {paged.failed && !paged.items ? (
        <SectionLoadError section={t("d7Admin.audit.title")} load={paged.first} headingLevel={2} />
      ) : (
        <DataTable
          data-testid="admin-audit-table"
          caption={t("d7Admin.audit.caption")}
          columns={cols}
          rows={rows}
          loading={paged.items === null}
          getRowId={(r) => r.id}
          rowProps={(r) => ({
            "data-testid": "admin-audit-row",
            "data-action": r.action,
            "data-subject-type": r.subjectType,
          })}
          empty={t("d7Admin.audit.empty")}
        />
      )}
      {paged.hasMore ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="admin-audit-more"
            disabled={paged.loadingMore}
            aria-busy={paged.loadingMore || undefined}
            onClick={paged.loadMore}
          >
            {t("d7Admin.audit.more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
