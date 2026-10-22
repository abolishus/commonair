// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The OBS overlay's connection state machine with a fake API, a fake `EventSource` and a manual
 * clock: live on open, alerts forwarded (bad frames dropped), `revoked` and 401 end it for good,
 * network errors and silent stalls reconnect with backoff.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  OVERLAY_STALL_MS,
  connectOverlay,
  parseAlertFrame,
  type EventSourceLike,
  type OverlayConnectionDeps,
} from "../src/lib/overlay-connection.ts";

type Listener = (event: { data?: unknown }) => void;

class FakeEventSource implements EventSourceLike {
  closed = false;
  readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const ALERT = {
  id: "0192f000-0000-7000-8000-0000000000f1",
  type: "tip",
  text: "Viewer tipped $2.50",
  message: "nice",
  amountCents: 250,
  currency: "usd",
  durationMs: 5000,
  animation: "fade",
  test: false,
  occurredAt: "2026-10-22T12:00:00.000Z",
};

const unauthorized = Object.assign(new Error("A valid overlay token is required"), { code: "UNAUTHORIZED" });

function harness(stateAnswers: (() => Promise<{ eventsUrl: string }>)[]) {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const sources: FakeEventSource[] = [];
  const states: string[] = [];
  const alerts: unknown[] = [];
  let stateCalls = 0;
  const deps: OverlayConnectionDeps = {
    loadState: () => {
      const answer = stateAnswers[Math.min(stateCalls, stateAnswers.length - 1)];
      stateCalls++;
      return answer ? answer() : Promise.reject(new Error("no answer"));
    },
    openEvents: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    random: () => 0,
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
      await flush();
    }
    clock = until;
  };
  const stop = connectOverlay(deps, { onState: (s) => states.push(s), onAlert: (a) => alerts.push(a) });
  return {
    stop,
    states,
    alerts,
    sources,
    flush,
    advance,
    stateCalls: () => stateCalls,
    pendingTimers: () => timers.size,
  };
}

const ok =
  (url = "https://api.example/overlay/events?token=t") =>
  () =>
    Promise.resolve({ eventsUrl: url });

describe("parseAlertFrame", () => {
  it("keeps what the overlay draws, drops everything else", () => {
    expect(parseAlertFrame(JSON.stringify(ALERT))).toEqual({
      id: ALERT.id,
      type: "tip",
      text: "Viewer tipped $2.50",
      message: "nice",
      amountCents: 250,
      durationMs: 5000,
      animation: "fade",
      test: false,
    });
  });

  it.each([
    ["not json", "{"],
    ["wrong shape", JSON.stringify({ id: "x" })],
    ["unknown type", JSON.stringify({ ...ALERT, type: "raid-ish" })],
    ["not a string", 42],
  ])("ignores %s", (_name, data) => {
    expect(parseAlertFrame(data)).toBeNull();
  });
});

