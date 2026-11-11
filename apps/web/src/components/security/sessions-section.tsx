// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Security, section 4 (D7.2, anchor `#sessions`, where the new-sign-in mail links): every signed-in
 * device as a row (stacked below `sm`), named from its user agent in the browser, never with an
 * address; "This device" first, "Sign out" on the others and "Sign out everywhere else".
 */
import { ConfirmDialog, RelativeTime, SkeletonText, StatusBadge } from "@commonair/ui";
import { SettingsSection } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { ComputerIcon, SmartPhone01Icon, Tablet01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { fillNode } from "../../lib/fill.tsx";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { currentSessionId, listSessions, revokeOtherSessions, revokeSession } from "./api.ts";
import { securityErrorMessage } from "./errors.ts";
import { deviceText, orderSessions, parseUserAgent, type AuthSessionRow, type DeviceKind } from "./session-summary.ts";

const KIND_ICON = { phone: SmartPhone01Icon, tablet: Tablet01Icon, computer: ComputerIcon } satisfies Record<
  DeviceKind,
  unknown
>;

interface SessionsData {
  rows: AuthSessionRow[];
  currentId: string | null;
}

async function loadSessions(): Promise<SessionsData> {
  const [rows, currentId] = await Promise.all([listSessions(), currentSessionId()]);
  return { rows: orderSessions(rows, currentId), currentId };
}

export function SessionsSection(): React.JSX.Element {
  const loaded = useRetryingLoad("security:sessions", loadSessions);
  const title = t("d7Security.sessions.title");
  const data = loaded.data;
  const others = data ? data.rows.filter((s) => s.id !== data.currentId) : [];

  return (
    <SettingsSection
      id="sessions"
      title={title}
      description={t("d7Security.sessions.intro")}
      data-testid="security-sessions"
      action={
        others.length > 0 ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline" size="sm" data-testid="security-sessions-revoke-others">
                {t("d7Security.sessions.signOutOthers")}
              </Button>
            }
            title={t("d7Security.sessions.signOutOthersTitle")}
            description={t("d7Security.sessions.signOutOthersBody")}
            confirmLabel={t("d7Security.sessions.signOutOthers")}
            onConfirm={async () => {
              await revokeOtherSessions();
              toast.success(t("d7Security.sessions.signedOutOthers"));
              loaded.reload();
            }}
            onError={(err) => toast.error(securityErrorMessage(err))}
          />
        ) : undefined
      }
    >
      {loaded.state === "loading" && (
        <div className="px-4 py-4 sm:px-6">
          <SkeletonText lines={3} />
        </div>
      )}
      {loaded.state === "failed" && (
        <div className="px-4 py-4 sm:px-6">
          <SectionLoadError section={title} load={loaded} headingLevel={3} />
        </div>
      )}
      {data && (
        <ul aria-label={t("d7Security.sessions.list")} className="divide-y">
          {data.rows.map((s) => (
            <li key={s.id}>
              <SessionItem session={s} current={s.id === data.currentId} onRevoked={loaded.reload} />
            </li>
          ))}
        </ul>
      )}
      <p className="px-4 py-3 text-sm text-muted-foreground sm:px-6">{t("d7Security.sessions.privacy")}</p>
    </SettingsSection>
  );
}

function SessionItem({
  session,
  current,
  onRevoked,
}: {
  session: AuthSessionRow;
  current: boolean;
  onRevoked: () => void;
}): React.JSX.Element {
  const device = parseUserAgent(session.userAgent);
  const [pending, setPending] = React.useState(false);
  const signOut = async () => {
    if (pending) return;
    setPending(true);
    try {
      await revokeSession(session.token);
      toast.success(t("d7Security.sessions.signedOut"));
      onRevoked();
    } catch (err) {
      toast.error(securityErrorMessage(err));
      setPending(false);
    }
  };
  return (
    <div
      data-testid="security-session-row"
      data-current={current ? "true" : "false"}
      className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <div className="flex min-w-0 items-start gap-3">
        <HugeiconsIcon icon={KIND_ICON[device.kind]} strokeWidth={2} aria-hidden className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {deviceText(device)}
            {current && <StatusBadge tone="success">{t("d7Security.sessions.thisDevice")}</StatusBadge>}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {fillNode(t("d7Security.sessions.active"), "time", <RelativeTime date={session.updatedAt} />)}
            {" · "}
            {fillNode(
              t("d7Security.sessions.signedIn"),
              "time",
              <RelativeTime date={session.createdAt} live={false} />,
            )}
          </p>
        </div>
      </div>
      {!current && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="security-session-revoke"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void signOut()}
        >
          {t("d7Security.sessions.signOut")}
        </Button>
      )}
    </div>
  );
}
