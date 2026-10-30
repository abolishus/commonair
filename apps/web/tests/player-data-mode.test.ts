// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The controller's data mode (ADR 0018): `playback.start` sends the ceiling, `setDataMode` goes
 * out with the next beat and the player reloads on the token that carries it (hls.js and native
 * fakes), hls.js is capped, P2P is never asked for, and `dataUsage` meters HTTP bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { dataModeCeilingBps } from "@commonair/contracts/enums";
import { DataUsageMeter } from "../src/player/stats.ts";
import { FakeHls, fakeApi, playbackStart } from "./p2p-fakes.ts";

class DataHls extends FakeHls {
  static override Events = { ...FakeHls.Events, MANIFEST_PARSED: "hlsManifestParsed" };
  levels: { bitrate: number; videoCodec?: string; width?: number; uri: string }[] = [];
  currentLevel = -1;
  autoLevelCapping = -1;
}

vi.mock("hls.js", () => ({ default: DataHls }));

const { PlayerController } = await import("../src/player/controller.ts");

const AUDIO = dataModeCeilingBps(50);
const LOW = dataModeCeilingBps(800);
const BEAT_MS = 700_000;

/** A playback token as the API signs it: base64url JSON claims, a dot, a signature. */
function token(extra: Record<string, unknown> = {}): string {
  const claims = { v: 1, sid: "s", cid: "c", path: "live/rivertide", src: "origin", iat: 1, exp: 2, ...extra };
  return `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
}

type Started = Omit<ReturnType<typeof playbackStart>, "dataMode" | "renditions" | "source"> & {
  dataMode: number | null;
  renditions: ("source" | "480p")[];
  source: "origin" | "cdn";
};

/** `fakeApi` is typed for the P2P tests' fixture; these widen it. */
const apiFor = (st: Started) => fakeApi(st as unknown as ReturnType<typeof playbackStart>);

function started(dataMode: number | null, over: Parameters<typeof playbackStart>[0] = { enabled: false }): Started {
  const s = playbackStart(over);
  const t = token(dataMode === null ? {} : { dm: dataMode });
  return {
    ...s,
    token: t,
    playlistUrl: `https://play.example/hls/live/rivertide/index.m3u8?t=${t}`,
    renditions: ["source" as const, "480p" as const],
    dataMode,
  };
}

const LEVELS = [
  { bitrate: 1_400_000, videoCodec: "avc1.64001e", width: 854, uri: "480p/index.m3u8" },
  { bitrate: 2_100_000, videoCodec: "avc1.42c01e", width: 640, uri: "index.m3u8" },
];

beforeEach(() => {
  FakeHls.instances = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function hlsSession(opts: { dataMode?: number | null; start?: Started } = {}) {
  const st = opts.start ?? started(opts.dataMode ?? null);
  const f = apiFor(st);
  const video = document.createElement("video");
  vi.spyOn(video, "canPlayType").mockReturnValue("");
  vi.spyOn(video, "play").mockResolvedValue(undefined);
  const applied: (number | null)[] = [];
  const c = new PlayerController({
    channel: "rivertide",
    video,
    api: f.api,
    onState: () => undefined,
    p2pWanted: () => true,
    dataMode: opts.dataMode ?? null,
    onDataMode: (dm) => applied.push(dm),
  });
  await c.start();
  const hls = FakeHls.instances[0] as DataHls;
  return { c, f, video, hls, applied, st };
}

const beatBody = (f: ReturnType<typeof fakeApi>, i = -1) =>
  f.heartbeat.mock.calls.at(i)?.[0] as Record<string, unknown> | undefined;

describe("playback.start", () => {
  it("sends the starting ceiling, never asks for P2P in data mode, reports the applied ceiling", async () => {
    const { c, f, applied } = await hlsSession({ dataMode: AUDIO });
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ dataMode: AUDIO, p2pCapable: false });
    expect(applied).toEqual([AUDIO]);
    await c.stop();
  });

  it("off: dataMode null, and P2P asked for as before", async () => {
    const { c, f, applied } = await hlsSession();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ dataMode: null, p2pCapable: true });
    expect(applied).toEqual([null]);
    await c.stop();
  });

  it("caps hls.js at the ceiling once the manifest is parsed", async () => {
    const { c, hls } = await hlsSession({ dataMode: LOW });
    hls.levels = LEVELS;
    hls.emit(DataHls.Events.MANIFEST_PARSED, {});
    expect(hls.autoLevelCapping).toBe(0);
    await c.stop();
  });
});

