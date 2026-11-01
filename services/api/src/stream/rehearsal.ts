// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rehearsal mode (W2-rehearsal, batch 6 decisions (f), (g)): arm and disarm
 * (`KEYS.rehearsalArmed`), invitees (`rehearsal_invitees`, at most five followers), the report
 * (`KEYS.rehearsalReport`) and the invitee-gated watch token. The media gate that turns an armed
 * publish into a `kind = 'rehearsal'` broadcast is `../media/hooks.ts` (contract step, read-only
 * for the unit). Contract-step stubs (HTTP 501) until W2-rehearsal implements them.
 */
import type { RehearsalReport, RehearsalStatus, RehearsalWatch } from "@commonair/contracts/dto";
import type { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { notImplemented } from "../lib/errors.ts";

/** An owner procedure's caller: the channel the owner middleware resolved and the owner's id. */
export interface RehearsalActor {
  deps: Deps;
  channel: typeof schema.channels.$inferSelect;
  userId: string;
}

export async function armRehearsal(_a: RehearsalActor): Promise<RehearsalStatus> {
  notImplemented();
}

export async function disarmRehearsal(_a: RehearsalActor): Promise<RehearsalStatus> {
  notImplemented();
}

export async function rehearsalStatus(_a: RehearsalActor): Promise<RehearsalStatus> {
  notImplemented();
}

export async function inviteToRehearsal(
  _a: RehearsalActor,
  _input: { username: string; remove: boolean },
): Promise<RehearsalStatus> {
  notImplemented();
}

export async function rehearsalReport(_a: RehearsalActor, _broadcastId: string | undefined): Promise<RehearsalReport> {
  notImplemented();
}

/** `user` access (the owner or an invitee), so the channel arrives as its slug. */
export async function watchRehearsal(
  _deps: Deps,
  _userId: string,
  _input: { channel: string; deviceId: string },
): Promise<RehearsalWatch> {
  notImplemented();
}
