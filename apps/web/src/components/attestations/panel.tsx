// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The owner's signed audience attestations (`integrity.attestations.*`, ADR 0014;
 * docs/testing/w2-selectors.md "Analytics, group appeals and attestations"): each published entry
 * of the channel's chain (or one broadcast's), its figures, the signed envelope to copy for a
 * sponsor, the breakdown its commitment hides, and expiring share links that reveal that breakdown
 * (create, copy once, revoke). For the analytics page to mount.
 */
import type { AttestationEntry, AttestationShareLink } from "@commonair/contracts/dto";
import { EXCLUSION_CATEGORIES } from "@commonair/contracts/enums";
import {
  ConfirmDialog,
  EmptyState,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  ViewerCount,
  useLocale,
} from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { CopyField } from "@commonair/ui/blocks/forms";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { CheckmarkBadge01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { hoursOf } from "../analytics/data.ts";
import { FormError } from "../form-error.tsx";
import { useLoad } from "../money/use-load.ts";
import { type AttestationsClient, attestationsClient } from "./client.ts";
import { CATEGORY_KEYS, KIND_KEYS } from "./labels.ts";
import { decodePayload, envelopeJson } from "./statement.ts";

export interface AttestationsPanelProps {
  /** The owner's channel slug. */
  channel: string;
  /** One broadcast's entries; absent for the channel's whole chain. */
  broadcastId?: string;
  client?: AttestationsClient;
}

const VERIFY_PATH = "/attestations/verify";

export function AttestationsPanel({
  channel,
  broadcastId,
  client: clientProp,
}: AttestationsPanelProps): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? attestationsClient());
  const list = useLoad(`attestations|${channel}`, () => client.list({ channel }));
  const links = useLoad(`attestation-links|${channel}`, () => client.shareLinks({ channel }));
  const [created, setCreated] = React.useState<{ id: string; url: string } | null>(null);
  const entries = (list.data?.items ?? []).filter((e) => broadcastId === undefined || e.broadcastId === broadcastId);
  const ids = new Set(entries.map((e) => e.id));
  const seqOf = new Map(entries.map((e) => [e.id, e.seq]));
  const mine = (links.data?.items ?? []).filter((l) => ids.has(l.attestationId));

  return (
    <Section
      data-testid="attestations-panel"
      heading={t("attestations.panel.heading")}
      description={t("attestations.panel.description")}
      action={
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to={VERIFY_PATH} />}>
          {t("attestations.panel.verifyLink")}
        </Button>
      }
    >
      {list.failed ? (
        <div className="flex flex-col items-start gap-3">
          <FormError>{t("attestations.panel.loadFailed")}</FormError>
          <Button variant="outline" size="sm" onClick={list.reload}>
            {t("attestations.panel.retry")}
          </Button>
        </div>
      ) : list.data === null ? (
        <SkeletonGroup label={t("attestations.panel.loading")}>
          <SkeletonText lines={4} />
        </SkeletonGroup>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={CheckmarkBadge01Icon}
          title={t("attestations.panel.empty.title")}
          description={t("attestations.panel.empty.description")}
          headingLevel={3}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {entries.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              channel={channel}
              client={client}
              createdUrl={created?.id === e.id ? created.url : null}
              onShared={(url) => {
                setCreated({ id: e.id, url });
                links.reload();
              }}
            />
          ))}
        </ul>
      )}
      <ShareLinks
        links={mine}
        failed={links.failed}
        loaded={links.data !== null}
        seqOf={seqOf}
        channel={channel}
        client={client}
        onRevoked={links.reload}
      />
    </Section>
  );
}

