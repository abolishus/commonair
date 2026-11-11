// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `vods.recordView` and `clips.recordView` (overhaul wave 3, D5.5). Contract step stub: d5-content implements them. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = (): never => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const vodViews = { recordView: os.vods.recordView.handler(notYet) };
export const clipViews = { recordView: os.clips.recordView.handler(notYet) };
