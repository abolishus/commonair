// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat replay model (W2-vod-watch, `chat/replay/model.ts`) with a fake server and fake time:
 * ordering across pages and equal `at`, the reveal boundary to the microsecond, seeking back and
 * forward (paging on, starting again with `from`, a server that ignores `from`), the cursor end,
 * `retained`, `catchingUp`, `replyTo: null`, blocks made mid-visit, a failed fetch and its retry,
 * an empty broadcast, prefetch about two minutes ahead and a viewer change.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  countAtOrBefore,
  ReplayModel,
  REPLAY_AHEAD_MICROS,
  type BlockedSet,
  type ReplayClock,
  type ReplayFetchInput,
  type ReplayItem,
  type ReplayModelOptions,
  type ReplayPage,
} from "../src/chat/replay/model.ts";
import { dateToMicros, isoToMicros, microsToDate } from "../src/chat/replay/time.ts";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const S = 1_000_000;
/** An ISO instant `sec` seconds (fractional allowed) and `us` extra microseconds after T0. */
function at(sec: number, us = 0): string {
  const totalUs = Math.round(sec * S) + us;
  const ms = Math.floor(totalUs / 1000);
  const rest = totalUs - ms * 1000;
  const base = new Date(T0 + ms).toISOString(); // …SS.mmmZ
  return `${base.slice(0, -1)}${String(rest).padStart(3, "0")}Z`;
}
const us = (iso: string) => isoToMicros(iso);

