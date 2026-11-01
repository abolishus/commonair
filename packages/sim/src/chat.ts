// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The simulated chat a rehearsal drives through the channel's real filters: timed messages at a
 * steady rate (varied bodies, emotes, one repeated body, links, the channel's own filter words)
 * plus one spam burst (duplicates, links and filtered words, faster than any person types).
 *
 * Pure: offsets are relative to the rehearsal's start, the clock belongs to the caller, and the
 * same seed yields the same script, so a restarted driver resumes by sequence number. Bodies come
 * from a fixed vocabulary and the channel's own filter words: never a name, an address or anything
 * a real viewer wrote.
 */
import { pick, seededRandom, type Random } from "./random.ts";
import { presentAt, viewers as makeViewers, type SimViewer } from "./viewers.ts";

/** What a message is meant to exercise; the report attributes held messages by it. */
export const SIM_MESSAGE_KINDS = ["chat", "emote", "repeat", "link", "filtered"] as const;
export type SimMessageKind = (typeof SIM_MESSAGE_KINDS)[number];

export interface SimMessage {
  /** 0-based position in the script; a resumed driver skips every `seq` it already sent. */
  seq: number;
  /** Offset from the rehearsal's start. */
  atMs: number;
  /** A synthetic sender (`v001` … or `spam1` …), never a real account. */
  senderKey: string;
  body: string;
  kind: SimMessageKind;
  /** Part of the spam burst. */
  burst: boolean;
}

export interface BurstOptions {
  /** When the burst starts (offset from the start). */
  atSeconds: number;
  count: number;
  /** The burst's messages are spread over this many seconds. */
  seconds: number;
}

export interface ChatScriptOptions {
  seed: string;
  /** Messages per second outside the burst. */
  rate: number;
  /** One spam burst, or null for none. */
  burst: BurstOptions | null;
  /** Literal words from the channel's own filter list (regex filters are not sampled). */
  filterWords?: readonly string[];
  /** How long the script runs (default the 30-minute rehearsal cap). */
  durationSeconds?: number;
  /** Synthetic senders; default 40 from `viewers()` with the same seed. */
  viewers?: readonly SimViewer[];
}

/** The rehearsal defaults (brief: ~3 msg/s, 50 messages in 5 s). */
export const DEFAULT_RATE = 3;
export const DEFAULT_BURST: BurstOptions = { atSeconds: 45, count: 50, seconds: 5 };
export const DEFAULT_VIEWERS = 40;

const PHRASES = [
  "hello from the rehearsal",
  "audio sounds clear",
  "video looks sharp",
  "can you hear me",
  "the overlay is in the corner",
  "what game is this",
  "nice setup",
  "is the camera on",
  "testing testing",
  "first time here",
  "the music is a bit loud",
  "looks smooth on my end",
  "framerate seems fine",
  "how long is the stream",
  "lets go",
  "this is going well",
] as const;
const EMOTES = [":)", ":D", "<3", "o/", "\\o/", ":P", ";)", "^_^"] as const;
/** The repeated body: many senders, the same words (duplicates are per sender, so these pass). */
export const REPEATED_BODY = "gg";
const LINKS = [
  "https://example.com/watch",
  "check this out https://example.org/clip",
  "http://example.net/free-stuff",
] as const;
const SPAMMERS = ["spam1", "spam2", "spam3"] as const;
/** The burst's duplicate body. */
export const BURST_BODY = "BUY FOLLOWERS NOW";

/** A literal word filter is a usable sample when it is a plain word or phrase. */
export function sampleableWords(words: readonly string[] | undefined): string[] {
  return (words ?? []).map((w) => w.trim()).filter((w) => w.length > 0 && w.length <= 100);
}

function normalBody(rand: Random, words: readonly string[]): { kind: SimMessageKind; body: string } {
  const r = rand();
  if (r < 0.06 && words.length > 0) return { kind: "filtered", body: `${pick(rand, PHRASES)} ${pick(rand, words)}` };
  if (r < 0.12) return { kind: "link", body: pick(rand, LINKS) };
  if (r < 0.18) return { kind: "repeat", body: REPEATED_BODY };
  if (r < 0.3) return { kind: "emote", body: `${pick(rand, EMOTES)} ${pick(rand, EMOTES)}` };
  // A counter-free variation keeps one sender from tripping the duplicate rule by chance.
  return { kind: "chat", body: `${pick(rand, PHRASES)} ${pick(rand, EMOTES)}` };
}

function burstBody(i: number, words: readonly string[]): { kind: SimMessageKind; body: string; sender: string } {
  // Thirds: one spammer repeating itself (duplicate, then rate limit), one posting links, one
  // using the channel's filter words (or more duplicates when the channel has none).
  const third = i % 3;
  if (third === 1) return { kind: "link", body: `${BURST_BODY} ${LINKS[i % LINKS.length]}`, sender: SPAMMERS[1] };
  if (third === 2 && words.length > 0)
    return { kind: "filtered", body: `${words[i % words.length]} ${words[i % words.length]}`, sender: SPAMMERS[2] };
  return { kind: "repeat", body: BURST_BODY, sender: SPAMMERS[0] };
}

/** The whole script, ordered by `atMs` then `seq`. */
export function chatScript(opts: ChatScriptOptions): SimMessage[] {
  if (!(opts.rate > 0)) throw new Error("rate must be positive");
  const rand = seededRandom(`chat:${opts.seed}`);
  const words = sampleableWords(opts.filterWords);
  const durationMs = (opts.durationSeconds ?? 1800) * 1000;
  const audience =
    opts.viewers ?? makeViewers({ count: DEFAULT_VIEWERS, seed: opts.seed, durationSeconds: durationMs / 1000 });
  const meanGapMs = 1000 / opts.rate;
  const lastSent = new Map<string, number>();
  const raw: Omit<SimMessage, "seq">[] = [];

  // Steady chat: gaps uniform in [0.5, 1.5) × the mean, so the rate holds without a metronome.
  for (let at = meanGapMs * (0.5 + rand()); at < durationMs; at += meanGapMs * (0.5 + rand())) {
    const present = presentAt(audience, at);
    if (present.length === 0) continue;
    // The least recently heard viewer speaks: one person never floods the rate limit.
    let sender = present[0] as SimViewer;
    for (const v of present) if ((lastSent.get(v.key) ?? -1) < (lastSent.get(sender.key) ?? -1)) sender = v;
    lastSent.set(sender.key, at);
    const { kind, body } = normalBody(rand, words);
    raw.push({ atMs: Math.floor(at), senderKey: sender.key, body, kind, burst: false });
  }

  if (opts.burst && opts.burst.count > 0) {
    const start = opts.burst.atSeconds * 1000;
    const span = opts.burst.seconds * 1000;
    for (let i = 0; i < opts.burst.count; i++) {
      const atMs = Math.floor(start + (span * i) / opts.burst.count);
      if (atMs >= durationMs) break;
      const { kind, body, sender } = burstBody(i, words);
      raw.push({ atMs, senderKey: sender, body, kind, burst: true });
    }
  }

  // Stable: equal offsets keep generation order, so the sequence is the same on every run.
  return raw
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.atMs - b.m.atMs || a.i - b.i)
    .map(({ m }, seq) => ({ ...m, seq }));
}

/** The messages due before `toMs` that were not sent yet (`seq >= nextSeq`), in order. */
export function dueMessages(script: readonly SimMessage[], nextSeq: number, toMs: number): SimMessage[] {
  const out: SimMessage[] = [];
  for (let i = Math.max(0, nextSeq); i < script.length; i++) {
    const m = script[i] as SimMessage;
    if (m.atMs >= toMs) break;
    out.push(m);
  }
  return out;
}
