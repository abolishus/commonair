// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calm Chat's digest (feature-wins §4.2): one polite live region, updated at most every
 * `DIGEST_INTERVAL_MS`, that says what came in since the last update ("12 new messages, 2 waves
 * (PogChamp ×312), 1 mention of you") instead of announcing every line. The interval is fixed
 * (not a setting in v1). Blocked users never reach it. Pure apart from the injected clock.
 */
import { formatNumber } from "@commonair/ui";
import { activeLocale, t } from "../../i18n/index.ts";

export const DIGEST_INTERVAL_MS = 5_000;
const LABEL_MAX = 40;

export interface DigestStats {
  messages: number;
  mentions: number;
  /** Rows the rate governor kept out of view. */
  hidden: number;
  /** Waves that grew in this period, by wave id: the wave's text and its count now. */
  waves: ReadonlyMap<string, { label: string; count: number }>;
}

export const EMPTY_STATS: DigestStats = { messages: 0, mentions: 0, hidden: 0, waves: new Map() };

function shortLabel(label: string): string {
  const s = label.trim();
  return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s;
}

/** The digest sentence, or null when there is nothing to say. */
export function digestText(stats: DigestStats): string | null {
  if (stats.messages === 0 && stats.hidden === 0) return null;
  let top: { label: string; count: number } | null = null;
  for (const w of stats.waves.values()) if (!top || w.count > top.count) top = w;
  return t("calmChat.digest", {
    messages: stats.messages,
    waves: stats.waves.size,
    top: top
      ? t("calmChat.digest.top", { label: shortLabel(top.label), count: formatNumber(top.count, activeLocale()) })
      : "",
    mentions: stats.mentions,
    hidden: stats.hidden,
  });
}

/** Collects what arrives and hands out a sentence at most once per interval. */
export class Digest {
  private stats = { messages: 0, mentions: 0, hidden: 0, waves: new Map<string, { label: string; count: number }>() };
  private lastAt: number | null = null;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(opts: { now: () => number; intervalMs?: number }) {
    this.now = opts.now;
    this.intervalMs = opts.intervalMs ?? DIGEST_INTERVAL_MS;
  }

  message(forMe: boolean): void {
    this.stats.messages++;
    if (forMe) this.stats.mentions++;
  }

  hidden(n: number): void {
    this.stats.hidden += n;
  }

  wave(id: string, label: string, count: number): void {
    this.stats.waves.set(id, { label, count });
  }

  /** What has been collected so far (for tests and the region's first text). */
  peek(): DigestStats {
    return this.stats;
  }

  /**
   * The sentence when at least one interval passed since the last one and something arrived;
   * otherwise null (and the counts keep collecting).
   */
  take(): string | null {
    const t0 = this.now();
    if (this.lastAt !== null && t0 - this.lastAt < this.intervalMs) return null;
    const text = digestText(this.stats);
    if (text === null) return null;
    this.lastAt = t0;
    this.stats = { messages: 0, mentions: 0, hidden: 0, waves: new Map() };
    return text;
  }

  reset(): void {
    this.stats = { messages: 0, mentions: 0, hidden: 0, waves: new Map() };
    this.lastAt = null;
  }
}
