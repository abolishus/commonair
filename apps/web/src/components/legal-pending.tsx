// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api, type Api } from "../lib/api.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { LegalDocumentList, type LegalDoc } from "./legal-document-link.tsx";

export type PendingLegal = Awaited<ReturnType<Api["me"]["get"]>>["pendingLegal"][number];

/** The current documents that match what `me.pendingLegal` names (same kind and version). */
export function matchPending<D extends Pick<LegalDoc, "kind" | "version">>(
  pending: readonly PendingLegal[],
  current: readonly D[],
): D[] {
  return current.filter((d) => pending.some((p) => p.kind === d.kind && p.version === d.version));
}

/**
 * Banner asking a signed-in user to accept updated legal documents (`me.pendingLegal`). Mounted
 * once in the `_app` shell, which also wraps signed-out pages: it renders nothing without a
 * session. It never blocks the page; until the documents are accepted it comes back on every load.
 */
export function LegalPending(): React.JSX.Element | null {
  const { me } = useBootstrap();
  return me ? <LegalPendingBanner key={me.id} /> : null;
}

interface PendingState {
  pending: PendingLegal[];
  /** The current documents behind `pending`, for the links. */
  docs: LegalDoc[];
}

const NOTHING_PENDING: PendingState = { pending: [], docs: [] };

async function fetchPending(): Promise<PendingState> {
  const me = await api().me.get();
  if (me.pendingLegal.length === 0) return NOTHING_PENDING;
  return { pending: me.pendingLegal, docs: matchPending(me.pendingLegal, await api().legal.current()) };
}

function LegalPendingBanner(): React.JSX.Element | null {
  const [{ pending, docs }, setState] = React.useState<PendingState>(NOTHING_PENDING);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    fetchPending()
      .then((s) => {
        if (live) setState(s);
      })
      // A failed check is not worth an error on every page: the banner just stays hidden.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const refresh = () =>
    fetchPending()
      .then(setState)
      .catch(() => {});

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Resolve ids at click time: a version published since the page loaded is not accepted unseen.
      const ids = matchPending(pending, await api().legal.current()).map((d) => d.id);
      if (ids.length === 0) throw new Error("no current document matches");
      await api().me.acceptLegal({ documentIds: ids });
      await refresh();
    } catch {
      toast.error(t("legal.pending.failed"));
      // A newer version may have been published meanwhile: show what is pending now.
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (pending.length === 0) return null;
  return (
    <PageContainer className="pt-4">
      <AlertCallout
        tone="info"
        data-testid="legal-pending"
        data-kinds={pending.map((p) => p.kind).join(",")}
        title={t("legal.pending.title")}
        description={
          <p>
            {t("legal.pending.body")}
            {docs.length > 0 && (
              <>
                {" "}
                <LegalDocumentList docs={docs} />
              </>
            )}
          </p>
        }
        action={
          <Button
            data-testid="legal-pending-accept"
            size="sm"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void accept()}
          >
            {t("legal.pending.accept")}
          </Button>
        }
      />
    </PageContainer>
  );
}
