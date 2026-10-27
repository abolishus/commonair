// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { INCIDENT_STATUSES } from "@commonair/contracts/enums";
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, CheckmarkCircle02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { useLoad } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  incidentsClient,
  type IncidentDto,
  type IncidentInput,
  type IncidentStatus,
  type IncidentsClient,
} from "./client.ts";
import { INCIDENT_BODY_MAX, INCIDENT_TITLE_MAX, parseComponents } from "./forms.ts";
import { incidentStatusLabel, incidentTone } from "./labels.ts";

export interface IncidentDraft {
  id?: string;
  title: string;
  status: IncidentStatus;
  components: string;
  body: string;
  /** The status before this edit (null for a new incident): resolving asks for confirmation. */
  previous: IncidentStatus | null;
}

const blank = (): IncidentDraft => ({
  title: "",
  status: "investigating",
  components: "",
  body: "",
  previous: null,
});
const draftOf = (i: IncidentDto): IncidentDraft => ({
  id: i.id,
  title: i.title,
  status: i.status,
  components: i.components.join("\n"),
  body: i.body,
  previous: i.status,
});

/** Merge locally written incidents over the (briefly cached) status page answer, newest first. */
export function mergeIncidents(
  loaded: readonly IncidentDto[],
  written: ReadonlyMap<string, IncidentDto>,
): IncidentDto[] {
  const out = loaded.map((i) => written.get(i.id) ?? i);
  for (const [id, i] of written) if (!loaded.some((l) => l.id === id)) out.push(i);
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** `/admin/incidents`: open and recent incidents (from `instance.status`), and the form to open or update one. */
export function IncidentsPage({ client: clientProp }: { client?: IncidentsClient }): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? incidentsClient());
  const status = useLoad("status", () => client.status());
  const [written, setWritten] = React.useState<Map<string, IncidentDto>>(() => new Map());
  const [draft, setDraft] = React.useState<IncidentDraft | null>(null);
  const incidents = status.data ? mergeIncidents(status.data.incidents, written) : null;
  const known = status.data?.components.map((c) => c.id) ?? [];

  const save = async (d: IncidentDraft) => {
    const input: IncidentInput = {
      title: d.title.trim(),
      status: d.status,
      components: parseComponents(d.components),
      body: d.body,
      ...(d.id ? { id: d.id } : {}),
    };
    const { id } = await client.write(input);
    const now = new Date().toISOString();
    const before = d.id ? (written.get(d.id) ?? status.data?.incidents.find((i) => i.id === d.id)) : undefined;
    const resolvedAt = input.status === "resolved" ? (before?.resolvedAt ?? now) : null;
    setWritten((prev) =>
      new Map(prev).set(id, {
        id,
        title: input.title,
        status: input.status,
        components: input.components,
        body: input.body,
        startedAt: before?.startedAt ?? now,
        resolvedAt,
      }),
    );
    setDraft(null);
    toast.success(t("admin.incidents.saved"));
    status.reload();
  };

  return (
    <div data-testid="incidents" className="flex flex-col gap-4">
      <div>
        <Button data-testid="incident-new" onClick={() => setDraft(blank())} disabled={draft !== null}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
          {t("admin.incidents.new")}
        </Button>
      </div>
      {draft && (
        <IncidentForm
          key={draft.id ?? "new"}
          initial={draft}
          known={known}
          onCancel={() => setDraft(null)}
          onSubmit={save}
        />
      )}
      <IncidentList
        incidents={incidents}
        failed={status.failed}
        onRetry={status.reload}
        onEdit={(i) => setDraft(draftOf(i))}
      />
    </div>
  );
}

