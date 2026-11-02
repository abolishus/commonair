// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-safety's live phase: every live role goes on air at once with its own run-unique benign
 * pattern (`benignPatternSource`, as `trust-safety`), the scripted classifier labels (T2) or
 * restricts (T1) the scored ones, the moderator decides two T1 cases while they are live, and the
 * roles that need clips cut them. Every publisher is stopped before this returns, whatever happens.
 *
 * SAFETY: no imagery but the ffmpeg `cellauto` pattern passes through here; the scores are the
 * scripted classifier's (`MODERATION_TEST_HOOKS`).
 */
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "../../env.ts";
import { benignPatternSource, findInPages } from "../../safety.ts";
import { FixturePublisher, type ModerationHooks } from "../../safety-io.ts";
import { rtmpPublishUrl } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import { sleep, waitFor } from "../../wait.ts";
import { type SafetySessions, step } from "./api.ts";
import { CLIP_LEAD_SECONDS, CLIP_SECONDS, type LiveRole, type LiveSpec, TEXT } from "./plan.ts";

const LIVE_TIMEOUT_MS = 60_000;
const CLASSIFY_TIMEOUT_MS = 90_000;
const CLIP_READY_TIMEOUT_MS = 240_000;

export interface LiveClip {
  id: string;
  url: string | null;
}

export interface LiveChannel {
  spec: LiveSpec;
  user: SignedInUser;
  slug: string;
  channelId: string;
  clips: LiveClip[];
  /** T1 roles: the case the classifier opened. */
  caseId: string | null;
}

export interface LiveResult {
  channels: Map<LiveRole, LiveChannel>;
  /** T1 decisions taken while live (role → decision). */
  decided: Partial<Record<LiveRole, "clear" | "warn">>;
}

export interface LiveDeps {
  env: HarnessEnv;
  sessions: SafetySessions;
  hooks: ModerationHooks;
  log: Logger;
  signal: AbortSignal;
}

const T1_DECISIONS: Partial<Record<LiveRole, "clear" | "warn">> = { t1Clear: "clear", t1Warn: "warn" };

