// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadUserPublic, userByUsername } from "../lib/dto.ts";
import { notFound } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const users = {
  get: os.users.get.handler(async ({ context: { deps }, input }) => {
    const u = await userByUsername(deps, input.username);
    const pub = u ? await loadUserPublic(deps, u.id) : null;
    if (!pub) throw notFound("User not found");
    return pub;
  }),
};