function EntryRow({
  entry: e,
  channel,
  client,
  createdUrl,
  onShared,
}: {
  entry: AttestationEntry;
  channel: string;
  client: AttestationsClient;
  createdUrl: string | null;
  onShared: (url: string) => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  const [busy, setBusy] = React.useState(false);
  const f = decodePayload(e.envelope.payload);
  const hours = (s: number) => t("attestations.entry.hours", { hours: hoursOf(s, locale) });
  const share = () => {
    setBusy(true);
    client
      .share({ channel, id: e.id })
      .then((link) => {
        if (link.url) onShared(link.url);
        toast.success(t("attestations.share.created"));
      })
      .catch((err: unknown) => toastActionError(err, t("attestations.share.createFailed")))
      .finally(() => setBusy(false));
  };
  const breakdown = EXCLUSION_CATEGORIES.flatMap((c) => {
    const s = e.breakdown?.[c];
    return s ? [{ term: t(CATEGORY_KEYS[c]), value: hours(s) }] : [];
  });
  return (
    <li
      data-testid="attestation-entry"
      data-seq={e.seq}
      data-kind={e.kind}
      data-broadcast-id={e.broadcastId}
      data-entry-hash={e.entryHash}
      data-superseded={e.superseded ? "true" : "false"}
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("attestations.entry.title", { seq: e.seq })}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral">{t(KIND_KEYS[e.kind])}</StatusBadge>
          {e.superseded ? (
            <StatusBadge tone="warning">{t("attestations.entry.superseded")}</StatusBadge>
          ) : (
            <StatusBadge tone="success">{t("attestations.entry.current")}</StatusBadge>
          )}
        </div>
      </div>
      {f ? (
        <KeyValueList
          rows={[
            { term: t("attestations.entry.signed"), value: <RelativeTime date={e.signedAt} /> },
            { term: t("attestations.entry.verifiedHours"), value: hours(f.verifiedViewerSeconds) },
            {
              term: t("attestations.entry.peak"),
              value: <ViewerCount count={f.peakVerifiedConcurrent} icon={false} />,
            },
            { term: t("attestations.entry.excludedHours"), value: hours(f.excludedViewerSeconds) },
          ]}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("attestations.entry.unreadable")}</p>
      )}
      {breakdown.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">{t("attestations.entry.breakdown")}</p>
          <KeyValueList dense rows={breakdown} />
        </div>
      ) : null}
      <CopyField
        label={t("attestations.entry.statement")}
        value={envelopeJson(e)}
        hint={t("attestations.entry.statementHint")}
        copyLabel={t("attestations.copy")}
        copiedLabel={t("attestations.copied")}
        copyFailedLabel={t("attestations.copyFailed")}
      />
      <div>
        <Button data-testid="attestation-share-create" size="sm" variant="outline" onClick={share} disabled={busy}>
          {t("attestations.share.create")}
        </Button>
      </div>
      {createdUrl ? (
        <CopyField
          label={t("attestations.share.url")}
          value={createdUrl}
          hint={t("attestations.share.urlHint")}
          copyLabel={t("attestations.copy")}
          copiedLabel={t("attestations.copied")}
          copyFailedLabel={t("attestations.copyFailed")}
        />
      ) : null}
    </li>
  );
}

function ShareLinks({
  links,
  failed,
  loaded,
  seqOf,
  channel,
  client,
  onRevoked,
}: {
  links: readonly AttestationShareLink[];
  failed: boolean;
  loaded: boolean;
  seqOf: ReadonlyMap<string, number>;
  channel: string;
  client: AttestationsClient;
  onRevoked: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t("attestations.share.heading")}</h3>
      {failed ? <FormError>{t("attestations.share.loadFailed")}</FormError> : null}
      {loaded && links.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("attestations.share.none")}</p>
      ) : null}
      {links.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {links.map((l) => (
            <li
              key={l.id}
              data-testid="attestation-share-link"
              data-link-id={l.id}
              data-expires-at={l.expiresAt}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <span className="text-sm">
                {t("attestations.share.forStatement", { seq: seqOf.get(l.attestationId) ?? 0 })}
                {" · "}
                {l.revokedAt ? (
                  <>
                    {t("attestations.share.revoked")} <RelativeTime date={l.revokedAt} />
                  </>
                ) : (
                  <>
                    {t("attestations.share.expires")} <RelativeTime date={l.expiresAt} />
                  </>
                )}
              </span>
              {l.revokedAt ? null : (
                <ConfirmDialog
                  trigger={
                    <Button data-testid="attestation-share-revoke" variant="outline" size="sm">
                      {t("attestations.share.revoke")}
                    </Button>
                  }
                  title={t("attestations.share.revokeTitle")}
                  description={t("attestations.share.revokeDescription")}
                  confirmLabel={t("attestations.share.revokeConfirm")}
                  variant="destructive"
                  onConfirm={async () => {
                    await client.revoke({ channel, id: l.id });
                    toast.success(t("attestations.share.revokedToast"));
                    onRevoked();
                  }}
                  onError={(err) => toastActionError(err, t("attestations.share.revokeFailed"))}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
