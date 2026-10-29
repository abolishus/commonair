// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/apps` (admins): every OAuth app on the instance, searchable and filterable, with
 * suspension by reason code (it revokes the app's tokens and webhook subscriptions and closes its
 * sockets) and unsuspension (tokens stay revoked: users authorize again) (ADR 0027 §4).
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { SwitchField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import { toast } from "@commonair/ui/toast";
import { ShieldBanIcon, SourceCodeIcon, SquareUnlock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { fillNodes } from "../interact-studio/shared.tsx";
import { type AdminAppsClient, type AdminOAuthAppDto, PAGE_SIZE, type SuspensionReason } from "./client.ts";
import { SUSPENSION_REASONS, SUSPENSION_REASON_KEYS, developerError } from "./model.ts";
import { LoadError, LoadMore, useLiveList } from "./shared.tsx";

/** Typing pauses this long before the search runs. */
export const SEARCH_DEBOUNCE_MS = 300;

export function AdminAppsPage({ client }: { client: AdminAppsClient }): React.JSX.Element {
  const searchId = React.useId();
  const [typed, setTyped] = React.useState("");
  const [q, setQ] = React.useState("");
  const [suspendedOnly, setSuspendedOnly] = React.useState(false);
  React.useEffect(() => {
    const id = setTimeout(() => setQ(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  const list = useLiveList(
    `admin:apps:${suspendedOnly ? "s" : "a"}:${q}`,
    (cursor) =>
      client.list({
        limit: PAGE_SIZE,
        ...(q === "" ? {} : { q }),
        ...(suspendedOnly ? { suspended: true } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    { onMoreError: (err) => toast.error(developerError(err, "developer.admin.loadFailed")) },
  );
  const [changed, setChanged] = React.useState<ReadonlyMap<string, AdminOAuthAppDto>>(new Map());
  const [suspending, setSuspending] = React.useState<AdminOAuthAppDto | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const update = (app: AdminOAuthAppDto) => setChanged((m) => new Map(m).set(app.id, app));

  const unsuspend = async (app: AdminOAuthAppDto): Promise<void> => {
    setFailure(null);
    update(await client.unsuspend({ id: app.id }));
    toast.success(t("developer.admin.unsuspended", { name: app.name }));
  };

  return (
    <div data-testid="adminapps" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field className="sm:max-w-sm">
          <FieldLabel htmlFor={searchId}>{t("developer.admin.search")}</FieldLabel>
          <Input
            id={searchId}
            type="search"
            data-testid="adminapps-search"
            autoComplete="off"
            maxLength={100}
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
          />
        </Field>
        <SwitchField
          label={t("developer.admin.suspendedOnly")}
          checked={suspendedOnly}
          onCheckedChange={setSuspendedOnly}
          switchProps={{ "data-testid": "adminapps-filter-suspended" }}
        />
      </div>
      {failure ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      {list.items === null && list.failed ? (
        <LoadError message={t("developer.admin.loadFailed")} onRetry={list.retry} />
      ) : list.items === null ? (
        <SkeletonGroup label={t("developer.loading")}>
          <SkeletonText lines={6} />
        </SkeletonGroup>
      ) : list.items.length === 0 ? (
        <EmptyState
          data-testid="adminapps-empty"
          icon={SourceCodeIcon}
          title={q === "" && !suspendedOnly ? t("developer.admin.empty") : t("developer.admin.noMatch")}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border" aria-label={t("developer.admin.listLabel")}>
          {list.items.map((row) => {
            const app = changed.get(row.id) ?? row;
            return (
              <AdminAppRow
                key={app.id}
                app={app}
                onSuspend={() => setSuspending(app)}
                onUnsuspend={() => unsuspend(app)}
                onError={(err) =>
                  setFailure(
                    developerError(err, "developer.admin.unsuspendFailed", { CONFLICT: "developer.admin.conflict" }),
                  )
                }
              />
            );
          })}
        </ul>
      )}
      <LoadMore list={list} />
      <SuspendDialog
        app={suspending}
        onClose={() => setSuspending(null)}
        onSuspend={async (reason) => {
          if (!suspending) return;
          const next = await client.suspend({ id: suspending.id, reason });
          update(next);
          setSuspending(null);
          toast.success(t("developer.admin.suspended", { name: next.name }));
        }}
      />
    </div>
  );
}

function AdminAppRow({
  app,
  onSuspend,
  onUnsuspend,
  onError,
}: {
  app: AdminOAuthAppDto;
  onSuspend: () => void;
  onUnsuspend: () => Promise<void>;
  onError: (err: unknown) => void;
}): React.JSX.Element {
  return (
    <li
      data-testid="adminapp"
      data-app-id={app.id}
      data-client-id={app.clientId}
      data-suspended={app.suspended ? "true" : "false"}
      data-grants={String(app.grants)}
      data-subscriptions={String(app.subscriptions)}
      className="flex flex-wrap items-start gap-3 p-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium break-words">{app.name}</span>
          <StatusBadge tone="neutral">
            {app.confidential ? t("developer.app.kind.confidential") : t("developer.app.kind.public")}
          </StatusBadge>
          {app.suspended ? (
            <StatusBadge tone="danger">
              {t("developer.admin.suspendedWith", { reason: t(SUSPENSION_REASON_KEYS[app.suspended.reason]) })}
            </StatusBadge>
          ) : null}
        </div>
        <code className="text-xs break-all text-muted-foreground">{app.clientId}</code>
        <span className="text-xs text-muted-foreground">
          {fillNodes(t("developer.admin.owner"), { owner: <span className="font-medium">@{app.owner.username}</span> })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("developer.admin.counts", { grants: app.grants, subscriptions: app.subscriptions })}
        </span>
        <span className="text-xs text-muted-foreground">
          {fillNodes(t("developer.app.registered"), { time: <RelativeTime date={app.createdAt} /> })}
        </span>
      </div>
      {app.suspended ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" size="sm" data-testid="adminapp-unsuspend">
              <HugeiconsIcon icon={SquareUnlock01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
              {t("developer.admin.unsuspend")}
            </Button>
          }
          title={t("developer.admin.unsuspendTitle", { name: app.name })}
          description={t("developer.admin.unsuspendBody")}
          confirmLabel={t("developer.admin.unsuspendConfirm")}
          onConfirm={onUnsuspend}
          onError={onError}
        />
      ) : (
        <Button type="button" variant="destructive" size="sm" data-testid="adminapp-suspend" onClick={onSuspend}>
          <HugeiconsIcon icon={ShieldBanIcon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("developer.admin.suspend")}
        </Button>
      )}
    </li>
  );
}

function SuspendDialog({
  app,
  onClose,
  onSuspend,
}: {
  app: AdminOAuthAppDto | null;
  onClose: () => void;
  onSuspend: (reason: SuspensionReason) => Promise<void>;
}): React.JSX.Element {
  return (
    <Dialog
      open={app !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {app ? <SuspendForm key={app.id} app={app} onClose={onClose} onSuspend={onSuspend} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SuspendForm({
  app,
  onClose,
  onSuspend,
}: {
  app: AdminOAuthAppDto;
  onClose: () => void;
  onSuspend: (reason: SuspensionReason) => Promise<void>;
}): React.JSX.Element {
  const id = React.useId();
  const [reason, setReason] = React.useState<SuspensionReason | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  return (
    <form
      data-testid="adminapp-suspend-form"
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason === null) {
          setMissing(true);
          return;
        }
        setConfirming(true);
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("developer.admin.suspendTitle", { name: app.name })}</DialogTitle>
        <DialogDescription>{t("developer.admin.suspendIntro")}</DialogDescription>
      </DialogHeader>
      <FieldSet data-invalid={missing ? true : undefined}>
        <FieldLegend variant="label">{t("developer.admin.reason")}</FieldLegend>
        <RadioGroup
          data-testid="adminapp-reason"
          value={reason}
          onValueChange={(value) => {
            const r = SUSPENSION_REASONS.find((x) => x === value);
            if (r) {
              setReason(r);
              setMissing(false);
            }
          }}
          aria-describedby={missing ? `${id}-error` : undefined}
        >
          {SUSPENSION_REASONS.map((r) => (
            <Field key={r} orientation="horizontal">
              <RadioGroupItem id={`${id}-${r}`} value={r} data-testid={`adminapp-reason-${r}`} />
              <FieldLabel htmlFor={`${id}-${r}`} className="font-normal">
                {t(SUSPENSION_REASON_KEYS[r])}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
        {missing ? <FieldError id={`${id}-error`}>{t("developer.admin.reasonMissing")}</FieldError> : null}
      </FieldSet>
      {failure ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("developer.cancel")}
        </Button>
        <Button type="submit" variant="destructive" data-testid="adminapp-suspend-submit">
          {t("developer.admin.suspend")}
        </Button>
      </DialogFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="destructive"
        icon={ShieldBanIcon}
        title={t("developer.admin.confirmTitle", { name: app.name })}
        description={t("developer.admin.confirmBody", {
          reason: reason === null ? "" : t(SUSPENSION_REASON_KEYS[reason]),
          grants: app.grants,
          subscriptions: app.subscriptions,
        })}
        confirmLabel={t("developer.admin.confirm")}
        onConfirm={async () => {
          if (reason === null) return;
          setFailure(null);
          await onSuspend(reason);
        }}
        onError={(err) =>
          setFailure(developerError(err, "developer.admin.suspendFailed", { CONFLICT: "developer.admin.conflict" }))
        }
      />
    </form>
  );
}
