// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `transparency.setNote` (overhaul wave 4, D6.1): the treasurer's public note on a month. The
 * contract's `treasurer` access refuses everyone else; the month format and the 2000-character cap
 * are validated by the contract (and the table's checks).
 */
import { os, requireCaller } from "../lib/orpc.ts";
import { setTransparencyNote } from "../transparency/notes.ts";

export const transparencyNote = {
  setNote: os.transparency.setNote.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    await setTransparencyNote(context.deps, caller.user.id, input);
    return { ok: true as const };
  }),
};
