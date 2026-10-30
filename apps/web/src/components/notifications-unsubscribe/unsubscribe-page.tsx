// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The email unsubscribe confirm page (ADR 0028 decision 4, Amendment 1): `GET
 * /api/email/unsubscribe` redirects here with the same `list` and `token`, so a mail scanner's
 * prefetch never unsubscribes anyone. Works signed out: the token is the authority. Mail clients
 * that support RFC 8058 unsubscribe in one click without this page.
 */
import { UNSUBSCRIBE_LISTS } from "@commonair/contracts/enums";
import { NOTIFICATION_SETTINGS_PATH } from "@commonair/contracts/notify";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/keys/index.gen.ts";
import { api, errorCode } from "../../lib/api.ts";

export type UnsubscribeList = (typeof UNSUBSCRIBE_LISTS)[number];

export interface UnsubscribeInput {
  list: UnsubscribeList;
  token: string;
}

/** The token's shape (`v1.<b64url>.<b64url>`, packages/tokens); the API decides whether it is genuine. */
const TOKEN = /^v1\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}$/;

/** The page's query, or null when it is missing or malformed (the page then shows the invalid state). */
export function parseUnsubscribeSearch(search: { list?: string; token?: string }): UnsubscribeInput | null {
  const { list, token } = search;
  if (list === undefined || !(UNSUBSCRIBE_LISTS as readonly string[]).includes(list)) return null;
  if (token === undefined || token.length > 200 || !TOKEN.test(token)) return null;
  return { list: list as UnsubscribeList, token };
}

const TITLE: Record<UnsubscribeList, MessageKey> = {
  go_live: "unsubscribe.title.go_live",
  governance: "unsubscribe.title.governance",
};
const INTRO: Record<UnsubscribeList, MessageKey> = {
  go_live: "unsubscribe.intro.go_live",
  governance: "unsubscribe.intro.governance",
};
const DONE: Record<UnsubscribeList, MessageKey> = {
  go_live: "unsubscribe.done.go_live",
  governance: "unsubscribe.done.governance",
};

const applyViaApi = (input: UnsubscribeInput) => api().notifications.unsubscribe(input);

function SettingsLink({ variant }: { variant: "default" | "outline" }): React.JSX.Element {
  // Sign-in is required there; the settings route guard sends a signed-out visitor to sign in.
  return (
    <Button variant={variant} nativeButton={false} render={<Link to={NOTIFICATION_SETTINGS_PATH} />}>
      {t("unsubscribe.settings")}
    </Button>
  );
}

export function UnsubscribePage({
  list,
  token,
  apply = applyViaApi,
}: {
  list?: string | undefined;
  token?: string | undefined;
  /** Tests pass a fake; `notifications.unsubscribe` otherwise. */
  apply?: (input: UnsubscribeInput) => Promise<{ list: UnsubscribeList }>;
}): React.JSX.Element {
  const parsed = React.useMemo(
    () =>
      parseUnsubscribeSearch({ ...(list !== undefined ? { list } : {}), ...(token !== undefined ? { token } : {}) }),
    [list, token],
  );
  const [state, setState] = React.useState<"ready" | "pending" | "done" | "invalid">(parsed ? "ready" : "invalid");

  const unsubscribeNow = async () => {
    if (!parsed) return;
    setState("pending");
    try {
      await apply(parsed);
      setState("done");
    } catch (err) {
      const code = errorCode(err);
      if (code === "BAD_REQUEST") {
        setState("invalid");
        return;
      }
      toast.error(code === "RATE_LIMITED" ? t("error.rateLimited") : t("unsubscribe.failed"));
      setState("ready");
    }
  };

  let content: React.JSX.Element;
  if (!parsed || state === "invalid")
    content = (
      <div data-testid="unsubscribe-invalid">
        <PageHeader
          title={t("unsubscribe.invalid.title")}
          description={t("unsubscribe.invalid.body")}
          actions={<SettingsLink variant="outline" />}
        />
      </div>
    );
  else if (state === "done")
    content = (
      <div data-testid="unsubscribe-done">
        <PageHeader
          title={t("unsubscribe.done.title")}
          description={t(DONE[parsed.list])}
          actions={<SettingsLink variant="outline" />}
        />
      </div>
    );
  else
    content = (
      <PageHeader
        title={t(TITLE[parsed.list])}
        description={t(INTRO[parsed.list])}
        actions={
          <Button
            data-testid="unsubscribe-confirm"
            type="button"
            disabled={state === "pending"}
            aria-busy={state === "pending" || undefined}
            onClick={() => void unsubscribeNow()}
          >
            {t("unsubscribe.confirm")}
          </Button>
        }
      />
    );

  return (
    <PageContainer data-testid="unsubscribe-page" data-list={parsed?.list ?? ""} className="py-8">
      {/* Always mounted, so screen readers announce the outcome when it replaces the question. */}
      <div aria-live="polite">{content}</div>
    </PageContainer>
  );
}
