// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, EmptyState, RelativeTime, StatusBadge, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { CodeBlock } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldTitle } from "@commonair/ui/components/field";
import { ItemContent, ItemDescription, ItemTitle } from "@commonair/ui/components/item";
import { toast } from "@commonair/ui/toast";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { formatBytes, relayRunCommand, relayStatusView, type RelayNodeDto } from "../lib/relays.ts";

/**
 * `/relays` pieces that tests/selectors-render.test.tsx renders: the relay table (whose row ids
 * reach the DOM only through DataTable's `rowProps`) and the one-time token panel.
 */

export interface RelayTableProps {
  /** null while the first load is in flight. */
  relays: RelayNodeDto[] | null;
  onRemoved: (id: string) => void;
}

export function RelayTable({ relays, onRemoved }: RelayTableProps): React.JSX.Element {
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
      cell: ({ row: { original: relay } }) => <RetireRelay relay={relay} onRemoved={() => onRemoved(relay.id)} />,
    },
  ];

  return (
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
  );
}

function RelayIdentity({ relay }: { relay: RelayNodeDto }): React.JSX.Element {
  return (
    <ItemContent>
      <ItemTitle>{relay.name}</ItemTitle>
      <ItemDescription>{relayStatusView(relay.status).hint}</ItemDescription>
      <ItemDescription>{relay.publicUrl}</ItemDescription>
      {relay.suspendedReason && (
        <FieldError data-testid="relay-suspended-reason">
          {t("relays.suspendedReason", { reason: relay.suspendedReason })}
        </FieldError>
      )}
    </ItemContent>
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

export interface CreatedRelay {
  name: string;
  token: string;
}

/**
 * The registration token, shown once right after `relays.create`, and the command that uses it.
 * Both are `CodeBlock`s: the e3 test ids sit on wrappers whose text content is exactly the value.
 */
export function NewRelayToken({
  created,
  publicUrl,
  onDismiss,
}: {
  created: CreatedRelay;
  publicUrl: string;
  onDismiss: () => void;
}): React.JSX.Element {
  const command = relayRunCommand(publicUrl, created.token);
  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle>{t("relays.token.title", { name: created.name })}</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldTitle>{t("relays.token.label")}</FieldTitle>
            <CodeBlock
              value={created.token}
              label={t("relays.token.copy")}
              copiedLabel={t("relays.token.copied")}
              copyFailedLabel={t("relays.copyFailed")}
              data-testid="relay-token"
            />
            <FieldDescription>{t("relays.token.once")}</FieldDescription>
          </Field>
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