describe("setDataMode", () => {
  it("hls.js: the next beat sends dataMode, the new token reloads the playlist, later beats omit it", async () => {
    const { c, f, hls, applied } = await hlsSession();
    hls.levels = LEVELS;
    c.setDataMode(AUDIO);
    // Capped at once on the client: nothing fits, so the lowest level.
    expect(hls.autoLevelCapping).toBe(0);
    const next = token({ dm: AUDIO });
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: next });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(beatBody(f)).toMatchObject({ dataMode: AUDIO });
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(hls.loadSource.mock.calls[1]?.[0]).toBe(`https://play.example/hls/live/rivertide/index.m3u8?t=${next}`);
    expect(applied).toEqual([null, AUDIO]);
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(beatBody(f)).not.toHaveProperty("dataMode");
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    await c.stop();
  });

  it("a throttled or failed beat keeps the change pending; it is resent", async () => {
    const { c, f, hls } = await hlsSession();
    c.setDataMode(LOW);
    f.heartbeat.mockResolvedValueOnce({ ok: true, throttled: true });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    f.heartbeat.mockRejectedValueOnce(new Error("network"));
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: token({ dm: LOW }) });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(f.heartbeat.mock.calls.map((call) => (call[0] as Record<string, unknown>).dataMode)).toEqual([
      LOW,
      LOW,
      LOW,
    ]);
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    await c.stop();
  });

  it("turning it off sends null and reloads on the token without dm", async () => {
    const { c, f, hls, applied } = await hlsSession({ dataMode: AUDIO });
    c.setDataMode(null);
    expect(hls.autoLevelCapping).toBe(-1);
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: token() });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(beatBody(f)).toMatchObject({ dataMode: null });
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(applied).toEqual([AUDIO, null]);
    await c.stop();
  });

  it("a beat answered without a token (a concurrent beat won) leaves the change pending: resent, no reload", async () => {
    const { c, f, hls, applied } = await hlsSession();
    c.setDataMode(AUDIO);
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(beatBody(f)).toMatchObject({ dataMode: AUDIO });
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: token({ dm: AUDIO }) });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(beatBody(f)).toMatchObject({ dataMode: AUDIO });
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(applied).toEqual([null, AUDIO]);
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(beatBody(f)).not.toHaveProperty("dataMode");
    await c.stop();
  });

  it("P2P stops as soon as data mode is wanted", async () => {
    const { c } = await hlsSession();
    const disable = vi.spyOn(c, "disableP2P");
    (c as unknown as { p2p: object }).p2p = { disable: () => undefined, destroy: () => undefined };
    c.setDataMode(AUDIO);
    expect(disable).toHaveBeenCalledTimes(1);
    (c as unknown as { p2p: null }).p2p = null;
    await c.stop();
  });

  it("a move to the origin (switchTo) reloads once, on the switched playlist", async () => {
    const { c, f, hls, applied } = await hlsSession({ start: { ...started(null), source: "cdn" } });
    c.setDataMode(AUDIO);
    const next = token({ dm: AUDIO });
    const url = `https://origin.example/hls/live/rivertide/index.m3u8?t=${next}`;
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: next, switchTo: url });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(hls.loadSource.mock.calls[1]?.[0]).toBe(url);
    expect(applied).toEqual([null, AUDIO]);
    // A later ceiling change reloads the switched playlist, not the first one.
    c.setDataMode(LOW);
    const low = token({ dm: LOW });
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: low });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(hls.loadSource.mock.calls[2]?.[0]).toBe(`https://origin.example/hls/live/rivertide/index.m3u8?t=${low}`);
    await c.stop();
  });

  it("an ordinary token refresh with the same ceiling does not reload", async () => {
    const { c, f, hls } = await hlsSession({ dataMode: AUDIO });
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: token({ dm: AUDIO, exp: 99 }) });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(beatBody(f)).not.toHaveProperty("dataMode");
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it("native HLS: the reload is a source reload", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true }));
    const st = started(null);
    const f = apiFor(st);
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    const c = new PlayerController({ channel: "rivertide", video, api: f.api, onState: () => undefined });
    (c as unknown as { native: boolean }).native = true;
    await c.start();
    expect(FakeHls.instances).toHaveLength(0);
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ nativeHls: true, dataMode: null });
    expect(video.src).toBe(st.playlistUrl);
    c.setDataMode(AUDIO);
    const next = token({ dm: AUDIO });
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: next });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(video.src).toBe(`https://play.example/hls/live/rivertide/index.m3u8?t=${next}`);
    expect(play.mock.calls.length).toBeGreaterThanOrEqual(2);
    await c.stop();
  });

  it("before start: the value is what the session starts with", async () => {
    const f = apiFor(started(AUDIO));
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("");
    vi.spyOn(video, "play").mockResolvedValue(undefined);
    const c = new PlayerController({ channel: "rivertide", video, api: f.api, onState: () => undefined });
    c.setDataMode(AUDIO);
    await c.start();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ dataMode: AUDIO });
    await c.stop();
  });

  it("after stop it does nothing", async () => {
    const { c, f } = await hlsSession();
    await c.stop();
    c.setDataMode(AUDIO);
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(f.heartbeat).not.toHaveBeenCalled();
  });
});

