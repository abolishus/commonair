// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The full router. `base.router` type-checks that every contract procedure is implemented. */
import { base } from "./lib/orpc.ts";
import { admin } from "./routes/admin.ts";
import { appeals } from "./routes/appeals.ts";
import { bot } from "./routes/bot.ts";
import { channelsRoutes } from "./routes/channels.ts";
import { chat } from "./routes/chat.ts";
import { clips } from "./routes/clips.ts";
import { coop } from "./routes/coop.ts";
import { developer } from "./routes/developer/index.ts";
import { categoriesRoutes, directory } from "./routes/directory.ts";
import { instance } from "./routes/instance.ts";
import { integrity } from "./routes/integrity.ts";
import { interact } from "./routes/interact.ts";
import { legal } from "./routes/legal.ts";
import { me } from "./routes/me.ts";
import { moderation } from "./routes/moderation.ts";
import { money } from "./routes/money.ts";
import { ncii } from "./routes/ncii.ts";
import { notifications } from "./routes/notifications.ts";
import { p2p } from "./routes/p2p.ts";
import { playback } from "./routes/playback.ts";
import { relays } from "./routes/relays.ts";
import { safety } from "./routes/safety.ts";
import { stream } from "./routes/stream.ts";
import { users } from "./routes/users.ts";
import { vods } from "./routes/vods.ts";

export const router = base.router({
  instance,
  me,
  users,
  categories: categoriesRoutes,
  directory,
  channels: channelsRoutes,
  stream,
  playback,
  p2p,
  vods,
  clips,
  chat,
  money,
  developer,
  bot,
  interact,
  coop,
  integrity,
  appeals,
  safety,
  legal,
  relays,
  admin,
  moderation,
  ncii,
  notifications,
});

export type Router = typeof router;
