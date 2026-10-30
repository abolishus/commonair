// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Me } from "@commonair/contracts/dto";
import type { Theme } from "@commonair/ui";
import type { PublicConfig } from "../server/env.ts";
import type { StoredConsent } from "./consent.ts";

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
  /**
   * `p2pDefault`: the operator's `P2P_DEFAULT` (`instance.info` `features.p2pDefault`).
   * `chatSafety`: `features.watchGate || features.surgeGuard`, which shows the studio's `/chat` page.
   */
  instance: { name: string; sourceUrl: string | null; p2pDefault: "off" | "on"; chatSafety: boolean };
  me: SessionUser | null;
  theme: Theme;
  /** Server time of the request, so relative times hydrate identically. */
  now: number;
  /** The negotiated locale (ADR 0029: `Me.locale`, cookie, Accept-Language, instance default). */
  locale: string;
  /** Its text direction, for `<html dir>`. */
  dir: "ltr" | "rtl";
  /** The signed-in member's saved `Me.locale` decided `locale`: a tab-only choice must not override it. */
  localeFromUser: boolean;
  /** The cookie consent stored in the request's cookie, or null: SSR shows the banner exactly when the client will. */
  consent: StoredConsent | null;
}
