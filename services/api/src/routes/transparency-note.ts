// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `transparency.setNote` (overhaul wave 4, D6.1). Contract step stub: d6-transparency implements it. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = (): never => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const transparencyNote = { setNote: os.transparency.setNote.handler(notYet) };
