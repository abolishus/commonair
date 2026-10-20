// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Me } from "@commonair/contracts/dto";
import type { Theme } from "@commonair/ui";
import type { PublicConfig } from "../server/env.ts";

export type { PublicConfig } from "../server/env.ts";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  channelSlug: string | null;
  /** Platform role; the web only uses it to show operator pages (the API enforces access). */
  role: Me["role"];
}

/** Root loader data: everything the shell needs before any page renders. */
export interface Bootstrap {
  config: PublicConfig;
  instance: { name: string; sourceUrl: string | null };
  me: SessionUser | null;
  theme: Theme;
  /** Server time of the request, so relative times hydrate identically. */
  now: number;
}
