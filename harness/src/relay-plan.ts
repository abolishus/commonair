// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `e2e-relay` knobs (`--set key=value`) → the plan the scenario runs. Pure, so tests check it. */

export const RELAY_VIA = ["web", "api"] as const;
export type RelayVia = (typeof RELAY_VIA)[number];

export const RELAY_STEPS = {
  setup: "setup",
  viewers: "viewers on the relay",
  bots: "viewbot swarm",
  verify: "verification",
  liar: "over-reporting relay",
  drain: "drain",
} as const;
export type RelayStep = (typeof RELAY_STEPS)[keyof typeof RELAY_STEPS];

export interface RelayPlan {
  via: RelayVia;
  /** Overrides the detected LAN IPv4 for the relays' public URLs. */
  relayHost: string | undefined;
  /** Go relay port (default: a free one). */
  relayPort: number | undefined;
  /** Honest HTTP viewers opened first. */
  httpViewers: number;
  /** Honest Chromium players (half signed in, half anonymous); always 0 with via=api. */
  browserViewers: number;
  bots: number;
  liar: boolean;
  drain: boolean;
  /** Relay-assigned honest sessions step 2 needs. */
  minRelayAssigned: number;
  /** Honest sessions the harness may open in total while looking for relay assignments. */
  maxSessions: number;
  /** Sessions that must land on the liar before it starts lying. */
  liarViewers: number;
  /** Times each Chromium player may reload (a new session) to land on the relay. */
  browserRelayAttempts: number;
  /** Bytes multiplier the liar claims. */
  liarFactor: number;
  steps: RelayStep[];
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export function parseBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new PlanError(`--set ${name}=${value}: expected true or false`);
}

function parseInt0(name: string, value: string | undefined, fallback: number, min = 0, max = 10_000): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new PlanError(`--set ${name}=${value}: expected a whole number`);
  const n = Number(value.trim());
  if (n < min || n > max) throw new PlanError(`--set ${name}=${value}: expected ${min}–${max}`);
  return n;
}

export function buildRelayPlan(params: Readonly<Record<string, string>>): RelayPlan {
  const viaRaw = params.via ?? "web";
  if (!(RELAY_VIA as readonly string[]).includes(viaRaw))
    throw new PlanError(`--set via=${viaRaw}: expected one of ${RELAY_VIA.join(", ")}`);
  const via = viaRaw as RelayVia;
  const browserDefault = via === "api" ? 0 : 2;
  const browserViewers = parseInt0("browserViewers", params.browserViewers, browserDefault, 0, 20);
  if (via === "api" && browserViewers > 0)
    throw new PlanError("--set via=api drives the backend only: HTTP viewers, no browsers (drop browserViewers)");
  const httpViewers = parseInt0("httpViewers", params.httpViewers, 4, 0, 500);
  if (httpViewers + browserViewers === 0)
    throw new PlanError("need at least one honest viewer (httpViewers or browserViewers)");
  const minRelayAssigned = 2;
  const maxSessions = parseInt0("maxSessions", params.maxSessions, 30, 1, 1_000);
  if (maxSessions < Math.max(minRelayAssigned, httpViewers + browserViewers))
    throw new PlanError(
      `--set maxSessions=${maxSessions}: must cover the initial viewers and ${minRelayAssigned} relay-assigned sessions`,
    );
  const relayHost = params.relayHost?.trim() || undefined;
  if (relayHost && /[\s/]/.test(relayHost)) throw new PlanError(`--set relayHost=${relayHost}: expected an address`);
  const relayPort = params.relayPort ? parseInt0("relayPort", params.relayPort, 0, 1, 65_535) : undefined;
  const liar = parseBool("liar", params.liar, true);
  const drain = parseBool("drain", params.drain, true);
  const liarFactor = Number(params.liarFactor ?? 5);
  if (!Number.isFinite(liarFactor) || liarFactor <= 1.5)
    throw new PlanError(
      `--set liarFactor=${params.liarFactor}: expected a number above 1.5 (the liar must over-report)`,
    );
  const steps: RelayStep[] = [RELAY_STEPS.setup, RELAY_STEPS.viewers, RELAY_STEPS.bots, RELAY_STEPS.verify];
  if (liar) steps.push(RELAY_STEPS.liar);
  if (drain) steps.push(RELAY_STEPS.drain);
  return {
    via,
    relayHost,
    relayPort,
    httpViewers,
    browserViewers,
    bots: parseInt0("bots", params.bots, 12, 0, 500),
    liar,
    drain,
    minRelayAssigned,
    maxSessions,
    liarViewers: parseInt0("liarViewers", params.liarViewers, 2, 1, 50),
    browserRelayAttempts: parseInt0("browserRelayAttempts", params.browserRelayAttempts, 3, 0, 20),
    liarFactor,
    steps,
  };
}

/** Step 4's count rule: before the liar, exactly the honest count; after, sessions the liar held may stay pending. */
export function verifiedCountOk(verified: number, honest: number, liarAssigned = 0): boolean {
  return verified <= honest && verified >= honest - liarAssigned;
}
