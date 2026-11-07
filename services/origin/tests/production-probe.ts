// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One attempt at a minute with both live relay sessions and recorded production, for the
 * issuance tests that run against a live MediaMTX.
 *
 * The minute is chosen before the sessions' heartbeat is stamped, so the heartbeat can only
 * fall in it or after it: issuance counts a session for minute B when lastHeartbeatAt ≥ B.
 * Stamping first and reading the clock after the pull let a minute boundary fall between
 * the two (origin.int, CI run 41834516797): the heartbeat landed at the end of one minute,
 * the pull's production and the chosen minute in the next, and the issuance came out empty.
 */
import { minuteOf } from "../src/accounting.ts";

export interface ProbeSteps {
  now: () => number;
  /** Mark the relay's sessions alive at `at`. */
  stamp: (at: Date) => Promise<void>;
  /** Pull media as a relay would, so the origin records production. */
  pull: () => Promise<void>;
  /** Whether `minute` has production to issue against. */
  produced: (minute: number) => Promise<boolean>;
}

/** The chosen minute, or undefined when it has no production yet (try again). */
export async function probeProductionMinute(steps: ProbeSteps): Promise<number | undefined> {
  const minute = minuteOf(steps.now());
  await steps.stamp(new Date(steps.now()));
  await steps.pull();
  return (await steps.produced(minute)) ? minute : undefined;
}
