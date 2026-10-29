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
  /** `p2pDefault`: the operator's `P2P_DEFAULT` (`instance.info` `features.p2pDefault`). */
  instance: { name: string; sourceUrl: string | null; p2pDefault: "off" | "on" };
  me: SessionUser | null;
  theme: Theme;
  /** Server time of the request, so relative times hydrate identically. */
  now: number;
  /** The negotiated locale (ADR 0029: `Me.locale`, cookie, Accept-Language, instance default). */
  locale: string;
  /** Its text direction, for `<html dir>`. */
  dir: "ltr" | "rtl";
}
