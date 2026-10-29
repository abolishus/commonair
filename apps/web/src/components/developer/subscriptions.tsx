// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `devsubs` on an app's page: its EventSub subscriptions (paged), a webhook subscription form
 * built from the catalog (WebSocket-only types are left out: a socket subscribes itself), test
 * events, deletion and each subscription's delivery log with redelivery.
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { SelectField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, Delete02Icon, ListViewIcon, SentIcon, WebhookIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { useLoad } from "../money/use-load.ts";
import { StudioSection, TextField, fillNodes } from "../interact-studio/shared.tsx";
import {
  type CatalogEntry,
  type DeliveryDto,
  type DeveloperClient,
  type OAuthAppDto,
  PAGE_SIZE,
  type SubscriptionDto,
} from "./client.ts";
import {
  DELIVERY_STATUS_KEYS,
  type FieldErrors,
  SUBSCRIPTION_STATUS_KEYS,
  type SubscriptionDraft,
  type SubscriptionField,
  WEBHOOK_SECRET,
  canRedeliver,
  canSendTest,
  deliveryTone,
  developerError,
  emptySubscriptionDraft,
  generateWebhookSecret,
  subscriptionInput,
  subscriptionTone,
  webhookTypes,
} from "./model.ts";
import { LoadError, LoadMore, useLiveList } from "./shared.tsx";

/** How often a pending verification and an open delivery log are re-read. */
export const LIVE_REFRESH_MS = 5000;

export function SubscriptionsPanel({ app, client }: { app: OAuthAppDto; client: DeveloperClient }): React.JSX.Element {
  const list = useLiveList(
    `developer:subs:${app.id}`,
    (cursor) => client.events.list({ appId: app.id, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
    {
      // A new webhook waits for its challenge; re-read until it settles.
      pollMs: LIVE_REFRESH_MS,
      pollWhile: (items) => items.some((s) => s.status === "verification_pending"),
      onMoreError: (err) => toast.error(developerError(err, "developer.sub.loadFailed")),
    },
  );

  const [creating, setCreating] = React.useState(false);
  const [logFor, setLogFor] = React.useState<SubscriptionDto | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const suspended = app.suspended !== null;

  const sendTest = async (sub: SubscriptionDto): Promise<void> => {
    setFailure(null);
    try {
      await client.events.sendTest({ id: sub.id });
      toast.success(t("developer.sub.testSent"));
    } catch (err) {
      setFailure(developerError(err, "developer.sub.testFailed"));
    }
  };

  const remove = async (sub: SubscriptionDto): Promise<void> => {
    setFailure(null);
    await client.events.unsubscribe({ id: sub.id });
    list.drop(sub.id);
    toast.success(t("developer.sub.deleted", { type: sub.type }));
    await list.refresh().catch(() => undefined);
  };

  return (
    <StudioSection
      icon={WebhookIcon}
      title={t("developer.subs.title")}
      description={t("developer.subs.intro")}
      data-testid="devsubs"
      action={
        <Button type="button" size="sm" data-testid="devsub-new" disabled={suspended} onClick={() => setCreating(true)}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("developer.subs.new")}
        </Button>
      }
    >
      {failure ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      {list.items === null && list.failed ? (
        <LoadError message={t("developer.sub.loadFailed")} onRetry={list.retry} />
      ) : list.items === null ? (
        <SkeletonGroup label={t("developer.loading")}>
          <SkeletonText lines={4} />
        </SkeletonGroup>
      ) : list.items.length === 0 ? (
        <EmptyState
          data-testid="devsubs-empty"
          icon={WebhookIcon}
          headingLevel={3}
          title={t("developer.subs.empty")}
          description={t("developer.subs.emptyHint")}
        />
      ) : (
        <ul className="flex flex-col divide-y" aria-label={t("developer.subs.title")}>
          {list.items.map((sub) => (
            <SubscriptionRow
              key={sub.id}
              sub={sub}
              onTest={() => void sendTest(sub)}
              onDeliveries={() => setLogFor(sub)}
              onRemove={() => remove(sub)}
              onRemoveError={(err) => setFailure(developerError(err, "developer.sub.deleteFailed"))}
            />
          ))}
        </ul>
      )}
      <LoadMore list={list} />
      <SubscriptionDialog
        open={creating}
        app={app}
        client={client}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void list.refresh();
        }}
      />
      <DeliveriesDialog sub={logFor} client={client} onClose={() => setLogFor(null)} />
    </StudioSection>
  );
}

function SubscriptionRow({
  sub,
  onTest,
  onDeliveries,
  onRemove,
  onRemoveError,
}: {
  sub: SubscriptionDto;
  onTest: () => void;
  onDeliveries: () => void;
  onRemove: () => Promise<void>;
  onRemoveError: (err: unknown) => void;
}): React.JSX.Element {
  const webhook = sub.transport.method === "webhook";
  return (
    <li
      data-testid="devsub"
      data-subscription-id={sub.id}
      data-type={sub.type}
      data-transport={sub.transport.method}
      data-status={sub.status}
      className="flex flex-col gap-2 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm font-medium break-all">{sub.type}</code>
        <StatusBadge tone={subscriptionTone(sub.status)}>{t(SUBSCRIPTION_STATUS_KEYS[sub.status])}</StatusBadge>
        <StatusBadge tone="neutral">
          {webhook ? t("developer.sub.transport.webhook") : t("developer.sub.transport.websocket")}
        </StatusBadge>
      </div>
      <dl className="grid min-w-0 gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        {Object.entries(sub.condition).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="min-w-0 break-all">
              <code>{k}</code>
            </dt>
            <dd className="min-w-0 break-all sm:col-span-3">
              <code>{v}</code>
            </dd>
          </React.Fragment>
        ))}
        {sub.transport.method === "webhook" ? (
          <>
            <dt>{t("developer.sub.callback")}</dt>
            <dd className="min-w-0 break-all sm:col-span-3">
              <code>{sub.transport.callback}</code>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">
        {fillNodes(t("developer.sub.created", { failures: sub.failureCount }), {
          time: <RelativeTime date={sub.createdAt} />,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        {webhook ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="devsub-test"
            disabled={!canSendTest(sub)}
            onClick={onTest}
          >
            <HugeiconsIcon icon={SentIcon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("developer.sub.test")}
          </Button>
        ) : null}
        {webhook ? (
          <Button type="button" variant="outline" size="sm" data-testid="devsub-deliveries" onClick={onDeliveries}>
            <HugeiconsIcon icon={ListViewIcon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("developer.sub.deliveries")}
          </Button>
        ) : null}
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" size="sm" data-testid="devsub-delete">
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
              {t("developer.sub.delete")}
            </Button>
          }
          variant="destructive"
          title={t("developer.sub.deleteTitle", { type: sub.type })}
          description={t("developer.sub.deleteBody")}
          confirmLabel={t("developer.sub.deleteConfirm")}
          onConfirm={onRemove}
          onError={onRemoveError}
        />
      </div>
    </li>
  );
}

// ── The subscription form ────────────────────────────────────────────────────────────────────

function SubscriptionDialog({
  open,
  app,
  client,
  onClose,
  onCreated,
}: {
  open: boolean;
  app: OAuthAppDto;
  client: DeveloperClient;
  onClose: () => void;
  onCreated: (sub: SubscriptionDto) => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {open ? <SubscriptionForm app={app} client={client} onClose={onClose} onCreated={onCreated} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SubscriptionForm({
  app,
  client,
  onClose,
  onCreated,
}: {
  app: OAuthAppDto;
  client: DeveloperClient;
  onClose: () => void;
  onCreated: (sub: SubscriptionDto) => void;
}): React.JSX.Element {
  const catalog = useLoad("developer:catalog", () => client.events.catalog());
  const [draft, setDraft] = React.useState<SubscriptionDraft>(emptySubscriptionDraft);
  const [errors, setErrors] = React.useState<FieldErrors<SubscriptionField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const types = catalog.data ? webhookTypes(catalog.data) : [];
  const def: CatalogEntry | undefined = types.find((e) => e.type === draft.type);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending || !catalog.data) return;
    const checked = subscriptionInput(app.id, draft, catalog.data);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setPending(true);
    setFailure(null);
    try {
      const sub = await client.events.subscribe(checked.input);
      toast.success(t("developer.sub.createdToast", { type: sub.type }));
      onCreated(sub);
    } catch (err) {
      setFailure(
        developerError(err, "developer.sub.createFailed", {
          FORBIDDEN: "developer.sub.error.notAuthorized",
        }),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <form data-testid="devsub-form" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("developer.sub.newTitle")}</DialogTitle>
        <DialogDescription>{t("developer.sub.formHint")}</DialogDescription>
      </DialogHeader>
      {catalog.data === null && catalog.failed ? (
        <LoadError message={t("developer.sub.catalogFailed")} onRetry={catalog.reload} />
      ) : catalog.data === null ? (
        <SkeletonGroup label={t("developer.loading")}>
          <SkeletonText lines={3} />
        </SkeletonGroup>
      ) : (
        <>
          <SelectField
            label={t("developer.sub.type")}
            placeholder={t("developer.sub.typePlaceholder")}
            value={draft.type === "" ? null : draft.type}
            onValueChange={(type) => setDraft((d) => ({ ...d, type, condition: {} }))}
            options={types.map((e) => ({ value: e.type, label: e.type, "data-testid": `devsub-type-${e.type}` }))}
            error={errors.type}
            description={def ? def.description : t("developer.sub.typeHint")}
            triggerProps={{ "data-testid": "devsub-type" }}
          />
          {def ? (
            <>
              <p className="text-xs text-muted-foreground">
                {def.scopes.length === 0
                  ? t("developer.sub.noScopes")
                  : fillNodes(t("developer.sub.scopes"), {
                      scopes: (
                        <span className="inline-flex flex-wrap gap-1">
                          {def.scopes.map((s) => (
                            <code key={s}>{s}</code>
                          ))}
                        </span>
                      ),
                    })}
              </p>
              {def.condition.map((field) => (
                <TextField
                  key={field}
                  label={<code>{field}</code>}
                  value={draft.condition[field] ?? ""}
                  onChange={(v) => setDraft((d) => ({ ...d, condition: { ...d.condition, [field]: v } }))}
                  data-testid={`devsub-condition-${field}`}
                  error={errors[`condition.${field}`]}
                  description={field.endsWith("user_id") ? t("developer.sub.userIdHint") : undefined}
                />
              ))}
            </>
          ) : null}
          <TextField
            label={t("developer.sub.callback")}
            value={draft.callback}
            onChange={(v) => setDraft((d) => ({ ...d, callback: v }))}
            data-testid="devsub-callback"
            error={errors.callback}
            description={t("developer.sub.callbackHint")}
          />
          <div className="flex flex-col gap-2">
            <TextField
              label={t("developer.sub.secret")}
              value={draft.secret}
              onChange={(v) => setDraft((d) => ({ ...d, secret: v }))}
              data-testid="devsub-secret"
              error={errors.secret}
              description={t("developer.sub.secretHint", { min: WEBHOOK_SECRET.min, max: WEBHOOK_SECRET.max })}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setDraft((d) => ({ ...d, secret: generateWebhookSecret() }))}
            >
              {t("developer.sub.generate")}
            </Button>
          </div>
        </>
      )}
      {failure ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          {t("developer.cancel")}
        </Button>
        <Button type="submit" data-testid="devsub-submit" disabled={pending || catalog.data === null}>
          {t("developer.sub.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── The delivery log ─────────────────────────────────────────────────────────────────────────

function DeliveriesDialog({
  sub,
  client,
  onClose,
}: {
  sub: SubscriptionDto | null;
  client: DeveloperClient;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={sub !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("developer.delivery.title")}</DialogTitle>
          <DialogDescription>{sub ? t("developer.delivery.intro", { type: sub.type }) : null}</DialogDescription>
        </DialogHeader>
        {sub ? <DeliveryLog key={sub.id} sub={sub} client={client} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** The delivery log of one subscription, re-read while it is open. */
export function DeliveryLog({ sub, client }: { sub: SubscriptionDto; client: DeveloperClient }): React.JSX.Element {
  const list = useLiveList(
    `developer:deliveries:${sub.id}`,
    (cursor) => client.events.deliveries({ id: sub.id, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
    {
      pollMs: LIVE_REFRESH_MS,
      onMoreError: (err) => toast.error(developerError(err, "developer.delivery.loadFailed")),
    },
  );
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const redeliver = async (d: DeliveryDto): Promise<void> => {
    if (busy) return;
    setBusy(d.id);
    setFailure(null);
    try {
      await client.events.redeliver({ id: d.id });
      toast.success(t("developer.delivery.redelivered"));
      await list.refresh();
    } catch (err) {
      setFailure(developerError(err, "developer.delivery.redeliverFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (list.items === null && list.failed)
    return <LoadError message={t("developer.delivery.loadFailed")} onRetry={list.retry} />;
  if (list.items === null)
    return (
      <SkeletonGroup label={t("developer.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  return (
    <div className="flex max-h-96 min-w-0 flex-col gap-3 overflow-y-auto">
      {failure ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      {list.items.length === 0 ? (
        <EmptyState icon={ListViewIcon} headingLevel={3} title={t("developer.delivery.empty")} />
      ) : (
        <ul className="flex flex-col divide-y" aria-label={t("developer.delivery.title")}>
          {list.items.map((d) => (
            <li
              key={d.id}
              data-testid="devdelivery"
              data-delivery-id={d.id}
              data-message-type={d.messageType}
              data-status={d.status}
              data-response-status={d.responseStatus === null ? "" : String(d.responseStatus)}
              data-attempt={String(d.attempt)}
              className="flex flex-wrap items-start gap-2 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{d.messageType}</code>
                  <StatusBadge tone={deliveryTone(d.status)}>{t(DELIVERY_STATUS_KEYS[d.status])}</StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    {t("developer.delivery.attempt", { attempt: d.attempt })}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {d.responseStatus === null
                    ? t("developer.delivery.noResponse")
                    : t("developer.delivery.response", { status: String(d.responseStatus) })}
                  {d.latencyMs === null ? "" : ` · ${t("developer.delivery.latency", { ms: String(d.latencyMs) })}`}
                </span>
                {d.error ? <span className="text-xs break-words text-destructive">{d.error}</span> : null}
                <span className="text-xs text-muted-foreground">
                  <code className="break-all">{d.messageId}</code> · <RelativeTime date={d.createdAt} />
                </span>
              </div>
              {canRedeliver(d) ? (
                <Button
                  type="button"
                  variant={d.status === "failed" ? "default" : "outline"}
                  size="sm"
                  data-testid="devdelivery-redeliver"
                  disabled={busy !== null}
                  onClick={() => void redeliver(d)}
                >
                  {t("developer.delivery.redeliver")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <LoadMore list={list} />
    </div>
  );
}
