// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/audit` (overhaul wave 4, D7.5, AA-10): `safety.auditLog` as a table, newest first. Every
 * filter (actor, subject type and id, and since wave 5 a UTC date range) lives in the URL search
 * and goes to the API, so a link reproduces the view. CSV export writes the loaded rows, which are
 * already inside the range, in the browser.
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
import { usePaged } from "../money/use-load.ts";
import type { AuditEntryDto, AuditFilters, ConsoleClient } from "./console-client.ts";
import {
  AUDIT_SUBJECT_TYPES,
  auditActionLabel,
  isAuditSubjectType,
  shortId,
  subjectTypeLabel,
} from "./console-labels.ts";

const ALL = "all";
const SUBJECT_ID_MAX = 200;
const USERNAME = /^[a-z0-9_]{3,25}$/;
const DAY_MS = 86_400_000;

/** The page's URL search: the filters as typed (the actor by username), dates as UTC `YYYY-MM-DD`. */
export interface AuditSearch {
  actor?: string;
  type?: string;
  subject?: string;
  from?: string;
  to?: string;
}

/** A real calendar date written `YYYY-MM-DD`. */
export function isUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** A typed username as the API knows it ("@Mara" is "mara"), or null when it cannot be one. */
export function normalizeActor(value: string): string | null {
  const name = value.trim().replace(/^@/, "").toLowerCase();
  return USERNAME.test(name) ? name : null;
}

/** `validateSearch`: anything malformed is dropped, never trusted; a reversed range keeps `from`. */
export function parseAuditSearch(raw: Record<string, unknown>): AuditSearch {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const out: AuditSearch = {};
  const actor = normalizeActor(str(raw.actor));
  if (actor) out.actor = actor;
  const type = str(raw.type);
  if (isAuditSubjectType(type)) out.type = type;
  const subject = str(raw.subject);
  if (subject && subject.length <= SUBJECT_ID_MAX) out.subject = subject;
  const from = str(raw.from);
  const to = str(raw.to);
  if (isUtcDate(from)) out.from = from;
  if (isUtcDate(to) && !(out.from && to < out.from)) out.to = to;
  return out;
}

/**
 * The API's range for the chosen days: from the start of `from` (inclusive) to the start of the
 * day after `to` (exclusive), so the To day is included and `from` is always before `to`.
 */
export function apiRange(search: Pick<AuditSearch, "from" | "to">): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (search.from) out.from = `${search.from}T00:00:00.000Z`;
  if (search.to) out.to = new Date(Date.parse(`${search.to}T00:00:00.000Z`) + DAY_MS).toISOString();
  return out;
}

/** The API filters for a search, once its actor (if any) is resolved to an id. */
export function auditFilters(search: AuditSearch, actorId: string | undefined): AuditFilters {
  const filters: AuditFilters = {};
  if (actorId) filters.actorId = actorId;
  if (search.type) filters.subjectType = search.type;
  if (search.subject) filters.subjectId = search.subject;
  return { ...filters, ...apiRange(search) };
}

