// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-server's extensions (docs/testing/b8-selectors.md, "Scenarios"):
 *
 * - `interact` `raid-restart-keeps-raid`: a raid surge restarted inside its window keeps `raid`;
 * - `twitch-import` `field-choices` (only the chosen fields apply) and `import-expiry` (a test
 *   hook ages `finished_at` past 30 days; the Twitch data is cleared, the status and audit row
 *   kept);
 * - `federation` `actor-disabled-event`: the peer receives the actor `Delete` after a suspension,
 *   and the API queued no deliver job;
 * - `portability` `incoming-cleanup`: a test hook ages an abandoned import, and its archive goes;
 * - `data-export` `giveaway-section`: `interact-giveaways.json` holds the caller's own rows only;
 * - `trust-safety` `sor-staff-action` (a staff action with no case has a `staff_action`
 *   statement) and `lapsed-ban-signin` (a lapsed ban cleared at sign-in writes one
 *   `channel.suspension {suspended:false}`), around the steps.
 *
 * Stub entry points from the batch 8 contract step: B8-server fills them.
 */
import type { Run } from "../safety-run.ts";
import type {
  DataExportB8Extension,
  FederationB8Extension,
  InteractB8Extension,
  PortabilityB8Extension,
  SafetyB8Extension,
  TwitchImportB8Extension,
} from "./kit.ts";

const notMerged = (): never => {
  throw new Error("B8-server not merged");
};

export async function stepRaidRestartKeepsRaid(_run: InteractB8Extension): Promise<void> {
  notMerged();
}

export async function stepFieldChoices(_run: TwitchImportB8Extension): Promise<void> {
  notMerged();
}

export async function stepImportExpiry(_run: TwitchImportB8Extension): Promise<void> {
  notMerged();
}

export async function stepActorDisabledEvent(_run: FederationB8Extension): Promise<void> {
  notMerged();
}

export async function stepIncomingCleanup(_run: PortabilityB8Extension): Promise<void> {
  notMerged();
}

export async function stepGiveawaySection(_kit: DataExportB8Extension): Promise<void> {
  notMerged();
}

export const sorStaffActionExtension: SafetyB8Extension = {
  async before(_run: Run): Promise<unknown> {
    return undefined;
  },
  async after(_run: Run, _before: unknown): Promise<void> {
    notMerged();
  },
};

export const lapsedBanSigninExtension: SafetyB8Extension = {
  async before(_run: Run): Promise<unknown> {
    return undefined;
  },
  async after(_run: Run, _before: unknown): Promise<void> {
    notMerged();
  },
};
