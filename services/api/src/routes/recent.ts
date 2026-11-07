// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Cross-channel shelves (overhaul wave 2, D3.1): `vods.listRecent` and `clips.listRecent`. Contract step stubs: d3-home implements them. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const vodsRecent = { listRecent: os.vods.listRecent.handler(notYet) };
export const clipsRecent = { listRecent: os.clips.listRecent.handler(notYet) };