export function IncidentList({
  incidents,
  failed,
  onRetry,
  onEdit,
}: {
  incidents: IncidentDto[] | null;
  failed: boolean;
  onRetry: () => void;
  onEdit: (incident: IncidentDto) => void;
}): React.JSX.Element {
  if (failed && incidents === null)
    return (
      <div className="flex flex-col items-start gap-3">
        <FormError>{t("admin.incidents.loadFailed")}</FormError>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("admin.incidents.retry")}
        </Button>
      </div>
    );
  if (incidents === null)
    return (
      <SkeletonGroup label={t("admin.incidents.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (incidents.length === 0)
    return (
      <EmptyState
        data-testid="incidents-empty"
        icon={CheckmarkCircle02Icon}
        title={t("admin.incidents.empty")}
        description={t("admin.incidents.emptyHint")}
        headingLevel={2}
      />
    );
  return (
    <ul className="flex flex-col gap-3">
      {incidents.map((i) => (
        <li key={i.id}>
          <Card size="sm" data-testid="incident-row" data-incident-id={i.id} data-status={i.status}>
            <CardHeader>
              <CardTitle>
                <h2 className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={incidentTone(i.status)}>{incidentStatusLabel(i.status)}</StatusBadge>
                  <span className="min-w-0 break-words">{i.title}</span>
                </h2>
              </CardTitle>
              <CardAction>
                <Button data-testid="incident-edit" variant="outline" size="sm" onClick={() => onEdit(i)}>
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} aria-hidden />
                  {t("admin.incidents.edit")}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {i.body && <p className="text-sm break-words whitespace-pre-wrap">{i.body}</p>}
              <p className="text-xs text-muted-foreground">
                {i.components.length > 0 ? i.components.join(", ") : t("admin.incidents.noComponents")}
              </p>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t("admin.incidents.started")} <RelativeTime date={i.startedAt} />
                </span>
                {i.resolvedAt && (
                  <span>
                    {t("admin.incidents.resolved")} <RelativeTime date={i.resolvedAt} />
                  </span>
                )}
              </p>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

export function IncidentForm({
  initial,
  known,
  onSubmit,
  onCancel,
}: {
  initial: IncidentDraft;
  /** Component ids the status page reports (empty while it loads: then the API checks them). */
  known: readonly string[];
  onSubmit: (draft: IncidentDraft) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [d, setD] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ids = { title: React.useId(), components: React.useId(), body: React.useId() };
  const unknown = known.length > 0 ? parseComponents(d.components).filter((c) => !known.includes(c)) : [];

  const send = async () => {
    setPending(true);
    try {
      await onSubmit(d);
    } catch (err) {
      toastActionError(err, t("admin.incidents.failed"));
      throw err;
    } finally {
      setPending(false);
    }
  };
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    if (d.title.trim() === "") {
      setError(t("admin.incidents.titleRequired"));
      return;
    }
    if (unknown.length > 0) {
      setError(t("admin.incidents.unknownComponents", { ids: unknown.join(", ") }));
      return;
    }
    setError(null);
    if (d.status === "resolved" && d.previous !== "resolved") setConfirming(true);
    else void send().catch(() => undefined);
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{d.id ? t("admin.incidents.formEdit") : t("admin.incidents.formNew")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form data-testid="incident-form" className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <Field>
            <FieldLabel htmlFor={ids.title}>{t("admin.incidents.fieldTitle")}</FieldLabel>
            <Input
              id={ids.title}
              data-testid="incident-title"
              maxLength={INCIDENT_TITLE_MAX}
              required
              value={d.title}
              onChange={(e) => {
                const title = e.currentTarget.value;
                setD((p) => ({ ...p, title }));
              }}
            />
          </Field>
          <ChoiceToggle
            data-testid="incident-status"
            label={t("admin.incidents.fieldStatus")}
            value={d.status}
            wrap
            onValueChange={(v) => {
              const s = INCIDENT_STATUSES.find((x) => x === v);
              if (s) setD((p) => ({ ...p, status: s }));
            }}
            options={INCIDENT_STATUSES.map((s) => ({
              value: s,
              label: incidentStatusLabel(s),
              "data-testid": `incident-status-${s}`,
            }))}
          />
          <Field>
            <FieldLabel htmlFor={ids.components}>{t("admin.incidents.fieldComponents")}</FieldLabel>
            <Textarea
              id={ids.components}
              data-testid="incident-components"
              rows={3}
              value={d.components}
              onChange={(e) => {
                const components = e.currentTarget.value;
                setD((p) => ({ ...p, components }));
              }}
            />
            {known.length > 0 && (
              <FieldDescription>{t("admin.incidents.componentsHint", { ids: known.join(", ") })}</FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.body}>{t("admin.incidents.fieldBody")}</FieldLabel>
            <Textarea
              id={ids.body}
              data-testid="incident-body"
              rows={4}
              maxLength={INCIDENT_BODY_MAX}
              value={d.body}
              onChange={(e) => {
                const body = e.currentTarget.value;
                setD((p) => ({ ...p, body }));
              }}
            />
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <div className="flex flex-wrap gap-2">
            <Button data-testid="incident-submit" type="submit" disabled={pending} aria-busy={pending || undefined}>
              {t("admin.incidents.submit")}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              {t("admin.incidents.cancel")}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t("admin.incidents.resolveTitle")}
          description={t("admin.incidents.resolveDescription")}
          confirmLabel={t("admin.incidents.resolveConfirm")}
          onConfirm={send}
        />
      </CardContent>
    </Card>
  );
}
