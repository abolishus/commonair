// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the demo seed creates (pure data, unit-tested). Handles become `demo_<handle>` with an
 * `@demo-seed.invalid` email (see anchors.ts). Content is fixed so screenshots and walkthroughs
 * look the same on every instance; ids and timestamps are minted at seed time.
 */

export interface DemoCategory {
  slug: string;
  name: string;
}

/** Shared reference data: upserted by slug, never deleted by `demo:clear` (real channels may use them). */
export const DEMO_CATEGORIES: readonly DemoCategory[] = [
  { slug: "just-chatting", name: "Just Chatting" },
  { slug: "music", name: "Music" },
  { slug: "software-development", name: "Software & Game Development" },
];

export interface DemoStreamer {
  handle: string;
  displayName: string;
  birthDate: string;
  channel: {
    title: string;
    description: string;
    category: string;
    tags: string[];
    language: string;
  };
  /** Past broadcasts: hours ago it started, and how long it ran. */
  history: { startedHoursAgo: number; durationMinutes: number; title: string; peakViewers: number }[];
}

export interface DemoViewer {
  handle: string;
  displayName: string;
  birthDate: string;
}

export const DEMO_STREAMERS: readonly DemoStreamer[] = [
  {
    handle: "streamer1",
    displayName: "Aurora Pixel",
    birthDate: "1993-04-12",
    channel: {
      title: "Cozy pixel art and chill chat",
      description: "Drawing tiny worlds one pixel at a time. Requests welcome!",
      category: "just-chatting",
      tags: ["pixelart", "cozy", "art"],
      language: "en",
    },
    history: [
      { startedHoursAgo: 26, durationMinutes: 140, title: "Pixel art: a lighthouse at dusk", peakViewers: 18 },
      { startedHoursAgo: 74, durationMinutes: 95, title: "Palette practice and Q&A", peakViewers: 11 },
    ],
  },
  {
    handle: "streamer2",
    displayName: "Lumen Beats",
    birthDate: "1990-09-30",
    channel: {
      title: "Live lo-fi production from scratch",
      description: "Making beats live with open-source tools. Ask about the synth chain.",
      category: "music",
      tags: ["lofi", "production", "synth"],
      language: "es",
    },
    history: [
      { startedHoursAgo: 30, durationMinutes: 120, title: "Lo-fi from scratch, episode 12", peakViewers: 24 },
      { startedHoursAgo: 98, durationMinutes: 80, title: "Sampling field recordings", peakViewers: 9 },
    ],
  },
  {
    handle: "streamer3",
    displayName: "Cedar Codes",
    birthDate: "1996-01-21",
    channel: {
      title: "Building a tiny roguelike in Rust",
      description: "Game dev in the open: procedural dungeons, ECS and too much coffee.",
      category: "software-development",
      tags: ["rust", "gamedev", "opensource"],
      language: "de",
    },
    history: [
      { startedHoursAgo: 20, durationMinutes: 180, title: "Roguelike: field of view and lighting", peakViewers: 31 },
      { startedHoursAgo: 120, durationMinutes: 150, title: "Roguelike: dungeon generation", peakViewers: 22 },
    ],
  },
];

export const DEMO_VIEWERS: readonly DemoViewer[] = [
  { handle: "viewer1", displayName: "Moss Lantern", birthDate: "1988-07-04" },
  { handle: "viewer2", displayName: "Quill & Ink", birthDate: "1999-11-15" },
  { handle: "viewer3", displayName: "Nova Tide", birthDate: "2001-02-08" },
  { handle: "viewer4", displayName: "Bramble Fox", birthDate: "1985-05-27" },
  { handle: "viewer5", displayName: "Sly Kettle", birthDate: "1997-08-19" },
  { handle: "viewer6", displayName: "Rogue Pebble", birthDate: "2000-12-01" },
];

/** A chat bot owned by the first streamer (as `me.bots.create` would make it). */
export const DEMO_BOT = { handle: "bot1", displayName: "Pixel Helper", owner: "streamer1" } as const;

/** Who follows whom (follower handle → streamer handles). */
export const DEMO_FOLLOWS: Readonly<Record<string, readonly string[]>> = {
  viewer1: ["streamer1", "streamer2", "streamer3"],
  viewer2: ["streamer1", "streamer3"],
  viewer3: ["streamer2", "streamer3"],
  viewer4: ["streamer1"],
  viewer5: ["streamer1", "streamer2"],
  viewer6: ["streamer2"],
  streamer1: ["streamer3"],
  streamer2: ["streamer1"],
  streamer3: ["streamer1", "streamer2"],
};

