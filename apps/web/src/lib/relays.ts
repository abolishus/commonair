// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers for the `/relays` page: status badges, byte sizes, the run command, links. */
import type { RelayNode } from "@commonair/contracts/dto";
import { RELAY_STATUSES } from "@commonair/contracts/enums";
import type { StatusTone } from "@commonair/ui";
import type { z } from "zod";
import { t, type MessageKey } from "../i18n/index.ts";

export type RelayNodeDto = z.infer<typeof RelayNode>;
export type RelayStatus = (typeof RELAY_STATUSES)[number];
export { RELAY_STATUSES };

export const RELAYS_POLL_MS = 10_000;
export const RELAY_NAME_MAX = 50;

// `StatusBadge` tones: suspension is the only danger state, active the only success state.
type RelayTone = Extract<StatusTone, "neutral" | "success" | "warning" | "danger">;

export interface RelayStatusBadge {
  key: MessageKey;
  hintKey: MessageKey;
  tone: RelayTone;
}

/** One badge per `RELAY_STATUSES` value; the record type makes a new status a compile error here. */
export const RELAY_STATUS_BADGES: Record<RelayStatus, RelayStatusBadge> = {
  pending: { key: "relays.status.pending", hintKey: "relays.status.pendingHint", tone: "neutral" },
  active: { key: "relays.status.active", hintKey: "relays.status.activeHint", tone: "success" },
  degraded: { key: "relays.status.degraded", hintKey: "relays.status.degradedHint", tone: "warning" },
  suspended: { key: "relays.status.suspended", hintKey: "relays.status.suspendedHint", tone: "danger" },
  offline: { key: "relays.status.offline", hintKey: "relays.status.offlineHint", tone: "neutral" },
};

export interface RelayStatusView {
  label: string;
  hint: string;
  tone: RelayTone;
}

export function relayStatusView(status: RelayStatus): RelayStatusView {
  const b = RELAY_STATUS_BADGES[status];
  return { label: t(b.key), hint: t(b.hintKey), tone: b.tone };
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"] as const;

/**
 * A byte count in SI units (1 kB = 1000 B, as bandwidth is billed), one fraction digit from kB
 * up. Non-finite or negative input is treated as 0.
 */
export function formatBytes(bytes: number, locale: string): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  // 999.95 kB would print as "1,000.0 kB"; carry it into the next unit instead.
  if (unit > 0 && unit < BYTE_UNITS.length - 1 && Math.round(value * 10) / 10 >= 1000) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
    minimumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** The host part the member fills in: where their relay is reachable over HTTPS. */
export const RELAY_HOST_PLACEHOLDER = "https://<your-host>";

/**
 * The shell command that starts a relay with `token` against this instance
 * (docs/testing/e3-selectors.md `relay-run-command`). `publicUrl` is the instance's PUBLIC_URL.
 */
export function relayRunCommand(publicUrl: string, token: string): string {
  const api = publicUrl.replace(/\/+$/, "");
  return `commonair-relay --api ${api} --token ${token} --public-url ${RELAY_HOST_PLACEHOLDER}`;
}

/**
 * The relay README in the source repository this instance runs. `sourceUrl` is `instance.info`'s
 * link: the repository, or `<repo>/tree/<commit>` for the exact commit.
 */
export function relayReadmeUrl(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  const base = sourceUrl.replace(/\/+$/, "");
  const pinned = /^(.*)\/tree\/([^/]+)$/.exec(base);
  if (pinned?.[1] && pinned[2]) return `${pinned[1]}/blob/${pinned[2]}/relay/README.md`;
  return `${base}/blob/HEAD/relay/README.md`;
}

/** A relay name as submitted: trimmed, 1–50 characters; null when it does not fit. */
export function relayName(raw: string): string | null {
  const name = raw.trim();
  return name.length >= 1 && name.length <= RELAY_NAME_MAX ? name : null;
}