describe("connectOverlay", () => {
  it("connects with the state's eventsUrl and goes live on open", async () => {
    const h = harness([ok("https://api.example/overlay/events?token=abc")]);
    expect(h.states).toEqual(["connecting"]);
    await h.flush();
    expect(h.sources.map((s) => s.url)).toEqual(["https://api.example/overlay/events?token=abc"]);
    h.sources[0]?.emit("open");
    expect(h.states).toEqual(["connecting", "live"]);
  });

  it("forwards alert frames and drops malformed ones", async () => {
    const h = harness([ok()]);
    await h.flush();
    const source = h.sources[0] as FakeEventSource;
    source.emit("open");
    source.emit("alert", JSON.stringify(ALERT));
    source.emit("alert", "{broken");
    source.emit("ping", "{}");
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ id: ALERT.id, amountCents: 250 });
  });

  it("revoked: refused, the stream closed, nothing scheduled", async () => {
    const h = harness([ok()]);
    await h.flush();
    const source = h.sources[0] as FakeEventSource;
    source.emit("open");
    source.emit("revoked", "{}");
    expect(h.states.at(-1)).toBe("refused");
    expect(source.closed).toBe(true);
    expect(h.pendingTimers()).toBe(0);
    await h.advance(120_000);
    expect(h.stateCalls()).toBe(1);
    source.emit("alert", JSON.stringify(ALERT));
    expect(h.alerts).toHaveLength(0);
  });

  it("a 401 from the state call refuses without reconnecting", async () => {
    const h = harness([() => Promise.reject(unauthorized)]);
    await h.flush();
    expect(h.states).toEqual(["connecting", "refused"]);
    expect(h.sources).toHaveLength(0);
    await h.advance(120_000);
    expect(h.stateCalls()).toBe(1);
  });

  it("a stream error asks the state call again: 401 there means refused", async () => {
    const h = harness([ok(), () => Promise.reject(unauthorized)]);
    await h.flush();
    const first = h.sources[0] as FakeEventSource;
    first.emit("open");
    first.emit("error");
    expect(first.closed).toBe(true);
    expect(h.states.at(-1)).toBe("connecting");
    await h.advance(1_000);
    expect(h.stateCalls()).toBe(2);
    expect(h.states.at(-1)).toBe("refused");
    expect(h.sources).toHaveLength(1);
  });

  it("network errors reconnect with growing backoff, reset once live", async () => {
    const failing = () => Promise.reject(new TypeError("fetch failed"));
    const h = harness([failing, failing, failing, ok()]);
    await h.flush();
    expect(h.stateCalls()).toBe(1);
    await h.advance(999);
    expect(h.stateCalls()).toBe(1);
    await h.advance(1);
    expect(h.stateCalls()).toBe(2);
    await h.advance(1_999);
    expect(h.stateCalls()).toBe(2);
    await h.advance(1);
    expect(h.stateCalls()).toBe(3);
    await h.advance(4_000);
    expect(h.stateCalls()).toBe(4);
    const source = h.sources[0] as FakeEventSource;
    source.emit("open");
    expect(h.states.at(-1)).toBe("live");
    // Back to the first delay after a successful connection.
    source.emit("error");
    await h.advance(1_000);
    expect(h.stateCalls()).toBe(5);
    expect(h.sources).toHaveLength(2);
  });

  it("a server error (not 401) retries too", async () => {
    const h = harness([() => Promise.reject(Object.assign(new Error("x"), { code: "SERVICE_UNAVAILABLE" })), ok()]);
    await h.flush();
    expect(h.states.at(-1)).toBe("connecting");
    await h.advance(1_000);
    expect(h.sources).toHaveLength(1);
  });

  it("a stream silent past the stall limit is replaced", async () => {
    const h = harness([ok()]);
    await h.flush();
    const first = h.sources[0] as FakeEventSource;
    first.emit("open");
    await h.advance(OVERLAY_STALL_MS - 1_000);
    first.emit("ping", "{}");
    await h.advance(OVERLAY_STALL_MS - 1_000);
    expect(first.closed).toBe(false);
    await h.advance(1_000);
    expect(first.closed).toBe(true);
    expect(h.states.at(-1)).toBe("connecting");
    await h.advance(1_000);
    expect(h.sources).toHaveLength(2);
  });

  it("stop closes the stream and cancels every timer", async () => {
    const h = harness([ok()]);
    await h.flush();
    const source = h.sources[0] as FakeEventSource;
    source.emit("open");
    h.stop();
    expect(source.closed).toBe(true);
    expect(h.pendingTimers()).toBe(0);
    source.emit("alert", JSON.stringify(ALERT));
    source.emit("error");
    expect(h.alerts).toHaveLength(0);
    await h.advance(120_000);
    expect(h.stateCalls()).toBe(1);
  });

  it("stop before the state answers opens nothing", async () => {
    const h = harness([ok()]);
    h.stop();
    await h.flush();
    expect(h.sources).toHaveLength(0);
  });
});
