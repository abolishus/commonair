// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/move` (ADR 0037): loads the channel's move links and its "moved to", and wires `MovePanel`'s
 * actions to `portability.*`. The new link's address is held only in this component's state, so it
 * is shown once and gone on reload (the API never shows it again).
 */
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import { ImportCard } from "./import-card.tsx";
import { expiresAtFor, type ExpiryChoice, type MoveLinkDto } from "./lib.ts";
import { MovePanel, type CreatedLink } from "./move-panel.tsx";
import { useLoad } from "../money/use-load.ts";

type MovedTo = { url: string; at: string } | null;
interface Loaded {
  links: MoveLinkDto[];
  movedTo: MovedTo;
  /** When the links were read: link states are judged against it. */
  at: number;
}

export function MovePage({ channel }: { channel: string }): React.JSX.Element {
  const loaded = useLoad<Loaded>(channel, async () => {
    const [links, c] = await Promise.all([api().portability.links.list({ channel }), api().channels.get({ channel })]);
    return { links, movedTo: c.movedTo ?? null, at: Date.now() };
  });
  const [created, setCreated] = React.useState<CreatedLink | null>(null);
  // The answer of the last move action, until the next load catches up.
  const [movedOverride, setMovedOverride] = React.useState<{ value: MovedTo } | null>(null);
  const movedTo = movedOverride ? movedOverride.value : (loaded.data?.movedTo ?? null);
  const load = async () => loaded.reload();

  return (
    <MovePanel
      links={loaded.data?.links ?? null}
      created={created}
      movedTo={movedTo}
      loadFailed={loaded.failed}
      nowMs={loaded.data?.at ?? 0}
      onCreate={async (expiry: ExpiryChoice) => {
        try {
          const link = await api().portability.links.create({ channel, expiresAt: expiresAtFor(expiry, Date.now()) });
          setCreated({ id: link.id, url: link.url });
          toast.success(t("portability.links.createdToast"));
          await load();
        } catch (err) {
          const code = errorCode(err);
          toastActionError(
            err,
            code === "CONFLICT"
              ? t("portability.links.tooManyActive")
              : code === "RATE_LIMITED"
                ? t("portability.links.tooManyToday")
                : t("portability.links.createFailed"),
          );
        }
      }}
      onCopy={async (url) => {
        try {
          await navigator.clipboard.writeText(url);
          toast.success(t("portability.links.copied"));
        } catch {
          toast.error(t("portability.links.copyFailed"));
        }
      }}
      onRevoke={async (id) => {
        try {
          await api().portability.links.revoke({ channel, id });
          if (created?.id === id) setCreated(null);
          toast.success(t("portability.links.revoked"));
          await load();
        } catch (err) {
          toastActionError(err, t("portability.links.revokeFailed"));
          throw err;
        }
      }}
      onSetMovedTo={async (url) => {
        try {
          const r = await api().portability.move.set({ channel, movedTo: url });
          setMovedOverride({ value: r.movedTo && r.movedAt ? { url: r.movedTo, at: r.movedAt } : null });
          toast.success(t("portability.moved.saved"));
        } catch (err) {
          toastActionError(err, t("portability.moved.saveFailed"));
          throw err;
        }
      }}
      onClearMovedTo={async () => {
        try {
          await api().portability.move.clear({ channel });
          setMovedOverride({ value: null });
          toast.success(t("portability.moved.cleared"));
        } catch (err) {
          toastActionError(err, t("portability.moved.saveFailed"));
          throw err;
        }
      }}
      onExport={async () => {
        try {
          await api().portability.bundle.create({ channel });
          toast.success(t("portability.export.requested"));
        } catch (err) {
          toastActionError(
            err,
            errorCode(err) === "RATE_LIMITED" ? t("portability.export.cooldown") : t("portability.export.failed"),
          );
        }
      }}
      importCard={<ImportCard channel={channel} />}
    />
  );
}