/** Channel moderators (channel → user), granted by the channel owner. */
export const DEMO_MODERATORS: readonly { channel: string; user: string }[] = [
  { channel: "streamer1", user: "viewer1" },
  { channel: "streamer3", user: "viewer2" },
];

/**
 * The moderation example: an active timeout by a channel moderator and a permanent ban by the
 * owner. The banned viewer's chat history stays visible to moderators.
 */
export const DEMO_MODERATION = {
  timeout: { channel: "streamer1", moderator: "viewer1", target: "viewer5", durationSeconds: 3_600 },
  ban: { channel: "streamer2", moderator: "streamer2", target: "viewer6" },
} as const;

export interface DemoChatLine {
  channel: string;
  author: string;
  body: string;
  isAction?: boolean;
}

const CHAT: Readonly<Record<string, readonly [author: string, body: string][]>> = {
  streamer1: [
    ["streamer1", "Hey everyone, welcome in! Tonight: a lighthouse at dusk."],
    ["viewer1", "evening! the palette from last time was gorgeous"],
    ["viewer2", "first time here, this is so relaxing"],
    ["bot1", "Welcome! Type !palette to see tonight's colors."],
    ["viewer4", "!palette"],
    ["bot1", "Tonight's palette: 16 colors, inspired by a Baltic sunset."],
    ["viewer5", "can you draw a cat on the rocks?"],
    ["streamer1", "a cat on the rocks is happening, give me ten minutes"],
    ["viewer5", "CAT CAT CAT CAT CAT CAT"],
    ["viewer5", "CAT CAT CAT CAT CAT CAT CAT CAT"],
    ["viewer1", "let's keep caps down please"],
    ["viewer2", "the dithering on the water is so good"],
    ["viewer4", "how long have you been doing pixel art?"],
    ["streamer1", "about six years now, started with tiny 16x16 icons"],
    ["viewer2", "the lighthouse beam animation 😍"],
    ["viewer1", "clip that!"],
    ["streamer1", "thanks for hanging out, see you Thursday!"],
  ],
  streamer2: [
    ["streamer2", "¡Hola! Hoy hacemos un beat lo-fi desde cero."],
    ["viewer3", "hola! what synth is that?"],
    ["streamer2", "Surge XT, all open source. The drums are a sampler track."],
    ["viewer1", "that vinyl crackle is perfect"],
    ["viewer6", "this is boring, go check out my channel instead"],
    ["viewer6", "free followers at my link"],
    ["viewer5", "the chord progression reminds me of rainy mornings"],
    ["viewer3", "can you slow it down to 70 bpm?"],
    ["streamer2", "Vamos a 72, un poco más de swing."],
    ["viewer1", "oh that swing is nice"],
    ["viewer3", "saving this for my study playlist"],
    ["viewer5", "what reverb is on the keys?"],
    ["streamer2", "Dragonfly Plate, with a short pre-delay."],
    ["viewer1", "🎧🎧🎧"],
    ["viewer3", "gracias por el stream!"],
    ["streamer2", "¡Gracias a todos! Hasta el sábado."],
  ],
  streamer3: [
    ["streamer3", "Hallo zusammen! Today: field of view for the roguelike."],
    ["viewer2", "symmetric shadowcasting?"],
    ["streamer3", "yes, symmetric shadowcasting, it handles pillars nicely"],
    ["viewer3", "is this using bevy or your own ECS?"],
    ["streamer3", "own tiny ECS for now, bevy later maybe"],
    ["viewer1", "the borrow checker is winning today"],
    ["streamer3", "it always wins in the end 😅"],
    ["viewer4", "what font is your editor using?"],
    ["streamer3", "Iosevka, with ligatures off"],
    ["viewer2", "FOV looks correct around pillars now"],
    ["viewer3", "nice, the walls light up properly"],
    ["viewer1", "can we see the dungeon seed system next time?"],
    ["streamer3", "noted for next stream"],
    ["viewer4", "learned a ton, thanks"],
    ["viewer2", "!roadmap"],
    ["streamer3", "roadmap is in the panels below, PRs welcome"],
    ["viewer3", "bis bald!"],
  ],
};

/** About fifty chat lines across the three channels, in send order per channel. */
export const DEMO_CHAT: readonly DemoChatLine[] = Object.entries(CHAT).flatMap(([channel, lines]) =>
  lines.map(([author, body]) => ({ channel, author, body })),
);

/** Every handle that gets an account, streamers first. */
export const DEMO_HANDLES: readonly string[] = [
  ...DEMO_STREAMERS.map((s) => s.handle),
  ...DEMO_VIEWERS.map((v) => v.handle),
  DEMO_BOT.handle,
];
