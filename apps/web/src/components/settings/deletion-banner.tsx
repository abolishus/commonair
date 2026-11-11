// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The banner at the top of every settings page while a deletion is scheduled (D7.4, J6 step 6):
 * the date, and Cancel deletion right there. Persistent: it has no dismiss, because the account
 * is really going.
 */
import { formatDateTime, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { fillNode } from "../../lib/fill.tsx";
import { scheduledRequest, useDeletion } from "./deletion-state.tsx";

/** The scheduled date as a `<time>`, in the viewer's locale and zone. */
export function DeletionDate({ iso }: { iso: string }): React.JSX.Element {
  const { locale, timeZone } = useLocale();
  const date = new Date(iso);
  return (
    <time dateTime={iso} className="font-medium">
      {Number.isNaN(date.getTime()) ? iso : formatDateTime(date, locale, timeZone)}
    </time>
  );
}

export function DeletionBanner(): React.JSX.Element | null {
  const deletion = useDeletion();
  const [busy, setBusy] = React.useState(false);
  const scheduled = scheduledRequest(deletion.request);
  if (!scheduled) return null;
  const cancel = async () => {
    setBusy(true);
    try {
      await deletion.cancel();
    } catch (err) {
      toastActionError(err, t("d7Settings.delete.cancelFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertCallout
      data-testid="deletion-banner"
      data-scheduled-for={scheduled.scheduledFor}
      tone="warning"
      title={fillNode(t("d7Settings.banner.title"), "date", <DeletionDate iso={scheduled.scheduledFor} />)}
      description={t("d7Settings.banner.body")}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="deletion-banner-cancel"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void cancel()}
        >
          {t("d7Settings.banner.cancel")}
        </Button>
      }
    />
  );
}
