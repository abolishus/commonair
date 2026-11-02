// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-interact's fixed vocabulary: bot commands, timers and variables, poll and prediction
 * questions, goal titles, alert templates, giveaway prizes and song links. Pure data; the plan picks
 * from it with the unit's PRNG. No real names, brands, URLs or people: links point at `.invalid`
 * hosts, and nothing here is personal data.
 */
import type { ALERT_TYPES, GOAL_TYPES, USER_LEVELS } from "@commonair/contracts/enums";

export type UserLevel = (typeof USER_LEVELS)[number];
export type AlertType = (typeof ALERT_TYPES)[number];
export type GoalType = (typeof GOAL_TYPES)[number];

export interface CommandDef {
  name: string;
  aliases: string[];
  response: string;
  userLevel: UserLevel;
  cooldownSeconds: number;
  costPoints: number;
  enabled: boolean;
}

/**
 * streamer1's full command set: every user level, counters (`${count}`), variables (`${var:…}`),
 * the engine's built-ins, cooldowns, aliases, point-cost redemptions, mod-only and a disabled one.
 */
export const STREAMER1_COMMANDS: readonly CommandDef[] = [
  {
    name: "hug",
    aliases: ["cuddle"],
    response: "${user} sends a big pixel hug to ${touser}!",
    userLevel: "everyone",
    cooldownSeconds: 5,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "uptime",
    aliases: [],
    response: "${channel} has been live for ${uptime}.",
    userLevel: "everyone",
    cooldownSeconds: 30,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "schedule",
    aliases: ["when"],
    response: "Streams are on ${var:schedule}.",
    userLevel: "everyone",
    cooldownSeconds: 60,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "socials",
    aliases: ["links"],
    response: "Find Aurora's gallery at https://gallery.demo-seed.invalid/aurora",
    userLevel: "everyone",
    cooldownSeconds: 120,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "lurk",
    aliases: [],
    response: "${user} is lurking with a warm drink. Enjoy the pixels!",
    userLevel: "follower",
    cooldownSeconds: 10,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "palette",
    aliases: [],
    response: "Today's palette: ${var:palette}. Thanks for subscribing, ${user}!",
    userLevel: "subscriber",
    cooldownSeconds: 15,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "vipcheer",
    aliases: [],
    response: "${user} starts the VIP cheer. Pixel power!",
    userLevel: "vip",
    cooldownSeconds: 60,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "so",
    aliases: ["shoutout"],
    response: "Go and say hello to ${touser}: they make lovely things too.",
    userLevel: "moderator",
    cooldownSeconds: 30,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "oops",
    aliases: [],
    response: "Undo count today: ${count}.",
    userLevel: "moderator",
    cooldownSeconds: 3,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "today",
    aliases: [],
    response: "Today's project: ${var:project}.",
    userLevel: "broadcaster",
    cooldownSeconds: 0,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "hydrate",
    aliases: ["water"],
    response: "${user} spent 100 ${pointsName}: Aurora takes a sip of water!",
    userLevel: "everyone",
    cooldownSeconds: 300,
    costPoints: 100,
    enabled: true,
  },
  {
    name: "spotlight",
    aliases: [],
    response: "${user} spent 500 ${pointsName} to pick the next sprite colour. ${points} left.",
    userLevel: "follower",
    cooldownSeconds: 600,
    costPoints: 500,
    enabled: true,
  },
  {
    name: "oldraffle",
    aliases: [],
    response: "The old raffle is over; giveaways have their own panel now.",
    userLevel: "everyone",
    cooldownSeconds: 5,
    costPoints: 0,
    enabled: false,
  },
];

/** streamer2's minimal set. */
export const STREAMER2_COMMANDS: readonly CommandDef[] = [
  {
    name: "song",
    aliases: [],
    response: "Now playing an original loop. Ask with !sr for your own.",
    userLevel: "everyone",
    cooldownSeconds: 30,
    costPoints: 0,
    enabled: true,
  },
  {
    name: "hello",
    aliases: ["hi"],
    response: "Hi ${user}, welcome to the beats!",
    userLevel: "everyone",
    cooldownSeconds: 10,
    costPoints: 0,
    enabled: true,
  },
];

export interface TimerDef {
  name: string;
  message: string;
  intervalMinutes: number;
  minChatLines: number;
  enabled: boolean;
}

export const STREAMER1_TIMERS: readonly TimerDef[] = [
  {
    name: "Hydration",
    message: "Remember to drink some water! Redeem !hydrate to remind Aurora too.",
    intervalMinutes: 30,
    minChatLines: 10,
    enabled: true,
  },
  {
    name: "Gallery",
    message: "Finished pieces live in the gallery: !socials",
    intervalMinutes: 45,
    minChatLines: 15,
    enabled: true,
  },
  {
    name: "Points",
    message: "You earn ${pointsName} by watching. Check yours with !points.",
    intervalMinutes: 20,
    minChatLines: 5,
    enabled: true,
  },
  {
    name: "Commissions",
    message: "Commissions open on Fridays.",
    intervalMinutes: 60,
    minChatLines: 20,
    enabled: false,
  },
];

