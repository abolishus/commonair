// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Tell me if they move" (ADR 0037 decision 3, batch 7 decision (l)) on `/settings/privacy`: per
 * followed channel, whether the viewer may be emailed **once** if that channel moves. The streamer
 * never sees who asked; the request is deleted after the one email. `FollowGrantToggle` is the
 * same switch for a channel's follow menu.
 */
import { ChannelAvatar, EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Switch } from "@commonair/ui/components/switch";
import { DeliveryTruck01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";

export interface GrantRow {
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  on: boolean;
}

/** Followed channels and the channels with a grant, merged and sorted by name. */
export function grantRows(
  follows: readonly { slug: string; displayName: string; avatarUrl: string | null }[],
  grants: readonly { slug: string; displayName: string; avatarUrl: string | null }[],
): GrantRow[] {
  const rows = new Map<string, GrantRow>();
  for (const f of follows) rows.set(f.slug, { ...f, on: false });
  for (const g of grants) rows.set(g.slug, { ...g, on: true });
  return [...rows.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface GrantsViewProps {
  rows: readonly GrantRow[] | null;
  loadFailed: boolean;
  busy: ReadonlySet<string>;
  onToggle: (slug: string, on: boolean) => void;
}

export function GrantsView({ rows, loadFailed, busy, onToggle }: GrantsViewProps): React.JSX.Element {
  return (
    <Card data-testid="portability-grants">
      <CardHeader>
        <CardTitle>{t("portability.grants.title")}</CardTitle>
        <CardDescription>{t("portability.grants.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2">
        {loadFailed ? (
          <FormError>{t("portability.grants.loadFailed")}</FormError>
        ) : rows === null ? (
          <SkeletonGroup label={t("portability.grants.loading")}>
            <SkeletonText lines={3} />
          </SkeletonGroup>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={DeliveryTruck01Icon}
            headingLevel={3}
            title={t("portability.grants.empty")}
            description={t("portability.grants.emptyHint")}
          />
        ) : (
          <ul className="flex min-w-0 flex-col divide-y" aria-label={t("portability.grants.listLabel")}>
            {rows.map((r) => (
              <li
                key={r.slug}
                data-testid="portability-grant"
                data-channel={r.slug}
                data-state={r.on ? "on" : "off"}
                className="flex min-w-0 items-center gap-3 py-2"
              >
                <ChannelAvatar name={r.displayName} src={r.avatarUrl} size="sm" decorative />
                <GrantSwitch row={r} busy={busy.has(r.slug)} onToggle={onToggle} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function GrantSwitch({
  row,
  busy,
  onToggle,
}: {
  row: GrantRow;
  busy: boolean;
  onToggle: (slug: string, on: boolean) => void;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <Field orientation="horizontal" className="min-w-0 flex-1 justify-between">
      <FieldLabel htmlFor={id} className="min-w-0 break-words font-normal">
        {t("portability.grants.row", { channel: row.displayName })}
      </FieldLabel>
      <Switch
        id={id}
        data-testid="portability-grant-toggle"
        data-state={row.on ? "on" : "off"}
        checked={row.on}
        disabled={busy}
        onCheckedChange={(on: boolean) => onToggle(row.slug, on)}
      />
    </Field>
  );
}

/** The `/settings/privacy` section. */
export function PortabilityGrants(): React.JSX.Element {
  const [rows, setRows] = React.useState<GrantRow[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());

  React.useEffect(() => {
    let cancelled = false;
    // Async, so a client that cannot make the call at all fails like a failed load.
    const load = async () => Promise.all([api().me.follows({ limit: 100 }), api().portability.grants.mine()]);
    load()
      .then(([f, g]) => {
        if (cancelled) return;
        setRows(
          grantRows(
            f.items.map((i) => i.channel),
            g.map((x) => x.channel),
          ),
        );
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = (slug: string, on: boolean) => {
    setBusy((b) => new Set([...b, slug]));
    api()
      .portability.grants.set({ channel: slug, enabled: on })
      .then((r) => setRows((rs) => rs?.map((x) => (x.slug === slug ? { ...x, on: r.enabled } : x)) ?? rs))
      .catch((err: unknown) => toastActionError(err, t("portability.grants.saveFailed")))
      .finally(() =>
        setBusy((b) => {
          const next = new Set(b);
          next.delete(slug);
          return next;
        }),
      );
  };

  return <GrantsView rows={rows} loadFailed={failed} busy={busy} onToggle={onToggle} />;
}

/**
 * The same switch for one channel, for its follow menu (shown only to a follower). Mounted by the
 * channel page's follow control (a contract request: `components/channel-follow.tsx`).
 */
export function FollowGrantToggle({
  channel,
  displayName,
  initial,
}: {
  channel: string;
  displayName: string;
  /** `Channel.viewer.portabilityGrant`. */
  initial: boolean;
}): React.JSX.Element {
  // Mounted with `key` on the channel, so a new `initial` is a new component.
  const [on, setOn] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  return (
    <GrantSwitch
      row={{ slug: channel, displayName, avatarUrl: null, on }}
      busy={busy}
      onToggle={(_, next) => {
        setBusy(true);
        api()
          .portability.grants.set({ channel, enabled: next })
          .then((r) => setOn(r.enabled))
          .catch((err: unknown) => toastActionError(err, t("portability.grants.saveFailed")))
          .finally(() => setBusy(false));
      }}
    />
  );
}
