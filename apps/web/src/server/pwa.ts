// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PublicConfig } from "./env.ts";

/** The web app manifest, named from the instance (ADR 0028 decision 7). Stub until N1-pwa fills it. */
export function manifestResponse(_config: PublicConfig): Response {
  return new Response(null, { status: 404 });
}