export const STREAMER2_TIMERS: readonly TimerDef[] = [
  {
    name: "Requests",
    message: "Song requests are open: !sr <link>",
    intervalMinutes: 25,
    minChatLines: 8,
    enabled: true,
  },
];

export const STREAMER1_VARIABLES: Readonly<Record<string, string>> = {
  schedule: "Mon, Wed and Fri from 18:00 UTC",
  palette: "dusk teal, ember orange and moss",
  project: "a tiny lighthouse island",
  quote: "Every pixel counts.",
  sprites_done: "42",
};

export const STREAMER2_VARIABLES: Readonly<Record<string, string>> = { bpm: "92" };

/** streamer1's points are renamed, so `${pointsName}` shows the channel's own currency. */
export const STREAMER1_POINTS_NAME = "pixels";

export const POLL_QUESTIONS: readonly { title: string; choices: readonly string[] }[] = [
  { title: "What should I draw next?", choices: ["Castle", "Forest", "Spaceship", "Harbour", "Desert"] },
  { title: "Which palette tonight?", choices: ["Warm", "Cool", "Pastel", "Monochrome"] },
  { title: "Longer streams on Fridays?", choices: ["Yes", "No", "Only sometimes"] },
  { title: "Best snack for a long session?", choices: ["Popcorn", "Fruit", "Biscuits", "Nothing"] },
  { title: "Which tempo for the next loop?", choices: ["Slow", "Medium", "Fast"] },
  { title: "Pick the next game night theme", choices: ["Puzzles", "Racing", "Co-op", "Retro"] },
  { title: "How did you find the channel?", choices: ["Directory", "A raid", "A friend", "Search"] },
  { title: "Sprite size for the next piece?", choices: ["16 px", "32 px", "64 px"] },
  { title: "Should the cat get a cameo?", choices: ["Of course", "Next time"] },
  { title: "Which tool should I try?", choices: ["Dithering", "Outlines", "Gradients", "Shading"] },
];

export const PREDICTION_QUESTIONS: readonly { title: string; outcomes: readonly string[] }[] = [
  { title: "Will the sprite be done before break?", outcomes: ["Yes", "No"] },
  { title: "How many colours will the piece use?", outcomes: ["Under 8", "8 to 16", "Over 16"] },
  { title: "Will Aurora redraw the tree again?", outcomes: ["Yes", "No"] },
  { title: "Does the next loop go over 100 bpm?", outcomes: ["Yes", "No"] },
];

/** Titles per goal type; `target` is a count, or minor currency units for tips. */
export const GOAL_TITLES: Readonly<Record<GoalType, readonly string[]>> = {
  followers: ["Road to the next follower milestone", "Follower party", "New friends goal"],
  subscriptions: ["Sub goal: new brushes", "Sub goal: a second monitor", "Sub train"],
  tips: ["Tablet fund", "Charity art night", "Studio lights"],
};

export const GOAL_TARGETS: Readonly<Record<GoalType, readonly number[]>> = {
  followers: [25, 50, 100, 250],
  subscriptions: [5, 10, 20],
  tips: [10_000, 25_000, 50_000],
};

export const ALERT_TEMPLATES: Readonly<Record<AlertType, { message: string; animation: "fade" | "slide" | "none" }>> = {
  follow: { message: "${user} just followed. Welcome!", animation: "fade" },
  subscription: { message: "${user} subscribed at ${tier}!", animation: "slide" },
  tip: { message: "${user} tipped ${amount}: ${message}", animation: "slide" },
  raid: { message: "${user} is raiding with ${viewers} viewers!", animation: "fade" },
};

export const GIVEAWAY_PRIZES: readonly { title: string; prize: string }[] = [
  { title: "Pixel pack giveaway", prize: "A pack of hand-drawn sprite sheets" },
  { title: "Poster giveaway", prize: "A printed lighthouse island poster" },
];

/** A keyword viewers type in chat to enter (the API also takes entries directly). */
export const GIVEAWAY_KEYWORD = "!pixeldrop";

export const SONG_TITLES: readonly string[] = [
  "lofi-lighthouse",
  "rainy-pixels",
  "harbour-at-dusk",
  "eight-bit-sunrise",
  "moss-and-ember",
  "slow-train-home",
  "teal-tide",
  "paper-lanterns",
  "quiet-arcade",
  "cloud-hopper",
  "midnight-kettle",
  "lantern-walk",
];

/** Song links: never fetched by the platform (ADR 0026 decision 6), and never a real host. */
export const songUrl = (title: string, n: number): string => `https://tracks.demo-seed.invalid/${title}?take=${n}`;
