// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { authorizeQueryFrom, validateAuthorizeSearch } from "../../components/oauth/authorize-query.ts";
import { ConsentPage, ConsentSkeleton } from "../../components/oauth/consent.tsx";
import { browserNavigator } from "../../components/oauth/shared.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { signOut } from "../../lib/auth.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** OAuth consent for an app's authorization request (E9-consent; ADR 0027 §1). Signed out: sign-in returns here. */
export const Route = createFileRoute("/_app/oauth2/authorize")({
  validateSearch: validateAuthorizeSearch,
  beforeLoad: ({ location }) => requireSession(() => getSessionUser(), { returnTo: location.href }),
  // The query carries `state` and the PKCE challenge: no referrer of it to anything this page loads.
  head: () => ({
    meta: [
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex, nofollow" },
      { title: t("oauth.consent.pageTitle") },
    ],
  }),
  component: AuthorizePage,
});

/** "Not you?": sign out, then sign in again and come back to this same request (`search` as sent). */
async function switchAccount(search: string): Promise<void> {
  const back = `${window.location.pathname}${search}`;
  await signOut();
  // Full load: nothing rendered for the old session survives.
  window.location.assign(`/signin?${new URLSearchParams({ returnTo: back }).toString()}`);
}

// The query never changes under this page (nothing rewrites it), so there is nothing to subscribe to.
const noSubscription = () => () => undefined;
const browserSearch = (): string => window.location.search;
const serverSearch = (): string | null => null;

function AuthorizePage(): React.JSX.Element | null {
  const { me } = useBootstrap();
  // The browser's own query, not the router's: its `searchStr` is re-serialized from the parsed
  // search (`?state="abc"` loses its quotes, `007` becomes 7), and `state` goes back to the app
  // byte for byte. `validateSearch` is an identity, so the router never rewrites the URL itself.
  // The server render (and hydration) has no `window`: `null` there, so it shows the skeleton.
  const raw = React.useSyncExternalStore(noSubscription, browserSearch, serverSearch);
  const query = React.useMemo(() => (raw === null ? null : authorizeQueryFrom(raw)), [raw]);
  const client = React.useMemo(() => api().developer, []);

  // The guard already sent a signed-out visitor to sign in.
  if (!me) return null;
  if (raw === null || query === null) return <ConsentSkeleton label={t("oauth.consent.checking")} />;
  return (
    <ConsentPage
      query={query}
      client={client}
      me={me}
      navigator={browserNavigator}
      onSwitchAccount={() => switchAccount(raw)}
    />
  );
}