let seq = 0;
function item(
  atIso: string,
  over: Partial<ReplayItem> & { userId?: string; username?: string; id?: string } = {},
): ReplayItem {
  seq++;
  const { userId, username, ...rest } = over;
  return {
    id: `01900000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "01900000-0000-7000-8000-00000000c001",
    user: {
      id: userId ?? "01900000-0000-7000-8000-0000000000a1",
      username: username ?? "fan",
      displayName: "Fan",
      color: null,
      badges: [],
      accountType: "human",
    },
    body: `line ${seq}`,
    emotes: [],
    isAction: false,
    replyTo: null,
    mediaTs: atIso,
    createdAt: atIso,
    at: atIso,
    catchingUp: false,
    ...rest,
  } as ReplayItem;
}

/** A fake `vods.chat`: pages of `size` over `items` (sorted by the caller), `from` honoured unless told not to. */
class FakeServer {
  calls: ReplayFetchInput[] = [];
  failNext = 0;
  pending: { resolve: () => void }[] = [];
  hold = false;
  constructor(
    private items: ReplayItem[],
    private opts: { size?: number; retained?: boolean; honourFrom?: boolean } = {},
  ) {}

  fetch = (input: ReplayFetchInput): Promise<ReplayPage> => {
    this.calls.push(input);
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error("network"));
    }
    const size = this.opts.size ?? input.limit;
    let start = 0;
    if (input.cursor !== undefined) start = Number(input.cursor);
    else if (input.from !== undefined && this.opts.honourFrom !== false) {
      const from = isoToMicros(input.from);
      start = this.items.findIndex((i) => isoToMicros(i.at) >= from);
      if (start < 0) start = this.items.length;
    }
    const page = this.items.slice(start, start + size);
    const next = start + size < this.items.length ? String(start + size) : null;
    const result: ReplayPage = {
      items: page,
      nextCursor: next,
      retained: this.opts.retained ?? true,
    };
    if (!this.hold) return Promise.resolve(result);
    return new Promise((resolve) => this.pending.push({ resolve: () => resolve(result) }));
  };

  release(): void {
    const p = this.pending.splice(0);
    for (const x of p) x.resolve();
  }
}

class FakeClock implements ReplayClock {
  timers: { fn: () => void; ms: number; id: number }[] = [];
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.push({ fn, ms, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  /** Run the earliest timer; returns its delay. */
  fire(): number {
    const t = this.timers.shift();
    if (!t) throw new Error("no timer");
    t.fn();
    return t.ms;
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function model(server: FakeServer, opts: Partial<ReplayModelOptions> = {}) {
  const clock = new FakeClock();
  const m = new ReplayModel({ fetch: server.fetch, clock, ...opts });
  m.start();
  return { m, clock };
}

const ids = (m: ReplayModel) => m.snapshot().lines.map((l) => l.item.id);
const blocked = (idsIn: string[], usernames: string[] = []): BlockedSet => ({
  ids: new Set(idsIn),
  usernames: new Set(usernames),
});

describe("time", () => {
  it("parses microseconds, offsets and plain milliseconds", () => {
    expect(isoToMicros("2026-11-01T12:00:00.123456Z")).toBe(T0 * 1000 + 123456);
    expect(isoToMicros("2026-11-01T12:00:00.1Z")).toBe(T0 * 1000 + 100000);
    expect(isoToMicros("2026-11-01T12:00:00Z")).toBe(T0 * 1000);
    expect(isoToMicros("2026-11-01T13:00:00.000001+01:00")).toBe(T0 * 1000 + 1);
    expect(isoToMicros("2026-11-01T12:00:00.1234567Z")).toBe(T0 * 1000 + 123456);
    expect(Number.isNaN(isoToMicros("yesterday"))).toBe(true);
    expect(dateToMicros(new Date(T0))).toBe(T0 * 1000);
    expect(microsToDate(T0 * 1000 + 999).getTime()).toBe(T0);
  });

  it("counts lines at or before an instant (binary search)", () => {
    const lines = [1, 2, 2, 5].map((atMicros) => ({ atMicros }));
    expect(countAtOrBefore(lines, 0)).toBe(0);
    expect(countAtOrBefore(lines, 2)).toBe(3);
    expect(countAtOrBefore(lines, 4)).toBe(3);
    expect(countAtOrBefore(lines, 5)).toBe(4);
    expect(countAtOrBefore([], 5)).toBe(0);
  });
});

describe("ReplayModel", () => {
  it("does nothing before start and fetches the first page on start", async () => {
    const server = new FakeServer([item(at(1))]);
    const m = new ReplayModel({ fetch: server.fetch, clock: new FakeClock() });
    await flush();
    expect(server.calls).toEqual([]);
    expect(m.snapshot().status).toBe("starting");
    m.start();
    await flush();
    expect(server.calls).toEqual([{ limit: 200 }]);
    expect(m.snapshot().status).toBe("ready");
  });

  it("shows nothing before the first frame", async () => {
    const server = new FakeServer([item(at(1))]);
    const { m } = model(server);
    await flush();
    expect(m.snapshot().lines).toEqual([]);
    m.setPlayhead(null);
    expect(m.snapshot().lines).toEqual([]);
  });

  it("reveals a line exactly at the playhead and not one microsecond before it", async () => {
    const a = item(at(10, 1));
    const server = new FakeServer([a]);
    const { m } = model(server);
    await flush();
    m.setPlayhead(us(at(10)));
    expect(ids(m)).toEqual([]);
    m.setPlayhead(us(at(10, 1)));
    expect(ids(m)).toEqual([a.id]);
    m.setPlayhead(us(at(10, 2)));
    expect(ids(m)).toEqual([a.id]);
  });

  it("keeps (at, id) order across pages, equal at included", async () => {
    const same = at(5, 7);
    const a = item(at(1));
    const b = item(same, { id: "01900000-0000-7000-8000-00000000000a" });
    const c = item(same, { id: "01900000-0000-7000-8000-00000000000b" });
    const d = item(at(5, 8));
    const e = item(at(9));
    const server = new FakeServer([a, b, c, d, e], { size: 2 });
    const { m } = model(server);
    m.setPlayhead(us(at(100)));
    await flush();
    expect(ids(m)).toEqual([a.id, b.id, c.id, d.id, e.id]);
    expect(server.calls.map((c2) => c2.cursor)).toEqual([undefined, "2", "4"]);
    m.setPlayhead(us(same));
    expect(ids(m)).toEqual([a.id, b.id, c.id]);
  });

  it("renders in order even when a page comes back out of order", async () => {
    const a = item(at(3));
    const b = item(at(1));
    const server = new FakeServer([a, b]);
    const { m } = model(server);
    m.setPlayhead(us(at(10)));
    await flush();
    expect(ids(m)).toEqual([b.id, a.id]);
  });

  it("seeking back trims the shown lines without fetching", async () => {
    const lines = [1, 2, 3, 4].map((s) => item(at(s)));
    const server = new FakeServer(lines);
    const { m } = model(server);
    m.setPlayhead(us(at(10)));
    await flush();
    const calls = server.calls.length;
    m.setPlayhead(us(at(2.5)));
    expect(ids(m)).toEqual([lines[0]?.id, lines[1]?.id]);
    m.setPlayhead(us(at(0)));
    expect(ids(m)).toEqual([]);
    expect(server.calls.length).toBe(calls);
  });

  it("prefetches about two minutes ahead and stops at the cursor end", async () => {
    // One line every 30 s for 10 minutes, 2 per page.
    const lines = Array.from({ length: 20 }, (_, i) => item(at(i * 30)));
    const server = new FakeServer(lines, { size: 2 });
    const { m } = model(server);
    await flush();
    // Before the first frame only the first page is fetched.
    expect(server.calls.length).toBe(1);
    m.setPlayhead(us(at(0)));
    await flush();
    // Loaded through ≥ 120 s ahead: lines at 0..150 s (3 pages).
    const loadedEnd = 30 * (server.calls.length * 2 - 1);
    expect(loadedEnd).toBeGreaterThanOrEqual(REPLAY_AHEAD_MICROS / S);
    expect(loadedEnd).toBeLessThan(REPLAY_AHEAD_MICROS / S + 60);
    expect(m.snapshot().loading).toBe(false);
    // Within the jump distance: pages on to the end.
    m.setPlayhead(us(at(19 * 30 + 1)));
    await flush();
    expect(ids(m)).toHaveLength(20);
    const after = server.calls.length;
    m.setPlayhead(us(at(20_000)));
    await flush();
    expect(server.calls.length).toBe(after);
    expect(server.calls.at(-1)?.cursor).toBe("18");
  });

  it("seeking forward pages on with a loading row while the playhead is past what is loaded", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => item(at(i * 60)));
    const server = new FakeServer(lines, { size: 2 });
    const { m } = model(server);
    await flush();
    server.hold = true;
    m.setPlayhead(us(at(300)));
    expect(m.snapshot().loading).toBe(true);
    expect(server.calls.at(-1)?.cursor).toBe("2");
    server.release();
    await flush();
    server.release();
    await flush();
    server.release();
    await flush();
    expect(m.snapshot().loading).toBe(false);
    expect(ids(m)).toEqual(lines.slice(0, 6).map((l) => l.id));
  });

  it("a seek far past what is loaded starts again at the target with from", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => item(at(i * 60)));
    const server = new FakeServer(lines, { size: 5 });
    const { m } = model(server);
    m.setPlayhead(us(at(0)));
    await flush();
    const before = server.calls.length;
    m.setPlayhead(us(at(150 * 60)));
    await flush();
    const restart = server.calls[before];
    expect(restart?.cursor).toBeUndefined();
    expect(restart?.from).toBe(new Date(T0 + (150 * 60 - 60) * 1000).toISOString());
    // From the backfill on, not from the start.
    expect(ids(m)[0]).toBe(lines[149]?.id);
    expect(ids(m).at(-1)).toBe(lines[150]?.id);
    // Seeking back before that span starts again there.
    m.setPlayhead(us(at(10 * 60)));
    await flush();
    expect(server.calls.some((c) => c.from === new Date(T0 + 9 * 60 * 1000).toISOString())).toBe(true);
    expect(ids(m)).toEqual([lines[9]?.id, lines[10]?.id]);
  });

  it("pages on from the start when the server ignores from", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => item(at(i * 60)));
    const server = new FakeServer(lines, { size: 50, honourFrom: false });
    const { m } = model(server);
    m.setPlayhead(us(at(0)));
    await flush();
    m.setPlayhead(us(at(150 * 60)));
    await flush();
    const froms = server.calls.filter((c) => c.from !== undefined);
    expect(froms).toHaveLength(1);
    // Every line up to the playhead, from the very first.
    expect(ids(m)).toEqual(lines.slice(0, 151).map((l) => l.id));
    // A later jump pages on instead of starting again.
    m.setPlayhead(us(at(199 * 60)));
    await flush();
    expect(server.calls.filter((c) => c.from !== undefined)).toHaveLength(1);
    expect(ids(m)).toHaveLength(200);
  });

  it("caps the rendered lines at the newest maxRows", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => item(at(i)));
    const { m } = model(new FakeServer(lines), { maxRows: 3 });
    m.setPlayhead(us(at(100)));
    await flush();
    expect(ids(m)).toEqual(lines.slice(7).map((l) => l.id));
  });

  it("an empty broadcast is the empty state", async () => {
    const { m } = model(new FakeServer([]));
    await flush();
    expect(m.snapshot().status).toBe("empty");
  });

  it("retained false with no items is the not-retained notice", async () => {
    const { m } = model(new FakeServer([], { retained: false }));
    await flush();
    expect(m.snapshot().status).toBe("not-retained");
  });

  it("retained false with items shows the items", async () => {
    const a = item(at(1));
    const { m } = model(new FakeServer([a], { retained: false }));
    m.setPlayhead(us(at(2)));
    await flush();
    expect(m.snapshot().status).toBe("ready");
    expect(ids(m)).toEqual([a.id]);
  });

  it("keeps catchingUp and a null replyTo as the server sent them", async () => {
    const a = item(at(1), { catchingUp: true, mediaTs: null });
    const b = item(at(2), { replyTo: null });
    const { m } = model(new FakeServer([a, b]));
    m.setPlayhead(us(at(3)));
    await flush();
    const [la, lb] = m.snapshot().lines;
    expect(la?.item.catchingUp).toBe(true);
    expect(lb?.item.replyTo).toBeNull();
    expect(lb?.quoteHidden).toBe(false);
  });

  it("hides an author blocked mid-visit, and a quote of them", async () => {
    const villain = "01900000-0000-7000-8000-0000000000b9";
    const a = item(at(1), { userId: villain, username: "villain" });
    const b = item(at(2), { replyTo: { id: a.id, username: "villain", body: "hi" } });
    const { m } = model(new FakeServer([a, b]));
    m.setPlayhead(us(at(3)));
    await flush();
    expect(ids(m)).toEqual([a.id, b.id]);
    m.setBlocked(blocked([villain], ["villain"]));
    expect(ids(m)).toEqual([b.id]);
    expect(m.snapshot().lines[0]?.quoteHidden).toBe(true);
    m.setBlocked(blocked([]));
    expect(ids(m)).toEqual([a.id, b.id]);
    expect(m.snapshot().lines[1]?.quoteHidden).toBe(false);
  });

  it("a video whose only author is blocked reads as empty", async () => {
    const villain = "01900000-0000-7000-8000-0000000000b9";
    const { m } = model(new FakeServer([item(at(1), { userId: villain })]));
    await flush();
    m.setBlocked(blocked([villain]));
    expect(m.snapshot().status).toBe("empty");
  });

  it("retries a failed fetch with backoff, and at once on retry()", async () => {
    const a = item(at(1));
    const server = new FakeServer([a]);
    server.failNext = 2;
    const { m, clock } = model(server);
    m.setPlayhead(us(at(2)));
    await flush();
    expect(m.snapshot()).toMatchObject({ status: "starting", error: true, loading: false });
    expect(clock.fire()).toBe(1_000);
    await flush();
    expect(m.snapshot().error).toBe(true);
    expect(clock.timers[0]?.ms).toBe(2_000);
    m.retry();
    expect(clock.timers).toEqual([]);
    await flush();
    expect(m.snapshot()).toMatchObject({ status: "ready", error: false });
    expect(ids(m)).toEqual([a.id]);
    expect(server.calls).toHaveLength(3);
  });

  it("a mid-stream page failure keeps the shown lines", async () => {
    const lines = [1, 2, 3, 4].map((s) => item(at(s * 60)));
    const server = new FakeServer(lines, { size: 2 });
    const { m, clock } = model(server);
    await flush();
    server.failNext = 1;
    m.setPlayhead(us(at(150)));
    await flush();
    expect(m.snapshot()).toMatchObject({ status: "ready", error: true });
    expect(ids(m)).toEqual([lines[0]?.id, lines[1]?.id]);
    clock.fire();
    await flush();
    expect(m.snapshot().error).toBe(false);
    expect(ids(m)).toEqual([lines[0]?.id, lines[1]?.id]);
  });

  it("stop drops a request in flight; start fetches again", async () => {
    const a = item(at(1));
    const server = new FakeServer([a]);
    server.hold = true;
    const m = new ReplayModel({ fetch: server.fetch, clock: new FakeClock() });
    m.start();
    m.stop();
    server.release();
    await flush();
    expect(m.snapshot().status).toBe("starting");
    server.hold = false;
    m.start();
    await flush();
    expect(m.snapshot().status).toBe("ready");
    expect(server.calls).toHaveLength(2);
  });

  it("reset (another viewer) refetches from the start and drops the old lines", async () => {
    const a = item(at(1));
    const server = new FakeServer([a]);
    const { m } = model(server);
    m.setPlayhead(us(at(2)));
    await flush();
    expect(ids(m)).toEqual([a.id]);
    server.hold = true;
    m.reset();
    expect(ids(m)).toEqual([]);
    expect(m.snapshot().status).toBe("starting");
    expect(server.calls.at(-1)).toEqual({ limit: 200 });
    server.release();
    await flush();
    expect(ids(m)).toEqual([a.id]);
  });

  it("a stale response after a restart is ignored", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => item(at(i * 60)));
    const server = new FakeServer(lines, { size: 5 });
    const { m } = model(server);
    m.setPlayhead(us(at(0)));
    await flush();
    server.hold = true;
    m.setPlayhead(us(at(5 * 60)));
    // A jump while that page is in flight starts again; the old page must not land.
    m.setPlayhead(us(at(40 * 60)));
    server.release();
    await flush();
    server.hold = false;
    m.setPlayhead(us(at(40 * 60)) + 1);
    await flush();
    expect(ids(m)[0]).toBe(lines[39]?.id);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const server = new FakeServer([item(at(1))]);
    const m = new ReplayModel({ fetch: server.fetch, clock: new FakeClock() });
    let n = 0;
    const off = m.subscribe(() => n++);
    m.start();
    await flush();
    expect(n).toBeGreaterThan(0);
    off();
    const seen = n;
    m.setPlayhead(us(at(5)));
    expect(n).toBe(seen);
  });
});
