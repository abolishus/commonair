// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fair-discovery ranking (pure). The formula is documented in ./README.md and
 * served by `directory.ranking`; its weights come from the governance setting
 * `discovery.ranking`. Keep the README, `RANKING_EXPLANATION` and this code in sync.
 */
import type { DiscoveryRanking } from "../lib/settings.ts";

export interface LiveEntry {
  channelId: string;
  channelCreatedAt: Date;
  broadcastStartedAt: Date;
  /** Verified viewers only. */
  viewers: number;
  /** Non-excluded follows in the last 24 hours. */
  follows24h: number;
  mature: boolean;
}

export interface ScoreParts {
  viewers: number;
  freshness: number;
  followMomentum: number;
  smallChannelBoost: number;
  score: number;
}

const HOUR_MS = 3_600_000;

/** log-scaled share of the busiest value; 0 when nothing has any. */
const logShare = (v: number, max: number) => (max > 0 ? Math.log1p(Math.max(0, v)) / Math.log1p(max) : 0);

export function scoreParts(
  e: LiveEntry,
  ctx: { maxViewers: number; maxFollows24h: number; now: Date },
  cfg: DiscoveryRanking,
): ScoreParts {
  const hoursLive = Math.max(0, (ctx.now.getTime() - e.broadcastStartedAt.getTime()) / HOUR_MS);
  const viewers = logShare(e.viewers, ctx.maxViewers);
  const freshness = 1 / (1 + hoursLive);
  const followMomentum = logShare(e.follows24h, ctx.maxFollows24h);
  const small = cfg.spotlightMaxViewers;
  const smallChannelBoost = e.viewers <= small ? 1 : (small + 1) / (e.viewers + 1);
  const w = cfg.weights;
  const score =
    w.viewers * viewers + w.freshness * freshness + w.followMomentum * followMomentum + w.smallChannelBoost * smallChannelBoost;
  return { viewers, freshness, followMomentum, smallChannelBoost, score };
}

/** FNV-1a 32-bit: a stable, dependency-free hash for deterministic ordering. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const byHash = (salt: string) => (a: LiveEntry, b: LiveEntry) =>
  stableHash(salt + a.channelId) - stableHash(salt + b.channelId) || a.channelId.localeCompare(b.channelId);

/** Blended ranking, highest score first; ties broken deterministically. */
export function rankLive(entries: readonly LiveEntry[], cfg: DiscoveryRanking, now: Date): LiveEntry[] {
  const ctx = {
    now,
    maxViewers: Math.max(0, ...entries.map((e) => e.viewers)),
    maxFollows24h: Math.max(0, ...entries.map((e) => e.follows24h)),
  };
  const scored = entries.map((e) => ({ e, s: scoreParts(e, ctx, cfg).score }));
  const tie = byHash("rank");
  return scored.sort((a, b) => b.s - a.s || tie(a.e, b.e)).map((x) => x.e);
}

export const spotlightWindow = (now: Date, minutes: number) => Math.floor(now.getTime() / (minutes * 60_000));

/**
 * Spotlight slots for small live channels. Candidates (≤ spotlightMaxViewers) are put in a
 * stable hashed order and each rotation window takes the next `slots` of them cyclically,
 * so consecutive windows never repeat a channel when there are at least 2 × slots
 * candidates, and repeat as few as possible otherwise.
 */
export function spotlight(entries: readonly LiveEntry[], cfg: DiscoveryRanking, now: Date): LiveEntry[] {
  const candidates = entries.filter((e) => e.viewers <= cfg.spotlightMaxViewers).sort(byHash("spotlight"));
  const n = candidates.length;
  const k = Math.min(cfg.spotlightSlots, n);
  if (k === 0) return [];
  const start = (spotlightWindow(now, cfg.spotlightRotationMinutes) * k) % n;
  return Array.from({ length: k }, (_, i) => candidates[(start + i) % n] as LiveEntry);
}

/** Live channels created within newChannelMaxAgeDays, newest first. */
export function newAndLive(entries: readonly LiveEntry[], cfg: DiscoveryRanking, now: Date): LiveEntry[] {
  const cutoff = now.getTime() - cfg.newChannelMaxAgeDays * 24 * HOUR_MS;
  return entries
    .filter((e) => e.channelCreatedAt.getTime() >= cutoff)
    .sort((a, b) => b.channelCreatedAt.getTime() - a.channelCreatedAt.getTime());
}

/** Mature streams appear only for confirmed adults who asked for them. */
export const matureFilter = (includeMature: boolean, confirmedAdult: boolean) => (e: { mature: boolean }) =>
  !e.mature || (includeMature && confirmedAdult);

/** Uniform pick (random is injectable for tests). */
export function pickRandom<T>(items: readonly T[], random: () => number = Math.random): T | null {
  if (items.length === 0) return null;
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))] ?? null;
}

export const RANKING_EXPLANATION = [
  "score = w.viewers × V + w.freshness × F + w.followMomentum × M + w.smallChannelBoost × S, where",
  "V = log(1 + verified viewers) / log(1 + most verified viewers on any live channel);",
  "F = 1 / (1 + hours since the broadcast started);",
  "M = log(1 + follows in the last 24 h) / log(1 + most follows in 24 h on any live channel);",
  "S = 1 for channels at or under spotlightMaxViewers, else (spotlightMaxViewers + 1) / (viewers + 1).",
  "Only verified viewers and non-excluded follows count. Spotlight: spotlightSlots channels with at most",
  "spotlightMaxViewers verified viewers, rotating every spotlightRotationMinutes in a fixed hashed order so",
  "consecutive windows show different channels. New and live: channels created within newChannelMaxAgeDays.",
].join(" ");
