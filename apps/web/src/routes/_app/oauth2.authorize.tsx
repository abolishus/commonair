// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { authorizeQueryFrom, validateAuthorizeSearch } from "../../components/oauth/authorize-query.ts";
import { ConsentPage } from "../../components/oauth/consent.tsx";
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

/** "Not you?": sign out, then sign in again and come back to this same request (`searchStr` as sent). */
async function switchAccount(searchStr: string): Promise<void> {
  const back = `${window.location.pathname}${searchStr === "" || searchStr.startsWith("?") ? "" : "?"}${searchStr}`;
  await signOut();
  // Full load: nothing rendered for the old session survives.
  window.location.assign(`/signin?${new URLSearchParams({ returnTo: back }).toString()}`);
}

function AuthorizePage(): React.JSX.Element | null {
  const { me } = useBootstrap();
  // The raw query, not the router's parsed search: `state` goes back to the app byte for byte.
  // Read once, at the first render (the URL as the app sent it): after hydration the router may
  // rewrite the URL from the parsed search (`?state=007` becomes `?state=7`).
  const searchStr = useLocation({ select: (l) => l.searchStr });
  const [raw] = React.useState(searchStr);
  const query = React.useMemo(() => authorizeQueryFrom(raw), [raw]);
  const client = React.useMemo(() => api().developer, []);

  // The guard already sent a signed-out visitor to sign in.
  if (!me) return null;
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
