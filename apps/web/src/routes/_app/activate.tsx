// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { z } from "zod";
import { DeviceActivation } from "../../components/oauth/device.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/**
 * `?code=` from the device's verification link; anything else is dropped. A value the router's
 * parser turned into a number stays one here (an identity, so the rebuilt URL never gains quotes);
 * the page turns it into text.
 */
const ActivateSearch = z.object({
  code: z
    .union([z.string().max(32), z.number()])
    .optional()
    .catch(undefined),
});

/** Device activation: enter a device's user code, then consent (E9-consent; RFC 8628). Signed out: sign-in returns here. */
export const Route = createFileRoute("/_app/activate")({
  validateSearch: (search: Record<string, unknown>): { code?: string | number } => {
    const { code } = ActivateSearch.parse(search);
    return code === undefined ? {} : { code };
  },
  beforeLoad: ({ location }) => requireSession(() => getSessionUser(), { returnTo: location.href }),
  // A prefilled code is in the query: never pass it on as a referrer.
  head: () => ({
    meta: [
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex, nofollow" },
      { title: t("oauth.device.pageTitle") },
    ],
  }),
  component: ActivatePage,
});

function ActivatePage(): React.JSX.Element {
  const { code } = Route.useSearch();
  const client = React.useMemo(() => api().developer, []);
  return <DeviceActivation client={client} initialCode={code === undefined ? undefined : String(code)} />;
}
