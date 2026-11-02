// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-social's fixed vocabulary: categories, display-name parts, channel titles, panels, emote
 * prefixes, word filters and chat templates. Pure data; the plan picks from it with the unit's
 * PRNG. No real names, brands, URLs or people: links point at `.invalid` hosts.
 */

/** The first `USED_CATEGORIES` get channels; the rest stay empty on purpose (empty directory states). */
export const CATEGORIES: readonly { slug: string; name: string; mature?: boolean }[] = [
  { slug: "just-chatting", name: "Just Chatting" },
  { slug: "music", name: "Music" },
  { slug: "art", name: "Art" },
  { slug: "software-development", name: "Software Development" },
  { slug: "retro-games", name: "Retro Games" },
  { slug: "strategy-games", name: "Strategy Games" },
  { slug: "cooking", name: "Cooking" },
  { slug: "science", name: "Science & Technology" },
  { slug: "speedruns", name: "Speedruns" },
  { slug: "tabletop", name: "Tabletop & Board Games" },
  { slug: "fitness", name: "Fitness & Health" },
  { slug: "travel", name: "Travel & Outdoors" },
  // Empty on purpose.
  { slug: "podcasts", name: "Podcasts" },
  { slug: "makers", name: "Makers & Crafting" },
  { slug: "language-exchange", name: "Language Exchange" },
  { slug: "late-night-talk", name: "Late Night Talk", mature: true },
];
export const USED_CATEGORIES = 12;

/** Category and language of each fixed streamer (the others pick by PRNG). */
export const FIXED_STREAMER_CHANNELS: Readonly<
  Record<string, { category: string; tags: string[]; title: string; description: string; emotePrefix: string }>
> = {
  streamer1: {
    category: "art",
    tags: ["pixelart", "chill", "cozy"],
    title: "Pixel art commissions and cozy chat",
    description: "Drawing tiny worlds one pixel at a time. Commissions open on Fridays.",
    emotePrefix: "aurora",
  },
  streamer2: {
    category: "music",
    tags: ["lofi", "beats", "production"],
    title: "Making beats live, requests welcome",
    description: "Lo-fi and synthwave production from scratch, every weeknight.",
    emotePrefix: "lumen",
  },
  streamer3: {
    category: "software-development",
    tags: ["typescript", "learning"],
    title: "First stream: building a tiny game engine",
    description: "Learning in public. Be kind, I am new at this.",
    emotePrefix: "cedar",
  },
  council1: {
    category: "strategy-games",
    tags: ["strategy", "coop"],
    title: "Grand strategy with the co-op crew",
    description: "Long campaigns, longer discussions.",
    emotePrefix: "sly",
  },
  council2: {
    category: "tabletop",
    tags: ["boardgames", "community"],
    title: "Board game night: viewers pick the game",
    description: "Tabletop sims and rule debates.",
    emotePrefix: "fern",
  },
};

export const TAGS = [
  "chill",
  "cozy",
  "competitive",
  "educational",
  "family-friendly",
  "lgbtq",
  "speedrun",
  "relaxing",
  "beginner",
  "community",
  "variety",
  "challenge",
] as const;

export const NAME_ADJECTIVES = [
  "Amber",
  "Brisk",
  "Cobalt",
  "Dusky",
  "Ember",
  "Frosty",
  "Gentle",
  "Hazel",
  "Indigo",
  "Jolly",
  "Kindly",
  "Lucky",
  "Misty",
  "Nimble",
  "Opal",
  "Plucky",
  "Quiet",
  "Rusty",
  "Sunny",
  "Tidal",
  "Umber",
  "Velvet",
  "Wild",
  "Zesty",
] as const;

export const NAME_NOUNS = [
  "Badger",
  "Comet",
  "Falcon",
  "Fern",
  "Gecko",
  "Harbor",
  "Kestrel",
  "Lantern",
  "Maple",
  "Meadow",
  "Otter",
  "Pebble",
  "Puffin",
  "Quokka",
  "Raven",
  "Sparrow",
  "Thistle",
  "Walrus",
  "Willow",
  "Yeti",
] as const;

export const TITLE_TEMPLATES = [
  "{cat} with friends, come hang out",
  "Chill {cat} session",
  "Day {n} of learning {cat}",
  "{cat}: viewer challenges tonight",
  "Late {cat} stream, low key",
  "{cat} marathon, all welcome",
] as const;

export const DESCRIPTIONS = [
  "Small channel, big heart. Say hi in chat.",
  "Streaming most evenings. Be excellent to each other.",
  "Here for the community. Follow to catch the next one.",
  "",
] as const;

export interface PanelText {
  title: string;
  body: string;
  link: boolean;
}

