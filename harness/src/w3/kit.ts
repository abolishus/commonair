// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The contexts the six extended scenarios hand their batch 7 extension steps (`src/w3/steps.ts`).
 * `interact` hands the E8 run (`src/e8/kit.ts`), `integrity-basic` and `trust-safety` the W2
 * shapes (`src/w2/kit.ts`), `rehearsal` its run (`src/w2/rehearsal/index.ts`); `e5-coop` and
 * `e2e-relay` hand the shapes below. Owned by the orchestrator: units send a contract request
 * instead of editing it.
 */
import type { CoopHooks } from "../coop-io.ts";
import type { HttpViewer } from "../http-viewer.ts";
import type { Via } from "../money.ts";
import type { Platform } from "../platform.ts";
import type { GoRelay } from "../relay.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";

export type { E8Run as InteractW3Extension } from "../e8/kit.ts";
export type {
  IntegrityW2Extension as IntegrityW3Extension,
  SafetyW2Extension as SafetyW3Extension,
} from "../w2/kit.ts";
export type { RehearsalRun as RehearsalW3Extension } from "../w2/rehearsal/index.ts";

/** The `e5-coop` accounts (`V`, `S1`, `S2`, `W`, the treasurers `T1`/`T2` and the admin). */
export type CoopPerson = "v" | "s1" | "s2" | "w" | "t1" | "t2" | "admin";

/**
 * What `e5-coop` hands `jury`, after its last step (step 9 has every member exit, so the jury
 * step enrols the members it opts in). Governance runs on the database clock through `hooks`.
 */
export interface CoopW3Extension {
  ctx: ScenarioContext;
  via: Via;
  people: Readonly<Record<CoopPerson, SignedInUser>>;
  /** The co-op test hook (`POST /internal/coop/tick`; COOP_TEST_HOOKS). */
  hooks: CoopHooks;
  /** Owner connection string, for the role CLI and row checks. */
  databaseUrl: string;
  /** The app's non-owner role, for direct-insert refusals. */
  appRole: string;
  currency: string;
  /** A soft check: the scenario screenshots its sessions when one fails. */
  check: ScenarioContext["check"];
}

/**
 * What `e2e-relay` hands `dvr-relay`, `dvr-purge` and `relay-vtt`: the channel is live, the Go
 * relay active, honest viewers verified on it and the viewbots excluded. They run before the liar
 * relay and the drain, so the relay must be left serving.
 */
export interface RelayW3Extension {
  ctx: ScenarioContext;
  platform: Platform;
  check: ScenarioContext["check"];
  channel: string;
  streamer: SignedInUser;
  /** The member who registered the relay. */
  member: SignedInUser;
  /** The running Go relay (its logs, `health()`, `url`). */
  relay: GoRelay;
  relayId: string;
  /** Open another HTTP viewer on the channel (stopped when the scenario ends). */
  openHttpViewer(id: string): Promise<HttpViewer>;
  /** Whether a viewer's current assignment is this relay. */
  onRelay(viewer: HttpViewer): boolean;
}
