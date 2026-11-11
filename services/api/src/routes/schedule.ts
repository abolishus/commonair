// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channels.schedule.*` (overhaul wave 5): `get` is public (the channel's About tab, the studio
 * editor); `set` is the owner's and replaces the whole schedule. The calendar feed is a raw route
 * (`schedule/feed.ts`).
 */
import { channelBySlug } from "../lib/dto.ts";
import { notFound } from "../lib/errors.ts";
import { os, requireChannel } from "../lib/orpc.ts";
import {
  loadSchedule,
  replaceSchedule,
  toScheduleDto,
  upcomingOf,
  validateScheduleInput,
} from "../schedule/service.ts";

export const channelSchedule = {
  schedule: {
    get: os.channels.schedule.get.handler(async ({ context: { deps }, input }) => {
      const c = await channelBySlug(deps, input.channel);
      if (!c) throw notFound("Channel not found");
      const now = deps.now();
      const loaded = await loadSchedule(deps.db, c.id, now);
      return toScheduleDto(c.slug, loaded, upcomingOf(loaded, now, c.suspendedAt !== null));
    }),
    set: os.channels.schedule.set.handler(async ({ context, input }) => {
      const { deps } = context;
      const c = requireChannel(context);
      const schedule = { timezone: input.timezone, slots: input.slots, oneOffs: input.oneOffs };
      await validateScheduleInput(deps.db, schedule);
      const now = deps.now();
      await replaceSchedule(deps.db, c.id, schedule, now);
      const loaded = await loadSchedule(deps.db, c.id, now);
      return toScheduleDto(c.slug, loaded, upcomingOf(loaded, now, c.suspendedAt !== null));
    }),
  },
};
