// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The contexts the four extended scenarios hand their W2 extension steps (`src/w2/steps.ts`).
 * `e4b-money` hands the W1 `MoneyExtension` and `timeline-sync` the W1 `W1Run` (`src/w1/kit.ts`);
 * `integrity-basic` and `trust-safety` hand the shapes below. Owned by the orchestrator: units
 * send a contract request instead of editing it.
 */
import type { Platform } from "../platform.ts";
import type { Run } from "../safety-run.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";

export type { MoneyExtension, W1Run } from "../w1/kit.ts";

/**
 * What `integrity-basic` hands its W2 extensions (`group`, `signed`, `tamper`, `group-appeal`).
 * They run after the scenario's viewers stopped; the broadcast is still live until one of them
 * calls `endBroadcast` (the rollup runs on `stream.offline`).
 */
export interface IntegrityW2Extension {
  ctx: ScenarioContext;
  channel: string;
  channelId: string;
  streamer: SignedInUser;
  /** The browser launcher and viewer helpers (`openViewers`, `fleet`, `api`, `residential`). */
  platform: Platform;
  /** For session verdicts, rollup and attestation rows; undefined when the harness cannot reach the database. */
  databaseUrl: string | undefined;
  /** The broadcast the scenario watched (null if it could not be read). */
  broadcastId: string | null;
  /** How many honest viewers watched (the scenario's expected audience). */
  honestCount: number;
  /** The datacenter viewbots' playback sessions: the one `datacenter` exclusion group. */
  swarmSessionIds: readonly string[];
  /** Stop the encoder and wait until the channel is offline. Idempotent. */
  endBroadcast(): Promise<void>;
}

/**
 * A `trust-safety` W2 extension (`enforcement`): `before` runs ahead of the scenario's first step
 * (read the report, top up a cell), `after` once every step has run, with what `before` returned.
 */
export interface SafetyW2Extension<T = unknown> {
  before(run: Run): Promise<T>;
  after(run: Run, before: T): Promise<void>;
}
