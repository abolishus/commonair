// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, EmptyState, RelativeTime, StatusBadge, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { CodeBlock, CopyField, FormSection } from "@commonair/ui/blocks/forms";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { field } from "../../lib/form.ts";
import { requireSession } from "../../lib/guard.ts";
import {
  RELAY_NAME_MAX,
  RELAYS_POLL_MS,
  formatBytes,
  relayName,
  relayReadmeUrl,
  relayRunCommand,
  relayStatusView,
  type RelayNodeDto,
} from "../../lib/relays.ts";
import { browserPollEnv, pollWhileVisible } from "../../lib/stream-health.ts";
import { safeHttpUrl } from "../../lib/url.ts";

export const Route = createFileRoute("/_studio/relays")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: RelaysPage,
});

function RelaysPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const relays = useMyRelays();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer data-testid="relays" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("relays.title")} description={t("relays.intro")} />
      <HowToRun />
      <CreateRelay onCreated={relays.refresh} />
      <RelayList {...relays} />
    </PageContainer>
  );
}

interface MyRelays {
  relays: RelayNodeDto[] | null;
  failed: boolean;
  refresh: () => void;
  removed: (id: string) => void;
}

/**
 * `relays.mine`, polled while the tab is visible. A response that was requested before a local
 * change (create, retire) is dropped, so a slow poll cannot bring a retired row back.
 */