/** streamer1's panels (all of them); other channels take a prefix of the list. */
export const PANELS: readonly PanelText[] = [
  {
    title: "About me",
    body: "Pixel artist and **cozy** streamer. I draw tiny worlds and chat about craft.",
    link: false,
  },
  {
    title: "Schedule",
    body: "- Monday: sketches\n- Wednesday: commissions\n- Friday: community art night",
    link: false,
  },
  { title: "Chat rules", body: "1. Be kind.\n2. No spoilers.\n3. Moderators have the final word.", link: false },
  { title: "My setup", body: "Tablet, a very old laptop and a cat who walks across the keyboard.", link: false },
  { title: "Support the channel", body: "Subscriptions and tips keep the lights on. Thank you!", link: true },
  { title: "Community links", body: "Our art challenges and the monthly showcase.", link: true },
];

export const TIER_NAMES = ["Supporter", "Champion", "Legend"] as const;
/** At least `MONEY_LIMITS.tierMinCents`; seed-money subscribes at these. */
export const TIER_PRICES_CENTS = [500, 1000, 2500] as const;
export const TIER_BENEFITS = [
  "Tier 1 emotes and a badge",
  "Tier 2 emotes, a badge and ad-free chat replay",
  "Every emote, a badge, and a shout-out each month",
] as const;

/** Emote suffixes; channel codes are `<prefix><suffix>`. The `tier` is the subscriber tier needed. */
export const EMOTE_SUFFIXES: readonly { suffix: string; tier: number }[] = [
  { suffix: "Hi", tier: 0 },
  { suffix: "Love", tier: 0 },
  { suffix: "GG", tier: 0 },
  { suffix: "Hype", tier: 0 },
  { suffix: "Vip", tier: 1 },
  { suffix: "Crown", tier: 3 },
];

/**
 * streamer1's word filters, one per action. Literal patterns are escaped by chat and match
 * anywhere in a word, so no chat template may contain them (a unit test runs the real filters
 * over every generated line). The regex passes `@commonair/safe-regex`.
 */
export const WORD_FILTERS = {
  block: { pattern: "spoilerz", isRegex: false, action: "block", replacement: null },
  replace: { pattern: "frick", isRegex: false, action: "replace", replacement: "fr*ck" },
  hold: { pattern: "fr[e3]{2} ?c[o0]ins?", isRegex: true, action: "hold", replacement: null },
} as const;

/** Lines that trip streamer1's replace and hold filters (stored as chat records them). */
export const TRIP_LINES = {
  replace: ["oh frick, the tablet died again", "frick that was close"],
  hold: ["get fr33 coins in my profile", "free coins for the first ten people"],
} as const;

export const CHAT_PLAIN = [
  "hello from the other side of the world",
  "good evening everyone",
  "this is so relaxing",
  "how long have you been doing this?",
  "first time here, love the vibe",
  "the colors on that are great",
  "what tool are you using right now?",
  "lol",
  "that was amazing",
  "can we get a replay of that part",
  "back from dinner, what did I miss",
  "the music today is perfect",
  "chat is so wholesome tonight",
  "is there a schedule somewhere?",
  "nice save!",
  "I learned something new today",
  "my cat is watching with me",
  "we believe in you",
  "brb, coffee refill",
  "that idea is genius",
  "do you take suggestions?",
  "how is everyone doing?",
  "hydrate reminder for the streamer",
  "this stream deserves more viewers",
  "ok that was unexpected",
  "pog",
  "so smooth",
  "I am taking notes",
  "one more round!",
  "goodnight all, see you next stream",
] as const;

export const CHAT_REPLIES = [
  "agreed",
  "same here",
  "haha yes",
  "exactly what I was thinking",
  "welcome!",
  "good question",
  "no way",
  "it was in the last stream I think",
] as const;

export const CHAT_MENTIONS = [
  "hi {mention}!",
  "{mention} you made it",
  "{mention} look at this",
  "thanks {mention}",
] as const;

export const CHAT_ACTIONS = ["waves", "claps", "dances", "sips tea", "cheers"] as const;

export const OWNER_LINES = [
  "thanks for hanging out everyone",
  "welcome in!",
  "ok next part, let us go",
  "I appreciate all of you",
  "remember to be kind in chat",
] as const;

/** Browser strings for seeded sessions (generic, no real device fingerprints). */
export const USER_AGENTS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
] as const;

export const PASSKEY_NAMES = ["Laptop", "Phone"] as const;

export const BAN_REASONS = { timeout: "spam", ban: "harassment" } as const;

/** Where links in seeded panels and the moved notice point (RFC 6761 reserved, never resolves). */
export const SEED_LINK_HOST = "links.demo-seed.invalid";
export const MOVED_TO_HOST = "moved.demo-seed.invalid";