describe("the rest of the seam is unchanged", () => {
  it("without data mode hls.js is never capped and no manifest handler is added", async () => {
    const { c, hls } = await hlsSession();
    expect(hls.handlers.get(DataHls.Events.MANIFEST_PARSED)).toBeUndefined();
    hls.levels = LEVELS;
    expect(hls.autoLevelCapping).toBe(-1);
    expect(c.playbackMode()).toBe("live");
    expect(c.setTargetLatency(4)).toBe(4);
    await c.stop();
  });
});

describe("dataUsage and playableLevels", () => {
  it("HTTP bytes from hls.js, and a rate once a few seconds have passed", async () => {
    const { c, hls } = await hlsSession({ dataMode: AUDIO });
    expect(c.dataUsage()).toEqual({ bytes: 0, mbPerHour: 0 });
    hls.emit(DataHls.Events.FRAG_LOADED, { frag: { stats: { loaded: 12_000 } } });
    hls.emit(DataHls.Events.LEVEL_LOADED, { stats: { loaded: 3_000 } });
    expect(c.dataUsage().bytes).toBe(15_000);
    await c.stop();
  });

  it("levels: hls.js's own, else nominal rungs of the advertised renditions", async () => {
    const { c, hls } = await hlsSession();
    expect(c.playableLevels()).toEqual([
      { bitrate: 192_000, audioOnly: true },
      { bitrate: 1_296_000, audioOnly: false },
    ]);
    hls.levels = [{ bitrate: 150_000, uri: "audio.m3u8" }, ...LEVELS];
    expect(c.playableLevels()).toEqual([
      { bitrate: 150_000, audioOnly: true },
      { bitrate: 1_400_000, audioOnly: false },
      { bitrate: 2_100_000, audioOnly: false },
    ]);
    await c.stop();
  });
});

describe("DataUsageMeter", () => {
  it("rate over the window, 0 until five seconds of data", () => {
    let now = 0;
    const m = new DataUsageMeter(() => now, 60_000);
    expect(m.sample(0)).toEqual({ bytes: 0, mbPerHour: 0 });
    now = 4_000;
    expect(m.sample(10_000).mbPerHour).toBe(0);
    now = 10_000;
    // 25 kB in 10 s = 2.5 kB/s = 9 MB an hour.
    expect(m.sample(25_000)).toEqual({ bytes: 25_000, mbPerHour: 9 });
  });

  it("forgets samples older than the window, keeping one at its start", () => {
    let now = 0;
    const m = new DataUsageMeter(() => now, 10_000);
    m.sample(0);
    now = 5_000;
    m.sample(1_000_000);
    now = 20_000;
    m.sample(1_000_000);
    now = 30_000;
    // Only the last 10 s (no bytes) remain in the rate.
    expect(m.sample(1_000_000).mbPerHour).toBe(0);
  });

  it("restart drops the rate but not the bytes; counts never go down", () => {
    let now = 0;
    const m = new DataUsageMeter(() => now);
    m.sample(0);
    now = 10_000;
    m.sample(50_000);
    m.restart();
    expect(m.usage()).toEqual({ bytes: 50_000, mbPerHour: 0 });
    expect(m.sample(10).bytes).toBe(50_000);
    expect(m.sample(Number.NaN).bytes).toBe(50_000);
  });
});