/** The export's file name, naming the range when there is one. */
export function csvFilename(search: Pick<AuditSearch, "from" | "to">): string {
  return `audit-log${search.from ? `-from-${search.from}` : ""}${search.to ? `-to-${search.to}` : ""}.csv`;
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
        <Link {...linkProps} to="/admin/appeals" search={{ case: id }}>
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
const draftOf = (s: AuditSearch): Draft => ({
  actor: s.actor ?? "",
  subjectType: s.type ?? ALL,
  subjectId: s.subject ?? "",
  from: s.from ?? "",
  to: s.to ?? "",
});

const actorErrorText = (err: unknown) =>
  errorCode(err) === "NOT_FOUND" ? t("d7Admin.audit.actorUnknown") : t("d7Admin.audit.actorFailed");

const NO_SEARCH: AuditSearch = {};

export interface AuditLogProps {
  client: ConsoleClient;
  /** The filters from the URL (`parseAuditSearch`); none by default. */
  search?: AuditSearch;
  /** Applying or clearing writes the filters back to the URL. */
  onSearchChange?: (search: AuditSearch) => void;
}

export function AuditLog({ client, search: incoming = NO_SEARCH, onSearchChange }: AuditLogProps): React.JSX.Element {
  const incomingKey = JSON.stringify(incoming);
  const [current, setCurrent] = React.useState<AuditSearch>(incoming);
  const [seenKey, setSeenKey] = React.useState(incomingKey);
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(incoming));
  const [actorError, setActorError] = React.useState<string | null>(null);
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  if (seenKey !== incomingKey) {
    // The URL changed from outside (back, a link): it replaces what is applied and typed.
    setSeenKey(incomingKey);
    setCurrent(incoming);
    setDraft(draftOf(incoming));
    setActorError(null);
    setRangeError(null);
  }
  const [applying, setApplying] = React.useState(false);
  const [names, setNames] = React.useState<ReadonlyMap<string, string>>(new Map());
  const [actorIds, setActorIds] = React.useState<ReadonlyMap<string, string>>(new Map());
  const actor = current.actor;
  const actorId = actor ? actorIds.get(actor) : undefined;

  // An actor from the URL is resolved here once; one typed and applied was resolved before applying.
  React.useEffect(() => {
    if (!actor || actorIds.has(actor)) return;
    let live = true;
    client.user(actor).then(
      (v) => {
        if (live) setActorIds((m) => new Map(m).set(actor, v.user.id));
      },
      (err: unknown) => {
        if (live) setActorError(actorErrorText(err));
      },
    );
    return () => {
      live = false;
    };
  }, [client, actor, actorIds]);

  const ready = !actor || actorId !== undefined;
  const filters = auditFilters(current, actorId);
  const key = ready ? `audit|${JSON.stringify(filters)}` : `audit|actor|${actor ?? ""}`;
  const paged = usePaged(
    key,
    async (cursor) => {
      // Until the actor resolves there is nothing to ask for: never list unfiltered by mistake.
      if (!ready) return { items: [], nextCursor: null };
      const page = await client.auditLog(filters, cursor);
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
  const rows = ready ? (paged.items ?? []) : [];
  const loading = ready ? paged.items === null : actorError === null;
  const cols = React.useMemo(() => columns(names), [names]);

  const commit = (next: AuditSearch) => {
    // The URL catches up through `search` (which then matches); without a router it stays local.
    setCurrent(next);
    onSearchChange?.(next);
  };

  const apply = async () => {
    setActorError(null);
    setRangeError(null);
    const from = draft.from.trim();
    const to = draft.to.trim();
    if ((from && !isUtcDate(from)) || (to && !isUtcDate(to))) return setRangeError(t("w5Admin.audit.dateInvalid"));
    if (from && to && to < from) return setRangeError(t("w5Admin.audit.rangeOrder"));
    const next: AuditSearch = {};
    if (draft.actor.trim()) {
      const name = normalizeActor(draft.actor);
      if (!name) return setActorError(t("d7Admin.audit.actorUnknown"));
      if (!actorIds.has(name)) {
        setApplying(true);
        try {
          const id = (await client.user(name)).user.id;
          setActorIds((m) => new Map(m).set(name, id));
        } catch (err) {
          return setActorError(actorErrorText(err));
        } finally {
          setApplying(false);
        }
      }
      next.actor = name;
    }
    if (isAuditSubjectType(draft.subjectType)) next.type = draft.subjectType;
    if (draft.subjectId.trim()) next.subject = draft.subjectId.trim();
    if (from) next.from = from;
    if (to) next.to = to;
    commit(next);
  };
  const clear = () => {
    setDraft(draftOf(NO_SEARCH));
    setActorError(null);
    setRangeError(null);
    commit({});
  };
  const describedBy = rangeError ? "admin-audit-range-hint admin-audit-range-error" : "admin-audit-range-hint";

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
          onSearchChange={(next) => setDraft((d) => ({ ...d, actor: next }))}
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
          <Field data-invalid={rangeError !== null || undefined}>
            <FieldLabel htmlFor="admin-audit-from">{t("w5Admin.audit.from")}</FieldLabel>
            <Input
              id="admin-audit-from"
              data-testid="admin-audit-from"
              name="from"
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
              placeholder={t("w5Admin.audit.datePlaceholder")}
              aria-describedby={describedBy}
              aria-invalid={rangeError !== null || undefined}
              value={draft.from}
              onChange={(e) => {
                const from = e.currentTarget.value;
                setDraft((d) => ({ ...d, from }));
              }}
            />
          </Field>
          <Field data-invalid={rangeError !== null || undefined}>
            <FieldLabel htmlFor="admin-audit-to">{t("w5Admin.audit.to")}</FieldLabel>
            <Input
              id="admin-audit-to"
              data-testid="admin-audit-to"
              name="to"
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
              placeholder={t("w5Admin.audit.datePlaceholder")}
              aria-describedby={describedBy}
              aria-invalid={rangeError !== null || undefined}
              value={draft.to}
              onChange={(e) => {
                const to = e.currentTarget.value;
                setDraft((d) => ({ ...d, to }));
              }}
            />
          </Field>
        </div>
        {rangeError ? <FieldError id="admin-audit-range-error">{rangeError}</FieldError> : null}
        <p id="admin-audit-range-hint" className="text-sm text-muted-foreground">
          {t("w5Admin.audit.rangeHint")}
        </p>
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
            onClick={() => download(auditCsv(rows, names), csvFilename(current))}
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
          loading={loading}
          getRowId={(r) => r.id}
          rowProps={(r) => ({
            "data-testid": "admin-audit-row",
            "data-action": r.action,
            "data-subject-type": r.subjectType,
          })}
          empty={t("d7Admin.audit.empty")}
        />
      )}
      {ready && paged.hasMore ? (
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
