// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ListPanel } from "@commonair/ui/blocks/data";
import { FormSection } from "@commonair/ui/blocks/forms";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { NewRelayToken, RelayTable, type CreatedRelay } from "../../components/relays.tsx";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { field } from "../../lib/form.ts";
import { requireSession } from "../../lib/guard.ts";
import { RELAY_NAME_MAX, RELAYS_POLL_MS, relayName, relayReadmeUrl, type RelayNodeDto } from "../../lib/relays.ts";
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
    <ListPanel
      title={t("relays.howTo.title")}
      items={[
        { id: "step1", title: t("relays.howTo.step1") },
        { id: "step2", title: t("relays.howTo.step2") },
        { id: "step3", title: t("relays.howTo.step3") },
      ]}
      footer={
        readme ? (
          // The label is Button's child; the lint rule cannot see through `render`, so it is named here too.
          <Button
            variant="link"
            nativeButton={false}
            render={<a href={readme} rel="noopener" aria-label={t("relays.howTo.readme")} />}
          >
            {t("relays.howTo.readme")}
          </Button>
        ) : undefined
      }
    />
  );
}

function CreateRelay({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const { config } = useBootstrap();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<CreatedRelay | null>(null);

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
      {created && <NewRelayToken created={created} publicUrl={config.publicUrl} onDismiss={() => setCreated(null)} />}
    </>
  );
}

function RelayList({ relays, failed, removed }: MyRelays): React.JSX.Element {
  return (
    <Card aria-busy={relays === null && !failed}>
      <CardHeader>
        <CardTitle>{t("relays.list.title")}</CardTitle>
        <CardDescription>{t("relays.list.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {failed && <FormError>{t("relays.loadFailed")}</FormError>}
        {(relays !== null || !failed) && <RelayTable relays={relays} onRemoved={removed} />}
      </CardContent>
    </Card>
  );
}
