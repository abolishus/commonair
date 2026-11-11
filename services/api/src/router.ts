// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The full router. `base.router` type-checks that every contract procedure is implemented. */
import { base } from "./lib/orpc.ts";
import { admin } from "./routes/admin.ts";
import { analytics } from "./routes/analytics.ts";
import { appeals } from "./routes/appeals.ts";
import { bot } from "./routes/bot.ts";
import { channelsRoutes } from "./routes/channels.ts";
import { chat } from "./routes/chat.ts";
import { clips } from "./routes/clips.ts";
import { coop } from "./routes/coop.ts";
import { developer } from "./routes/developer/index.ts";
import { categoriesRoutes, directory } from "./routes/directory.ts";
import { federation } from "./routes/federation.ts";
import { instance } from "./routes/instance.ts";
import { integrity } from "./routes/integrity.ts";
import { interact } from "./routes/interact.ts";
import { jury } from "./routes/jury.ts";
import { legal } from "./routes/legal.ts";
import { me } from "./routes/me.ts";
import { moderation } from "./routes/moderation.ts";
import { money } from "./routes/money.ts";
import { ncii } from "./routes/ncii.ts";
import { notifications } from "./routes/notifications.ts";
import { p2p } from "./routes/p2p.ts";
import { playback } from "./routes/playback.ts";
import { portability } from "./routes/portability.ts";
import { relays } from "./routes/relays.ts";
import { safety } from "./routes/safety.ts";
import { stream } from "./routes/stream.ts";
import { transparency } from "./routes/transparency.ts";
import { twitchImport } from "./routes/twitch-import.ts";
import { users } from "./routes/users.ts";
import { vods } from "./routes/vods.ts";
import { watchRooms } from "./routes/watch-rooms.ts";
import { adminGrowth, metrics, transparencyNumbers } from "./routes/growth.ts";
import { clipsRecent, vodsRecent } from "./routes/recent.ts";
import { usernameRoutes } from "./routes/username.ts";
import { meModerates } from "./routes/moderates.ts";
import { streamSetup } from "./routes/setup.ts";
import { clipViews, vodViews } from "./routes/views.ts";
import { meDeletionPreview } from "./routes/deletion-preview.ts";
import { chatBansBulk } from "./routes/chat-bulk.ts";
import { transparencyNote } from "./routes/transparency-note.ts";
import { adminConsole, caseAssign } from "./routes/admin-console.ts";
import { channelSchedule } from "./routes/schedule.ts";
import { streamLastBroadcast } from "./routes/last-broadcast.ts";
import { shareRefundDetails } from "./routes/share-refund-details.ts";

export const router = base.router({
  instance,
  me: { ...me, ...meModerates, deletion: { ...me.deletion, ...meDeletionPreview } },
  users: { ...users, ...usernameRoutes },
  categories: categoriesRoutes,
  directory,
  channels: { ...channelsRoutes, ...channelSchedule },
  stream: { ...stream, ...streamSetup, ...streamLastBroadcast },
  playback,
  p2p,
  vods: { ...vods, ...vodsRecent, ...vodViews },
  clips: { ...clips, ...clipsRecent, ...clipViews },
  chat: { ...chat, bans: { ...chat.bans, ...chatBansBulk } },
  money,
  developer,
  bot,
  interact,
  coop: { ...coop, shares: { ...coop.shares, ...shareRefundDetails } },
  integrity,
  analytics,
  transparency: { ...transparency, ...transparencyNumbers, ...transparencyNote },
  appeals,
  safety,
  legal,
  relays,
  admin: { ...admin, ...adminGrowth, ...adminConsole },
  metrics,
  moderation: { ...moderation, ...caseAssign },
  ncii,
  notifications,
  // Batch 7 (W3, N3, N4): 501 stubs until each unit fills its own route file.
  watchRooms,
  portability,
  jury,
  twitchImport,
  federation,
});

export type Router = typeof router;