function useMyRelays(): MyRelays {
  const [relays, setRelays] = React.useState<RelayNodeDto[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const seq = React.useRef({ next: 0, minApplied: 0, lastApplied: -1 });
  const mounted = React.useRef(true);

  const load = React.useCallback((): Promise<void> => {
    const s = seq.current;
    const id = s.next++;
    return api()
      .relays.mine()
      .then((list) => {
        if (!mounted.current || id < s.minApplied || id < s.lastApplied) return;
        s.lastApplied = id;
        setRelays(list);
        setFailed(false);
      })
      .catch(() => {
        if (mounted.current && id >= s.minApplied && id > s.lastApplied) setFailed(true);
      });
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    let inFlight = false;
    const tick = () => {
      // A slow response must not pile requests up behind it.
      if (inFlight) return;
      inFlight = true;
      void load().finally(() => {
        inFlight = false;
      });
    };
    const stop = pollWhileVisible(tick, RELAYS_POLL_MS, browserPollEnv());
    return () => {
      mounted.current = false;
      stop();
    };
  }, [load]);

  const refresh = React.useCallback(() => {
    seq.current.minApplied = seq.current.next;
    void load();
  }, [load]);

  const removed = React.useCallback(
    (id: string) => {
      setRelays((prev) => prev?.filter((r) => r.id !== id) ?? prev);
      refresh();
    },
    [refresh],
  );

  return { relays, failed, refresh, removed };
}

function HowToRun(): React.JSX.Element {
  const { instance } = useBootstrap();
  const readme = safeHttpUrl(relayReadmeUrl(safeHttpUrl(instance.sourceUrl)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("relays.howTo.title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex list-decimal flex-col gap-1 ps-5">
          <li>{t("relays.howTo.step1")}</li>
          <li>{t("relays.howTo.step2")}</li>
          <li>{t("relays.howTo.step3")}</li>
        </ol>
        {readme && (
          <a href={readme} rel="noopener" className={buttonVariants({ variant: "link", className: "self-start px-0" })}>
            {t("relays.howTo.readme")}
          </a>
        )}
      </CardContent>
    </Card>
  );
}

interface Created {
  name: string;
  token: string;
}

function CreateRelay({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<Created | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const form = e.currentTarget;
    const name = relayName(field(new FormData(form), "name"));
    if (!name) {
      setError(t("relays.create.invalidName"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await api().relays.create({ name });
      setCreated({ name, token: res.registrationToken });
      form.reset();
      toast.success(t("relays.created"));
      onCreated();
    } catch (err) {
      toastActionError(err, t("relays.create.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <FormSection title={t("relays.create.title")} onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field>
          <FieldLabel htmlFor="relay-create-name">{t("relays.create.name")}</FieldLabel>
          <Input
            id="relay-create-name"
            data-testid="relay-create-name"
            name="name"
            autoComplete="off"
            maxLength={RELAY_NAME_MAX}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby="relay-create-name-hint"
          />
          <FieldDescription id="relay-create-name-hint">{t("relays.create.nameHint")}</FieldDescription>
        </Field>
        {error && <FormError>{error}</FormError>}
        {/* FormSection's own submit takes no test id (e3 `relay-create-submit`), so the button is ours. */}
        <div>
          <Button data-testid="relay-create-submit" type="submit" disabled={pending} aria-busy={pending || undefined}>
            {t("relays.create.submit")}
          </Button>
        </div>
      </FormSection>
      {created && <NewRelayToken created={created} onDismiss={() => setCreated(null)} />}
    </>
  );
}

/** The registration token, shown once right after `relays.create`, and the command that uses it. */
function NewRelayToken({ created, onDismiss }: { created: Created; onDismiss: () => void }): React.JSX.Element {
  const { config } = useBootstrap();
  const command = relayRunCommand(config.publicUrl, created.token);
  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle>{t("relays.token.title", { name: created.name })}</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <CopyField
            label={t("relays.token.label")}
            value={created.token}
            copyLabel={t("relays.token.copy")}
            copiedLabel={t("relays.token.copied")}
            copyFailedLabel={t("relays.copyFailed")}
            hint={t("relays.token.once")}
            data-value-testid="relay-token"
          />
          <Field>
            <FieldTitle>{t("relays.command.title")}</FieldTitle>
            <CodeBlock
              value={command}
              label={t("relays.command.copy")}
              copiedLabel={t("relays.command.copied")}
              copyFailedLabel={t("relays.copyFailed")}
              data-testid="relay-run-command"
            />
            <FieldDescription>{t("relays.command.hint")}</FieldDescription>
          </Field>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
              {t("relays.token.dismiss")}
            </Button>
          </div>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

function RelayList({ relays, failed, removed }: MyRelays): React.JSX.Element {
  const { locale } = useLocale();
  const columns: DataTableColumn<RelayNodeDto>[] = [
    {
      id: "relay",
      header: t("relays.column.relay"),
      cell: ({ row: { original: relay } }) => <RelayIdentity relay={relay} />,
    },
    {
      id: "status",
      header: t("relays.column.status"),
      cell: ({ row: { original: relay } }) => {
        const status = relayStatusView(relay.status);
        return (
          <StatusBadge data-testid="relay-status" tone={status.tone}>
            {status.label}
          </StatusBadge>
        );
      },
    },
    {
      id: "bytesVerified",
      align: "numeric",
      header: t("relays.bytesVerified"),
      cell: ({ row: { original: relay } }) => (
        <span data-testid="relay-bytes-verified" data-bytes={relay.bytesVerified30d}>
          {formatBytes(relay.bytesVerified30d, locale)}
        </span>
      ),
    },
    {
      id: "receipts",
      header: t("relays.receipts"),
      cell: ({ row: { original: relay } }) => <RelayReceipts relay={relay} />,
    },
    {
      id: "lastReceipt",
      header: t("relays.lastReceipt"),
      cell: ({ row: { original: relay } }) =>
        relay.lastReceiptAt ? <RelativeTime date={relay.lastReceiptAt} /> : t("relays.noReceipts"),
    },
    {
      id: "actions",
      header: t("relays.column.actions"),
      cell: ({ row: { original: relay } }) => <RetireRelay relay={relay} onRemoved={() => removed(relay.id)} />,
    },
  ];

  return (
    <Card aria-busy={relays === null && !failed}>
      <CardHeader>
        <CardTitle>{t("relays.list.title")}</CardTitle>
        <CardDescription>{t("relays.list.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {failed && <FormError>{t("relays.loadFailed")}</FormError>}
        {(relays !== null || !failed) && (
          <DataTable
            caption={t("relays.list.title")}
            columns={columns}
            rows={relays ?? []}
            loading={relays === null}
            loadingRows={3}
            getRowId={(relay) => relay.id}
            rowProps={(relay) => ({
              "data-testid": "relay-row",
              "data-relay-id": relay.id,
              "data-status": relay.status,
            })}
            empty={
              <EmptyState
                data-testid="relays-empty"
                icon={ServerStack01Icon}
                title={t("relays.empty.title")}
                description={t("relays.empty.hint")}
                headingLevel={3}
              />
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

function RelayIdentity({ relay }: { relay: RelayNodeDto }): React.JSX.Element {
  const status = relayStatusView(relay.status);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-medium break-all">{relay.name}</span>
      <span className="text-muted-foreground">{status.hint}</span>
      <span className="break-all text-muted-foreground">{relay.publicUrl}</span>
      {relay.suspendedReason && (
        <FieldError data-testid="relay-suspended-reason">
          {t("relays.suspendedReason", { reason: relay.suspendedReason })}
        </FieldError>
      )}
    </div>
  );
}

function RelayReceipts({ relay }: { relay: RelayNodeDto }): React.JSX.Element {
  const { pending, verified, rejected } = relay.receipts30d;
  return (
    <span data-testid="relay-receipts" data-pending={pending} data-verified={verified} data-rejected={rejected}>
      {t("relays.receiptsCounts", { verified, pending, rejected })}
    </span>
  );
}

function RetireRelay({ relay, onRemoved }: { relay: RelayNodeDto; onRemoved: () => void }): React.JSX.Element {
  const remove = async () => {
    await api().relays.remove({ id: relay.id });
    toast.success(t("relays.removed"));
    onRemoved();
  };
  return (
    <ConfirmDialog
      trigger={
        <Button
          data-testid="relay-remove"
          variant="outline"
          size="sm"
          aria-label={t("relays.removeLabel", { name: relay.name })}
        >
          {t("relays.remove")}
        </Button>
      }
      title={t("relays.removeConfirmTitle", { name: relay.name })}
      description={t("relays.removeConfirmBody")}
      confirmLabel={t("relays.remove")}
      variant="destructive"
      onConfirm={remove}
      onError={(err) => toastActionError(err, t("relays.removeFailed"))}
    />
  );
}
