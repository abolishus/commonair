// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-media's fixed vocabulary: broadcast titles, clip titles and the chat lines harness chat
 * clients say during recordings and `seed live`. Pure data; plans pick from it with the unit's PRNG.
 * No real names, brands, URLs or people.
 */

export const BROADCAST_TITLES: readonly string[] = [
  "Chill evening stream",
  "Late session, come hang out",
  "Trying something new today",
  "Weekly community night",
  "Speedrun practice (no promises)",
  "Building from scratch, part {n}",
  "Viewer requests hour",
  "Morning coffee and chat",
  "Long one today, settle in",
  "Learning in public, day {n}",
  "Quick stream before the weekend",
  "Back from the break",
];

export const CLIP_TITLES: readonly string[] = [
  "That moment",
  "Clean finish",
  "Chat called it",
  "Best part of the night",
  "Wait for it",
  "How did that work",
  "Perfect timing",
  "The setup pays off",
];

/** Chat lines; `{c}` is replaced with the channel owner's display handle. */
export const CHAT_LINES: readonly string[] = [
  "hi {c}!",
  "hello from the seed",
  "this looks great",
  "first time here, love it",
  "how long have you been streaming today?",
  "gg",
  "that was clean",
  "lol",
  "nice one",
  "the colors on this are so good",
  "what are we doing next?",
  "can you explain that last part again?",
  "audio sounds good on my end",
  "stream is super smooth tonight",
  "brb getting tea",
  "back",
  "this song though",
  "chat is cozy today",
  "wave to the new folks",
  "is this the test pattern era",
  "love the timer overlay",
  "big fan of the tone",
  "ok that was impressive",
  "do it again!",
];

/** Lines in a watch room. */
export const ROOM_LINES: readonly string[] = [
  "glad you could make it",
  "this part is my favourite",
  "are you hearing the tone too?",
  "brb",
  "ok I'm back",
  "same frame on my screen",
  "great pick for tonight",
];

/** Text streamer1 writes over the first caption cue (the correction). */
export const CAPTION_CORRECTION = "Welcome back, everyone, and thanks for tuning in.";

/** `{n}` in a title becomes a small number. Pure. */
export function fillTitle(template: string, n: number): string {
  return template.replace("{n}", String(n));
}

/** `{c}` in a chat line becomes the channel's owner handle. Pure. */
export function fillLine(template: string, owner: string): string {
  return template.replace("{c}", owner);
}
