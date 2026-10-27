// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `trust-safety` scenario's run state and shared helpers (moved out of
 * `scenarios/trust-safety.ts` so the E7 step modules in `src/e7/` can use them). Owned by the
 * orchestrator: units send a contract request instead of editing it.
 */
import type { ApiClient } from "./api/client.ts";
import type { Via } from "./money.ts";
import { type LogNeedle, type SafetyStep, SAFETY_STEPS, benignPatternSource, runSeed } from "./safety.ts";
import { FixturePublisher, type ModerationHooks } from "./safety-io.ts";
import type { ScenarioContext } from "./scenario.ts";
import { rtmpPublishUrl } from "./streamer.ts";
import type { SignedInUser } from "./users.ts";
import { waitFor } from "./wait.ts";
import type { WebSession } from "./web/session.ts";

export const UI_TIMEOUT_MS = 20_000;
export const API_SETTLE_MS = 30_000;
/** The deletion reason and notes staff type; free text that is not personal data. */
export const NOTE = "harness trust-safety scenario";

export interface Staff {
  l1: SignedInUser;
  l2: SignedInUser;
  mod: SignedInUser;
  admin: SignedInUser;
}

export interface Streamer {
  user: SignedInUser;
  channel: string;
  channelId: string;
}

export interface Run {
  ctx: ScenarioContext;
  via: Via;
  sampleSeconds: number;
  deadlineMs: number;
  databaseUrl: string;
  hooks: ModerationHooks;
  staff: Staff;
  /** Emails of every account and requester this run created (log needles; never reported). */
  emails: string[];
  needles: LogNeedle[];
  sessions: WebSession[];
  probe: string;
  webSession(label: string, user?: SignedInUser): Promise<WebSession>;
  anon(): ApiClient;
  check: ScenarioContext["check"];
}

export function title(n: SafetyStep, what: string): string {
  return `${n}. ${SAFETY_STEPS[n]}: ${what}`;
}

export async function newStreamer(run: Run, prefix: string): Promise<Streamer> {
  const user = await run.ctx.platform.signUp({ prefix });
  run.emails.push(user.email);
  const channel = user.me.channelSlug ?? user.username;
  const c = await user.api.client.channels.get({ channel });
  return { user, channel, channelId: c.id };
}

/** A publisher on the streamer's freshly rotated key, stopped when the scenario ends. */
export async function publisher(
  run: Run,
  s: Streamer,
  source: { image: string } | { lavfi: string },
): Promise<{ pub: FixturePublisher; url: string }> {
  const { key } = await s.user.api.client.stream.rotateKey({ channel: s.channel });
  const url = rtmpPublishUrl(run.ctx.env.HARNESS_RTMP_URL, key);
  const pub = new FixturePublisher(`publisher-${s.channel}`, { url, ...source }, run.ctx.log);
  run.ctx.defer(() => pub.stop(1_000));
  return { pub, url };
}

export function benign(run: Run, salt: number): { lavfi: string } {
  return { lavfi: benignPatternSource((runSeed(run.ctx.runId) + salt) & 0x7fffffff) };
}

export async function waitLive(run: Run, channel: string): Promise<number> {
  await waitFor(`${channel} live`, async () => (await run.anon().channels.get({ channel })).live !== null, {
    timeoutMs: API_SETTLE_MS,
    intervalMs: 250,
    signal: run.ctx.signal,
  });
  return Date.now();
}

export async function waitClip(run: Run, s: Streamer, clipId: string) {
  return waitFor(
    `clip ${clipId} ready`,
    async () => {
      const c = await s.user.api.client.clips.get({ id: clipId });
      if (c.status === "failed") throw new Error(`clip ${clipId} failed`);
      return c.status === "ready" && c.url ? c : null;
    },
    { timeoutMs: 180_000, intervalMs: 2_000, signal: run.ctx.signal },
  );
}