export async function runLive(d: LiveDeps, specs: readonly LiveSpec[]): Promise<LiveResult> {
  const { sessions, hooks, signal } = d;
  const anon = sessions.anon().client;
  const channels = new Map<LiveRole, LiveChannel>();
  for (const spec of specs) {
    const user = await sessions.as(spec.handle);
    const slug = user.me.channelSlug ?? user.username;
    const c = await step(signal, spec.handle, "read its channel", () =>
      user.api.client.channels.get({ channel: slug }),
    );
    channels.set(spec.role, { spec, user, slug, channelId: c.id, clips: [], caseId: null });
  }
  const publishers: FixturePublisher[] = [];
  const decided: LiveResult["decided"] = {};
  try {
    for (const ch of channels.values()) {
      const { spec } = ch;
      await step(signal, "the test hooks", `script the classifier for ${spec.role}`, () =>
        hooks.setScores(ch.channelId, spec.sexualScore === null ? {} : { sexual: spec.sexualScore }),
      );
      const { key } = await step(signal, spec.handle, "rotate its stream key", () =>
        ch.user.api.client.stream.rotateKey({ channel: ch.slug }),
      );
      const pub = new FixturePublisher(
        `seed-safety-${spec.role}`,
        {
          url: rtmpPublishUrl(d.env.HARNESS_RTMP_URL, key),
          lavfi: benignPatternSource(spec.patternSeed),
          width: 640,
          height: 360,
          fps: 15,
          bitrateKbps: 600,
        },
        d.log,
      );
      publishers.push(pub);
      await step(signal, spec.handle, `go live (${spec.role})`, () => pub.start(30_000));
    }
    const liveAt = new Map<LiveRole, number>();
    await Promise.all(
      [...channels.values()].map(async (ch) => {
        await waitFor(
          `${ch.spec.role} live`,
          async () => (await anon.channels.get({ channel: ch.slug })).live !== null,
          {
            timeoutMs: LIVE_TIMEOUT_MS,
            intervalMs: 500,
            signal,
          },
        );
        liveAt.set(ch.spec.role, Date.now());
      }),
    );

    // The classifier acts within a couple of sample intervals; stop scripting so decisions stick.
    await Promise.all(
      [...channels.values()]
        .filter((ch) => ch.spec.sexualScore !== null)
        .map(async (ch) => {
          const t2 = ch.spec.role === "t2" || ch.spec.role === "t2Keep";
          await waitFor(
            `${ch.spec.role} ${t2 ? "labelled mature" : "restricted"} (scripted classifier; MODERATION_CLASSIFIER=scripted)`,
            async () => {
              const c = await anon.channels.get({ channel: ch.slug });
              return t2 ? c.mature : c.live?.restricted === "under_review";
            },
            { timeoutMs: CLASSIFY_TIMEOUT_MS, intervalMs: 500, signal },
          );
          await hooks.setScores(ch.channelId, {});
        }),
    );

    // T1 cases: the moderator decides two while the streams are still live; the third stays open.
    const mod = await sessions.as("mod");
    for (const ch of channels.values()) {
      if (!ch.spec.role.startsWith("t1")) continue;
      const kase = await waitFor(
        `${ch.spec.role}'s T1 case in the moderation queue`,
        () =>
          findInPages(
            (cursor) => mod.api.client.moderation.queue({ cursor, limit: 100, tier: "t1", status: "open" }),
            (c) => c.channel?.id === ch.channelId && c.origin === "classifier",
          ),
        { timeoutMs: CLASSIFY_TIMEOUT_MS, intervalMs: 1_000, signal },
      );
      ch.caseId = kase.id;
      const decision = T1_DECISIONS[ch.spec.role];
      if (decision) {
        await step(signal, "mod", `${decision} the ${ch.spec.role} case`, () =>
          mod.api.client.moderation.review({ id: kase.id, decision, note: TEXT.caseNote }),
        );
        decided[ch.spec.role] = decision;
      }
    }

    // Clips: the last seconds of each stream that needs them, once enough has been recorded.
    for (const ch of channels.values()) {
      if (ch.spec.clips === 0) continue;
      const wait = (liveAt.get(ch.spec.role) ?? Date.now()) + CLIP_LEAD_SECONDS * 1000 - Date.now();
      if (wait > 0) await sleep(wait, signal);
      for (let i = 0; i < ch.spec.clips; i++) {
        const clip = await step(signal, ch.spec.handle, `clip its stream (${ch.spec.role} ${i + 1})`, () =>
          ch.user.api.client.clips.create({
            channel: ch.slug,
            title: `Demo safety clip ${i + 1}`,
            durationSeconds: CLIP_SECONDS,
          }),
        );
        ch.clips.push({ id: clip.id, url: null });
      }
    }
    await Promise.all(
      [...channels.values()].flatMap((ch) =>
        ch.clips.map(async (clip) => {
          const ready = await waitFor(
            `clip ${clip.id} (${ch.spec.role}) ready`,
            async () => {
              const c = await ch.user.api.client.clips.get({ id: clip.id });
              if (c.status === "failed") throw new Error(`clip ${clip.id} failed`);
              return c.status === "ready" ? c : null;
            },
            { timeoutMs: CLIP_READY_TIMEOUT_MS, intervalMs: 2_000, signal },
          );
          clip.url = ready.url;
        }),
      ),
    );
  } finally {
    await Promise.allSettled(publishers.map((p) => p.stop(1_000)));
    // Never leave a script behind: a later stream on the channel would be classified again.
    await Promise.allSettled([...channels.values()].map((ch) => hooks.setScores(ch.channelId, {})));
  }
  return { channels, decided };
}
