// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulated viewbots, built to be caught. Each behaviour produces one signal the integrity system
 * is expected to detect:
 *
 * - datacenter addresses: requests arrive (via the forwarding proxy) from hosting-provider CIDRs
 * - headless fingerprints: webdriver flag, HeadlessChrome UA, no plugins or languages
 * - perfectly periodic heartbeats: zero jitter, every beat exactly on the interval
 * - playlists without segments: sessions that never download media yet claim playback
 * - many sessions per device: dozens of sessions sharing a handful of device ids
 * - follow bursts: freshly created accounts all following one channel within seconds
 * - chat spam: identical messages at a rate no person types
 *
 * `planViewbots` is pure so tests can check the signals without a stack.
 */
import type { Logger } from "@commonair/observability";
import type { Api } from "./api/client.ts";
import type { ChatClient } from "./chat-client.ts";
import type { AddressPool } from "./cidrs.ts";
import { BOT_TIMING, type Fingerprint, type HeartbeatTiming, headlessFingerprint, newDeviceId } from "./fingerprint.ts";
import { HttpViewer } from "./http-viewer.ts";
import type { SignUpOptions, SignedInUser } from "./users.ts";
import type { ViewerReport } from "./viewer.ts";

export const HEADLESS_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36";

export interface ViewbotSwarmOptions {
  channel: string;
  sessions: number;
  /** Distinct device ids shared by all sessions (fewer devices = stronger signal). */
  devices?: number;
  /** Addresses the swarm uses (one per device). */
  addresses?: number;
  playlistOnly?: boolean;
  periodicHeartbeats?: boolean;
  headless?: boolean;
}

export interface ViewbotPlan {
  index: number;
  deviceId: string;
  clientIp: string;
  fingerprint: Fingerprint;
  timing: HeartbeatTiming;
  fetchSegments: boolean;
  userAgent: string;
}

/** Deterministic description of every bot session in a swarm. */
export function planViewbots(opts: ViewbotSwarmOptions, datacenter: AddressPool): ViewbotPlan[] {
  if (opts.sessions < 1) return [];
  const devices = Array.from(
    { length: Math.max(1, Math.min(opts.devices ?? Math.ceil(opts.sessions / 10), opts.sessions)) },
    () => newDeviceId(),
  );
  const addresses = Array.from({ length: Math.max(1, opts.addresses ?? devices.length) }, () => datacenter.next());
  return Array.from({ length: opts.sessions }, (_, index) => ({
    index,
    deviceId: devices[index % devices.length] as string,
    clientIp: addresses[index % addresses.length] as string,
    fingerprint:
      opts.headless === false ? { ...headlessFingerprint(), webdriver: false, headless: false } : headlessFingerprint(),
    timing: opts.periodicHeartbeats === false ? { jitter: 0.15, lateProbability: 0 } : BOT_TIMING,
    fetchSegments: opts.playlistOnly === false,
    userAgent: HEADLESS_USER_AGENT,
  }));
}

export type ApiFactory = (opts: { clientIp: string; userAgent: string }) => Api;

/** A swarm of HTTP-level bot sessions on one channel. */
export class ViewbotSwarm {
  readonly plans: ViewbotPlan[];
  private viewers: HttpViewer[] = [];

  constructor(
    private readonly opts: ViewbotSwarmOptions,
    datacenter: AddressPool,
    private readonly apiFactory: ApiFactory,
    private readonly log?: Logger,
  ) {
    this.plans = planViewbots(opts, datacenter);
  }

  async start(): Promise<void> {
    for (const plan of this.plans) {
      const api = this.apiFactory({ clientIp: plan.clientIp, userAgent: plan.userAgent });
      const viewer = new HttpViewer({
        id: `viewbot-${plan.index}`,
        target: { channel: this.opts.channel },
        api: api.client,
        deviceId: plan.deviceId,
        fingerprint: plan.fingerprint,
        timing: plan.timing,
        fetchSegments: plan.fetchSegments,
        // Bots claim to have played the whole interval even though they downloaded nothing.
        claimPlayback: !plan.fetchSegments,
        headers: { "user-agent": plan.userAgent },
        log: this.log,
      });
      await viewer.start();
      this.viewers.push(viewer);
    }
  }

  async reports(): Promise<ViewerReport[]> {
    return Promise.all(this.viewers.map((v) => v.report()));
  }

  async stop(): Promise<ViewerReport[]> {
    const reports = await Promise.all(this.viewers.map((v) => v.stop()));
    this.viewers = [];
    return reports;
  }

  get sessionIds(): string[] {
    return this.viewers.flatMap((v) => (v.sessionId ? [v.sessionId] : []));
  }
}

export interface FollowBurstOptions {
  channel: string;
  accounts: number;
  /** Sign-up function (the platform's, with a datacenter address per account). */
  signUp: (opts: SignUpOptions) => Promise<SignedInUser>;
  addresses: AddressPool;
  /** Accounts signing up in parallel. */
  concurrency?: number;
}

/** Fresh accounts that all follow one channel within seconds of being created. */
export async function followBurst(
  opts: FollowBurstOptions,
): Promise<{ users: SignedInUser[]; followedWithinMs: number }> {
  const users: SignedInUser[] = [];
  const queue = Array.from({ length: opts.accounts }, (_, i) => i);
  const worker = async () => {
    while (queue.shift() !== undefined) {
      users.push(await opts.signUp({ prefix: "fresh", clientIp: opts.addresses.next() }));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  const started = Date.now();
  await Promise.all(users.map((u) => u.api.client.channels.follow({ channel: opts.channel, notify: false })));
  return { users, followedWithinMs: Date.now() - started };
}

export interface ChatSpamOptions {
  clients: ChatClient[];
  channel: string;
  message?: string;
  /** Messages per second per client (people manage well under 1). */
  ratePerSecond?: number;
  durationMs: number;
  signal?: AbortSignal;
}

/** Identical messages at machine rate from every client. Returns how many were sent. */
export async function chatSpam(opts: ChatSpamOptions): Promise<number> {
  const interval = 1000 / Math.max(0.1, opts.ratePerSecond ?? 5);
  const deadline = Date.now() + opts.durationMs;
  let sent = 0;
  const body = opts.message ?? "BUY FOLLOWERS cheap viewers here";
  while (Date.now() < deadline && !opts.signal?.aborted) {
    for (const c of opts.clients) {
      if (!c.isOpen) continue;
      c.sendNoWait(opts.channel, body);
      sent++;
    }
    await Bun.sleep(interval);
  }
  return sent;
}
