// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute, redirect } from "@tanstack/react-router";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * Bare `/settings` has no page of its own: without this the layout would match it and render an
 * empty outlet. It goes to Account (D7.1), whose own guard sends a signed-out visitor to sign in.
 */
export const Route = createFileRoute("/_app/settings/")({
  // Never rendered (beforeLoad always redirects); the page-title policy wants one on every route.
  head: () => titleHead(t("settings.title")),
  beforeLoad: () => {
    throw redirect({ to: "/settings/account", replace: true });
  },
});
