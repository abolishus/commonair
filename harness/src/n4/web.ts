// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `federation` scenario's web steps (docs/testing/b7-selectors.md: the `federation-*` test
 * ids), which `src/n4/index.ts` uses when `via=web`: turn federation on in the studio, read the
 * handle, see a follower appear, remove a follower, add an admin domain block. Each signs in its
 * own browser session as `as`. Stub: N4-web fills it.
 */
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";

const notMerged = (): never => {
  throw new Error("N4-web not merged");
};

/** The streamer turns federation on in the studio stream settings (`federation-enabled`). */
export async function enableFederationViaWeb(_ctx: ScenarioContext, _as: SignedInUser): Promise<void> {
  notMerged();
}

/** The `@slug@domain` handle the studio shows (`federation-handle`). */
export async function readHandleViaWeb(_ctx: ScenarioContext, _as: SignedInUser): Promise<string> {
  return notMerged();
}

/** Wait until `actorId` is listed among the followers (`federation-followers`). */
export async function waitForFollowerViaWeb(_ctx: ScenarioContext, _as: SignedInUser, _actorId: string): Promise<void> {
  notMerged();
}

/** Remove the follower `actorId` through its confirm (`federation-follower-remove`). */
export async function removeFollowerViaWeb(_ctx: ScenarioContext, _as: SignedInUser, _actorId: string): Promise<void> {
  notMerged();
}

/** An admin blocks `domain` on `/admin/federation` (`federation-block-add`, `federation-blocks`). */
export async function addDomainBlockViaWeb(_ctx: ScenarioContext, _as: SignedInUser, _domain: string): Promise<void> {
  notMerged();
}
