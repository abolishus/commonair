// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The contexts the extended scenarios hand their batch 8 extension steps (`src/b8/steps.ts`). Each
 * is the shape the scenario already hands its earlier extensions or its own steps:
 *
 * - `e4b-money`: the W1 `MoneyExtension` (`src/w1/kit.ts`), after the W2 extensions;
 * - `e5-coop`: the `CoopW3Extension` (`src/w3/kit.ts`), after the W3 `jury`;
 * - `interact`: the E8 run (`src/e8/kit.ts`), after the W3 extensions;
 * - `watch-room`, `twitch-import`, `federation`, `portability`: the scenario's own run, after its
 *   steps;
 * - `data-export`: the E6 kit (`src/e6/kit.ts`), after the scenario's last step;
 * - `trust-safety`: a `before`/`after` pair around the steps, as W2's `enforcement`;
 * - `relay-dvr` (B8-harness, wave 2): the `RelayW3Extension` shape until the orchestrator wires the
 *   scenario at B8-harness's merge.
 *
 * Owned by the orchestrator: units send a contract request instead of editing it.
 */
export type { MoneyExtension as MoneyB8Extension } from "../w1/kit.ts";
export type { CoopW3Extension as CoopB8Extension, RelayW3Extension as RelayDvrB8Extension } from "../w3/kit.ts";
export type { E8Run as InteractB8Extension } from "../e8/kit.ts";
export type { WatchRoomRun as WatchRoomB8Extension } from "../w3/watch-rooms/index.ts";
export type { TwitchImportRun as TwitchImportB8Extension } from "../n3/index.ts";
export type { FederationRun as FederationB8Extension } from "../n4/index.ts";
export type { PortabilityRun as PortabilityB8Extension } from "../w3/portability/index.ts";
export type { Kit as DataExportB8Extension } from "../e6/kit.ts";
export type { SafetyW2Extension as SafetyB8Extension } from "../w2/kit.ts";
