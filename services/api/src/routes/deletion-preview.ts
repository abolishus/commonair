// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `me.deletion.preview` (overhaul wave 4, D7.4). Contract step stub: d7-settings implements it. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = (): never => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const meDeletionPreview = { preview: os.me.deletion.preview.handler(notYet) };
