// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fakes for the P2P tests: hls.js, the loader engine, the API. No WebRTC, no network. */
import { vi, type Mock } from "vite-plus/test";

type ApiFn = (input: unknown) => Promise<unknown>;
import type { Api } from "../src/lib/api.ts";

type Handler = (...args: unknown[]) => void;

/** hls.js's default loader: completes every load with `bytes` bytes. */
export class FakeBaseLoader {
  static bytes = 1000;
  constructor(public config: unknown) {}
  load(
    context: unknown,
    _config: unknown,
    callbacks: { onSuccess: (res: unknown, stats: { loaded: number }, ctx: unknown, net: unknown) => void },
  ) {
    callbacks.onSuccess({ data: "" }, { loaded: FakeBaseLoader.bytes }, context, null);
  }
  abort() {}
  destroy() {}
}

export class FakeHls {
  static Events = {
    FRAG_LOADED: "hlsFragLoaded",
    LEVEL_LOADED: "hlsLevelLoaded",
    ERROR: "hlsError",
    MANIFEST_LOADING: "hlsManifestLoading",
    MANIFEST_LOADED: "hlsManifestLoaded",
  };
  static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
  static DefaultConfig = { loader: FakeBaseLoader };
  static isSupported = () => true;
  static instances: FakeHls[] = [];

  handlers = new Map<string, Handler[]>();
  loadSource = vi.fn((_url: string) => this.emit(FakeHls.Events.MANIFEST_LOADING, {}));
  attachMedia = vi.fn();
  destroy = vi.fn();
  startLoad = vi.fn();
  recoverMediaError = vi.fn();
  playingDate: Date | null = null;

  constructor(public config: Record<string, unknown>) {
    FakeHls.instances.push(this);
  }

  on(event: string, fn: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }

  emit(event: string, data: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(event, data);
  }

  /** A request through the configured `loader` (what hls.js does for playlists and parts). */
  loadThroughLoader(): void {
    const Loader = this.config.loader as new (c: unknown) => FakeBaseLoader;
    new Loader(this.config).load({}, {}, { onSuccess: () => undefined });
  }
}

export class FakePool {
  listeners: Handler[] = [];
  addEventListener(_name: "error", fn: Handler) {
    this.listeners.push(fn);
  }
  removeEventListener(_name: "error", fn: Handler) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  fail() {
    for (const l of this.listeners) l(new Event("error"), "wss://tracker");
  }
}

export class FakeEngine {
  static instances: FakeEngine[] = [];
  listeners = new Map<string, Handler[]>();
  dynamic: Record<string, unknown>[] = [];
  destroyed = false;
  bound: unknown = null;
  core = { webTorrentSocketPool: new FakePool() };

  constructor(public config: { core: Record<string, unknown> }) {
    FakeEngine.instances.push(this);
  }
  getConfigForHlsJs() {
    return { fLoader: "FakeFragmentLoader", pLoader: "FakePlaylistLoader" };
  }
  bindHls(hls: unknown) {
    this.bound = hls;
  }
  addEventListener(name: string, fn: Handler) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
  applyDynamicConfig(c: { core?: Record<string, unknown> }) {
    this.dynamic.push(c.core ?? {});
  }
  destroy() {
    this.destroyed = true;
  }
}

export const SWARM_ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

export function playbackStart(over: { enabled?: boolean; available?: boolean; trackerUrls?: string[] } = {}) {
  const enabled = over.enabled ?? true;
  return {
    sessionId: "019a0000-0000-7000-8000-0000000000f1",
    token: "tok-1",
    playlistUrl: "https://play.example/hls/live/rivertide/index.m3u8?t=tok-1",
    source: "origin" as const,
    p2p: {
      enabled,
      available: over.available ?? true,
      trackerUrls: over.trackerUrls ?? (enabled ? ["wss://play.example/tracker?t=tok-1"] : []),
      swarmId: SWARM_ID,
      digestUrl: "https://play.example/p2p-digest",
    },
    heartbeatIntervalMs: 600_000,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    renditions: ["source" as const],
    captions: [],
  };
}

export interface FakeApi {
  api: Api;
  start: Mock<ApiFn>;
  heartbeat: Mock<ApiFn>;
  end: Mock<ApiFn>;
  iceServers: Mock<ApiFn>;
  calls: string[];
}

export function fakeApi(
  started: ReturnType<typeof playbackStart>,
  ice: () => Promise<unknown> = async () => ({ iceServers: [{ urls: ["stun:play.example:3478"] }], expiresAt: null }),
): FakeApi {
  const calls: string[] = [];
  const start = vi.fn<ApiFn>(async (_input: unknown) => {
    calls.push("start");
    return started;
  });
  const heartbeat = vi.fn<ApiFn>(async (_input: unknown) => {
    calls.push("heartbeat");
    return {};
  });
  const end = vi.fn<ApiFn>(async (_input: unknown) => {
    calls.push("end");
    return { ok: true };
  });
  const iceServers = vi.fn<ApiFn>(async (_input: unknown) => {
    calls.push("iceServers");
    return ice();
  });
  const api = { playback: { start, heartbeat, end }, p2p: { iceServers } } as unknown as Api;
  return { api, start, heartbeat, end, iceServers, calls };
}
