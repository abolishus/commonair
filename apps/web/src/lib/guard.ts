// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { redirect } from "@tanstack/react-router";
import type { SessionUser } from "./bootstrap-types.ts";

/**
 * Route guard for signed-in pages: resolves the session (on the server during SSR) and redirects
 * to /signin without rendering anything when there is none.
 */
export async function requireSession(load: () => Promise<SessionUser | null>): Promise<{ me: SessionUser }> {
  const me = await load();
  if (!me) throw redirect({ to: "/signin", replace: true });
  return { me };
}
