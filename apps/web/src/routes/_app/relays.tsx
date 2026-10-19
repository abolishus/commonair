// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, EmptyState, IconButton, RelativeTime, SkeletonText, useLocale } from "@commonair/ui";
import { Badge } from "@commonair/ui/components/badge";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import { Copy01Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
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

export const Route = createFileRoute("/_app/relays")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: RelaysPage,
});

function RelaysPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const relays = useMyRelays();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <section data-testid="relays" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-xl font-semibold">{t("relays.title")}</h1>
          <Link to="/dashboard" className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("dashboard.title")}
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">{t("relays.intro")}</p>
      </div>
      <HowToRun />
      <CreateRelay onCreated={relays.refresh} />
      <RelayList {...relays} />
    </section>
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
      <CardContent className="flex flex-col gap-3 text-xs">
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          <li>{t("relays.howTo.step1")}</li>
          <li>{t("relays.howTo.step2")}</li>
          <li>{t("relays.howTo.step3")}</li>
        </ol>
        {readme && (
          <a
            href={readme}
            rel="noopener"
            className="self-start underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
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
    <Card>
      <CardHeader>
        <CardTitle>{t("relays.create.title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-xs">
        <form onSubmit={(e) => void onSubmit(e)} noValidate>
          <FieldGroup>
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
            <div>
              <Button
                data-testid="relay-create-submit"
                type="submit"
                disabled={pending}
                aria-busy={pending || undefined}
              >
                {t("relays.create.submit")}
              </Button>
            </div>
          </FieldGroup>
        </form>
        {created && <NewRelayToken created={created} onDismiss={() => setCreated(null)} />}
      </CardContent>
    </Card>
  );
}

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error(t("relays.copyFailed"));
  }
}

/** The registration token, shown once right after `relays.create`, and the command that uses it. */
function NewRelayToken({ created, onDismiss }: { created: Created; onDismiss: () => void }): React.JSX.Element {
  const { config } = useBootstrap();
  const command = relayRunCommand(config.publicUrl, created.token);
  return (
    <div className="flex flex-col gap-4 border border-border p-3" aria-live="polite">
      <div className="flex flex-col gap-1">
        <span className="font-medium">{t("relays.token.title", { name: created.name })}</span>
        <div className="flex items-center gap-2">
          <code data-testid="relay-token" className="min-w-0 flex-1 break-all bg-muted px-2 py-1">
            {created.token}
          </code>
          <IconButton
            label={t("relays.token.copy")}
            icon={Copy01Icon}
            variant="outline"
            onClick={() => void copyText(created.token, t("relays.token.copied"))}
          />
        </div>
        <span className="text-muted-foreground">{t("relays.token.once")}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-medium">{t("relays.command.title")}</span>
        <div className="flex items-center gap-2">
          <code data-testid="relay-run-command" className="min-w-0 flex-1 break-all bg-muted px-2 py-1">
            {command}
          </code>
          <IconButton
            label={t("relays.command.copy")}
            icon={Copy01Icon}
            variant="outline"
            onClick={() => void copyText(command, t("relays.command.copied"))}
          />
        </div>
        <span className="text-muted-foreground">{t("relays.command.hint")}</span>
      </div>
      <div>
        <Button variant="outline" size="sm" onClick={onDismiss}>
          {t("relays.token.dismiss")}
        </Button>
      </div>
    </div>
  );
}

function RelayList({ relays, failed, removed }: MyRelays): React.JSX.Element {
  return (
    <Card aria-busy={relays === null && !failed}>
      <CardHeader>
        <CardTitle>{t("relays.list.title")}</CardTitle>
        <CardDescription>{t("relays.list.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-xs">
        {failed && <FormError>{t("relays.loadFailed")}</FormError>}
        {relays === null && !failed && <SkeletonText lines={3} />}
        {relays?.length === 0 && (
          <EmptyState
            data-testid="relays-empty"
            icon={ServerStack01Icon}
            title={t("relays.empty.title")}
            description={t("relays.empty.hint")}
            headingLevel={3}
          />
        )}
        {relays && relays.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {relays.map((relay) => (
              <RelayRow key={relay.id} relay={relay} onRemoved={() => removed(relay.id)} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RelayRow({ relay, onRemoved }: { relay: RelayNodeDto; onRemoved: () => void }): React.JSX.Element {
  const { locale } = useLocale();
  const status = relayStatusView(relay.status);
  const { pending, verified, rejected } = relay.receipts30d;

  const remove = async () => {
    await api().relays.remove({ id: relay.id });
    toast.success(t("relays.removed"));
    onRemoved();
  };

  return (
    <li
      data-testid="relay-row"
      data-relay-id={relay.id}
      data-status={relay.status}
      className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-all text-foreground">{relay.name}</span>
            <Badge data-testid="relay-status" variant={status.variant}>
              {status.label}
            </Badge>
          </div>
          <span className="text-muted-foreground">{status.hint}</span>
          <span className="break-all text-muted-foreground">{relay.publicUrl}</span>
        </div>
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
      </div>
      {relay.suspendedReason && (
        <p data-testid="relay-suspended-reason" className="text-destructive">
          {t("relays.suspendedReason", { reason: relay.suspendedReason })}
        </p>
      )}
      <dl className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("relays.bytesVerified")}</dt>
          <dd data-testid="relay-bytes-verified" data-bytes={relay.bytesVerified30d}>
            {formatBytes(relay.bytesVerified30d, locale)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("relays.receipts")}</dt>
          <dd data-testid="relay-receipts" data-pending={pending} data-verified={verified} data-rejected={rejected}>
            {t("relays.receiptsCounts", { verified, pending, rejected })}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("relays.lastReceipt")}</dt>
          <dd>{relay.lastReceiptAt ? <RelativeTime date={relay.lastReceiptAt} /> : t("relays.noReceipts")}</dd>
        </div>
      </dl>
    </li>
  );
}
