// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E6, VOD and clip management (docs/testing/e6-selectors.md, "Scenario `vod-clips`"):
 * 1 S streams 40 s with VODs on, the VOD becomes ready, V clips 10 s of it (and S clips too, so
 * "every clip of the broadcast" has more than one); 2 S renames it and makes it private on
 * `/content`, after which V can neither see nor change it (`NOT_FOUND`, no existence leak); 3 S
 * deletes V's clip, and `vod-retention` (ops tick) deletes its objects; 4 S deletes the VOD, its
 * clips go with it, and `vod-retention` leaves nothing under `vods/<id>/`; 5 a VOD of a held
 * channel owner is hidden but its objects survive the tick (`held` ≥ 1).
 *
 * `--set via=api` drives `/content` through `vods.*` and `clips.*`. Object checks read the media
 * bucket with the repo `.env` credentials (`S3_*`).
 */
import { setTimeout as delay } from "node:timers/promises";
import type { ApiClient } from "../src/api/client.ts";
import { clipRow, vodRow } from "../src/e6/db.ts";
import { type Kit, UI_TIMEOUT_MS, setupKit, staffAccount } from "../src/e6/kit.ts";
import { sumCounter } from "../src/e6/ops.ts";
import { E6_ROUTES, E6_TEST_IDS as E, byE6Id } from "../src/e6/selectors.ts";
import { chooseOption, confirmDialog } from "../src/e6/web.ts";
import { listMediaKeys, mediaBucketConfig, mediaKeyExists } from "../src/safety-io.ts";
import { apiError, errorOf, isNotFound } from "../src/safety.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import type { SignedInUser } from "../src/users.ts";
import { waitFor } from "../src/wait.ts";

const STREAM_SECONDS = 40;
const HELD_STREAM_SECONDS = 20;
const VOD_READY_TIMEOUT_MS = 5 * 60_000;
const CLIP_READY_TIMEOUT_MS = 3 * 60_000;
const RETENTION_TIMEOUT_MS = 2 * 60_000;

type Vod = Awaited<ReturnType<ApiClient["vods"]["get"]>>;

export default defineScenario({
  name: "vod-clips",
  description:
    "40 s VOD ready, V clips it → S renames it and makes it private on /content (V: NOT_FOUND) → S deletes V's clip, retention deletes its objects → S deletes the VOD and its clips, retention empties vods/<id>/ → a held owner's deleted VOD keeps its objects",
  needs: ["api", "web", "media", "worker", "ffmpeg", "browser"],
  timeoutMs: 25 * 60_000,
  async run(ctx) {
    const kit = await setupKit(ctx);
    await vodClips(ctx, kit);
    kit.done();
  },
});

async function streamVod(ctx: ScenarioContext, who: string, user: SignedInUser, seconds: number): Promise<Vod> {
  const p = ctx.platform;
  const channel = user.me.channelSlug ?? user.username;
  await user.api.client.channels.update({ channel, vodEnabled: true });
  const streamer = await p.streamerFor(user, { protocol: "rtmp" });
  ctx.defer(() => streamer.stop());
  await ctx.step(`${who} streams ${seconds} s with VODs on`, async () => {
    await streamer.start();
    await p.waitForLive(channel, true, 30_000);
    await delay(seconds * 1000, undefined, { signal: ctx.signal });
    await streamer.stop();
    await p.waitForLive(channel, false, 60_000);
  });
  return ctx.step(`${who}'s VOD becomes ready`, () =>
    waitFor(
      `${who}'s VOD ready`,
      async () => {
        const page = await user.api.client.vods.list({ channel, limit: 10 });
        const vod = page.items[0];
        if (vod?.status === "failed") throw new Error(`VOD failed (${vod.failedReason ?? "no reason"})`);
        return vod?.status === "ready" ? vod : null;
      },
      { timeoutMs: VOD_READY_TIMEOUT_MS, intervalMs: 3_000, signal: ctx.signal },
    ),
  );
}

async function waitClipReady(ctx: ScenarioContext, api: ApiClient, clipId: string) {
  return waitFor(
    `clip ${clipId} ready`,
    async () => {
      const c = await api.clips.get({ id: clipId });
      if (c.status === "failed") throw new Error(`clip ${clipId} failed`);
      return c.status === "ready" ? c : null;
    },
    { timeoutMs: CLIP_READY_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
  );
}

async function vodClips(ctx: ScenarioContext, kit: Kit): Promise<void> {
  const p = ctx.platform;
  const bucket = mediaBucketConfig(ctx.env);
  ctx.assert("S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are set (object checks)", bucket !== null);
  if (bucket === null) return;

  const [s, v, s2] = await ctx.step("sign up streamers S, S2 and viewer V (API)", () =>
    Promise.all([p.signUp({ prefix: "e6vc_s" }), p.signUp({ prefix: "e6vc_v" }), p.signUp({ prefix: "e6vc_s2" })]),
  );
  const channel = s.me.channelSlug ?? s.username;
  ctx.data("users", { s: s.username, v: v.username, s2: s2.username });

  // ------------------------------------------------------------ 1. VOD and clips
  const vod = await streamVod(ctx, "S", s, STREAM_SECONDS);
  ctx.data("vodId", vod.id);
  const [vClip, sClip] = await ctx.step("1 V clips 10 s of the VOD (and S clips another 10 s)", () =>
    Promise.all([
      v.api.client.clips.create({
        channel,
        title: "harness V clip",
        vodId: vod.id,
        startOffset: 5,
        durationSeconds: 10,
      }),
      s.api.client.clips.create({
        channel,
        title: "harness S clip",
        vodId: vod.id,
        startOffset: 20,
        durationSeconds: 10,
      }),
    ]),
  );
  await ctx.step("1 both clips are ready", () =>
    Promise.all([waitClipReady(ctx, s.api.client, vClip.id), waitClipReady(ctx, s.api.client, sClip.id)]),
  );

  // ------------------------------------------------------------ 2. rename, private
  const title = `harness renamed ${ctx.runId}`.slice(0, 140);
  const studio = kit.via === "web" ? await kit.webSession("S", s) : null;
  await ctx.step("2 S renames the VOD and makes it private", async () => {
    if (studio) {
      const page = await studio.goto(E6_ROUTES.content);
      const row = byE6Id(page, E.vodRow, { "vod-id": vod.id });
      await row.waitFor({ timeout: UI_TIMEOUT_MS });
      await byE6Id(row, E.vodTitle).fill(title, { timeout: UI_TIMEOUT_MS });
      await chooseOption(page, row, E.vodVisibility, "private", UI_TIMEOUT_MS);
      await byE6Id(row, E.vodSave).click({ timeout: UI_TIMEOUT_MS });
      await byE6Id(page, E.vodRow, { "vod-id": vod.id, visibility: "private" }).waitFor({ timeout: UI_TIMEOUT_MS });
    } else {
      await s.api.client.vods.update({ id: vod.id, title, visibility: "private" });
    }
  });
  const sees = await ctx.step("2 S still sees the VOD, renamed and private", () =>
    waitFor(
      "the VOD renamed and private",
      async () => {
        const got = await s.api.client.vods.get({ id: vod.id });
        return got.visibility === "private" && got.title === title ? got : null;
      },
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
    ),
  );
  ctx.assert("2 S's vods.get shows the new title and private", sees.title === title && sees.visibility === "private");
  const vList = await v.api.client.vods.list({ channel, limit: 50 });
  ctx.assert("2 V's VOD list no longer has it", !vList.items.some((x) => x.id === vod.id));
  const sList = await s.api.client.vods.list({ channel, limit: 50 });
  ctx.assert(
    "2 S's VOD list still has it",
    sList.items.some((x) => x.id === vod.id),
  );
  const vGet = await errorOf(() => v.api.client.vods.get({ id: vod.id }));
  const vUpdate = await errorOf(() => v.api.client.vods.update({ id: vod.id, title: "not yours" }));
  const vRemove = await errorOf(() => v.api.client.vods.remove({ id: vod.id }));
  const codes = { get: apiError(vGet).code, update: apiError(vUpdate).code, remove: apiError(vRemove).code };
  ctx.assert(
    "2 V's vods.get, vods.update and vods.remove are NOT_FOUND",
    [vGet, vUpdate, vRemove].every(isNotFound),
    codes,
  );
  const anonGet = await errorOf(() => kit.anon().vods.get({ id: vod.id }));
  ctx.assert("2 an anonymous vods.get is NOT_FOUND", isNotFound(anonGet), { code: apiError(anonGet).code });

  // ------------------------------------------------------------ 3. S deletes V's clip
  const vClipKeys = await clipRow(kit.databaseUrl, vClip.id);
  ctx.assert("3 V's clip has a storage key (DB)", vClipKeys.storage !== null);
  await ctx.step("3 S deletes V's clip", async () => {
    if (studio) {
      const page = await studio.goto(E6_ROUTES.content);
      await byE6Id(page, E.contentTabClips).click({ timeout: UI_TIMEOUT_MS });
      const row = byE6Id(page, E.clipRow, { "clip-id": vClip.id });
      await byE6Id(row, E.clipDelete).click({ timeout: UI_TIMEOUT_MS });
      await confirmDialog(page, UI_TIMEOUT_MS);
      await row.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
    } else {
      await s.api.client.clips.remove({ id: vClip.id });
    }
  });
  const sClips = await s.api.client.clips.list({ channel, limit: 50 });
  const anonClips = await kit.anon().clips.list({ channel, limit: 50 });
  ctx.assert(
    "3 the clip is gone from the lists",
    !sClips.items.some((c) => c.id === vClip.id) && !anonClips.items.some((c) => c.id === vClip.id),
  );
  const clipGet = await errorOf(() => kit.anon().clips.get({ id: vClip.id }));
  ctx.assert("3 clips.get is NOT_FOUND", isNotFound(clipGet), { code: apiError(clipGet).code });
  const clipGone = await ctx.step("3 ops tick vod-retention deletes the clip", () =>
    kit.ops.tickUntil(
      "vod-retention",
      "V's clip status deleted",
      async () => {
        const r = await clipRow(kit.databaseUrl, vClip.id);
        return r.status === "deleted" ? r : null;
      },
      { timeoutMs: RETENTION_TIMEOUT_MS },
    ),
  );
  ctx.assert("3 the clip's removed_reason is owner", clipGone.value.removedReason === "owner", {
    removedReason: clipGone.value.removedReason,
  });
  const clipObjects = [vClipKeys.storage, vClipKeys.thumbnailKey].filter((k): k is string => k !== null);
  const clipLeft = await Promise.all(clipObjects.map((k) => mediaKeyExists(bucket, k)));
  ctx.assert(
    "3 the clip's objects are gone (S3 HEAD 404)",
    clipLeft.every((x) => !x),
    { left: clipLeft.filter(Boolean).length },
  );

  // ------------------------------------------------------------ 4. S deletes the VOD
  const vodKeys = await vodRow(kit.databaseUrl, vod.id);
  const prefix = vodKeys.storage ?? `vods/${vod.id}/`;
  ctx.assert("4 the VOD's prefix is vods/<id>/", prefix === `vods/${vod.id}/`);
  const before = await listMediaKeys(bucket, prefix, 5);
  ctx.assert("4 the VOD has objects before deletion", before.length > 0, { objects: before.length });
  const sClipKeys = await clipRow(kit.databaseUrl, sClip.id);
  await ctx.step("4 S deletes the VOD", async () => {
    if (studio) {
      const page = await studio.goto(E6_ROUTES.content);
      const row = byE6Id(page, E.vodRow, { "vod-id": vod.id });
      await byE6Id(row, E.vodDelete).click({ timeout: UI_TIMEOUT_MS });
      await confirmDialog(page, UI_TIMEOUT_MS);
      await row.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
    } else {
      await s.api.client.vods.remove({ id: vod.id });
    }
  });
  const sGet = await errorOf(() => s.api.client.vods.get({ id: vod.id }));
  ctx.assert("4 the VOD is gone at once (vods.get NOT_FOUND for the owner)", isNotFound(sGet), {
    code: apiError(sGet).code,
  });
  const afterList = await s.api.client.vods.list({ channel, limit: 50 });
  ctx.assert("4 the VOD is gone from the owner's list", !afterList.items.some((x) => x.id === vod.id));
  const sClipGet = await errorOf(() => s.api.client.clips.get({ id: sClip.id }));
  const clipsLeft = await s.api.client.clips.list({ channel, limit: 50 });
  ctx.assert(
    "4 every clip of the broadcast went with it",
    isNotFound(sClipGet) && !clipsLeft.items.some((c) => c.id === sClip.id),
    { code: apiError(sClipGet).code },
  );
  const vodGone = await ctx.step("4 ops tick vod-retention deletes the VOD", () =>
    kit.ops.tickUntil(
      "vod-retention",
      "the VOD and its clip deleted",
      async () => {
        const [r, c] = await Promise.all([vodRow(kit.databaseUrl, vod.id), clipRow(kit.databaseUrl, sClip.id)]);
        return r.status === "deleted" && c.status === "deleted" ? { vod: r, clip: c } : null;
      },
      { timeoutMs: RETENTION_TIMEOUT_MS },
    ),
  );
  ctx.assert("4 the VOD's removed_reason is owner", vodGone.value.vod.removedReason === "owner", {
    removedReason: vodGone.value.vod.removedReason,
  });
  ctx.assert("4 its clip's removed_reason is owner", vodGone.value.clip.removedReason === "owner", {
    removedReason: vodGone.value.clip.removedReason,
  });
  const vodLeft = await listMediaKeys(bucket, prefix, 5);
  ctx.assert("4 no object is left under vods/<id>/", vodLeft.length === 0, { left: vodLeft.length });
  const sClipObjects = [sClipKeys.storage, sClipKeys.thumbnailKey].filter((k): k is string => k !== null);
  const sClipLeft = await Promise.all(sClipObjects.map((k) => mediaKeyExists(bucket, k)));
  ctx.assert(
    "4 the broadcast's clip objects are gone",
    sClipLeft.every((x) => !x),
    {
      left: sClipLeft.filter(Boolean).length,
    },
  );

  // ------------------------------------------------------------ 5. held
  await heldVod(ctx, kit, s2, bucket);
}

async function heldVod(
  ctx: ScenarioContext,
  kit: Kit,
  s2: SignedInUser,
  bucket: NonNullable<ReturnType<typeof mediaBucketConfig>>,
): Promise<void> {
  const legal = await staffAccount(kit, "e6vc_l", "legal");
  await ctx.step("5 legal places a hold on S2 (admin.legalHold)", () =>
    legal.api.client.admin.legalHold({
      username: s2.username,
      hold: true,
      reasonCode: "litigation",
      reason: "harness vod-clips scenario",
    }),
  );
  const vod = await streamVod(ctx, "S2", s2, HELD_STREAM_SECONDS);
  ctx.data("heldVodId", vod.id);
  const prefix = `vods/${vod.id}/`;
  await ctx.step("5 S2 deletes the VOD", () => s2.api.client.vods.remove({ id: vod.id }));
  const hidden = await errorOf(() => s2.api.client.vods.get({ id: vod.id }));
  ctx.assert("5 the held VOD is hidden (NOT_FOUND)", isNotFound(hidden), { code: apiError(hidden).code });
  // Only ticks that ran after the removal count (and only non-skipped ones carry counts).
  const from = kit.ops.ticks.length;
  const heldSince = () =>
    sumCounter(
      kit.ops.ticks.slice(from).flatMap((t) => (t.result ? [t.result] : [])),
      "held",
    );
  const { results } = await ctx.step("5 ops tick vod-retention counts it held", () =>
    kit.ops.tickUntil("vod-retention", "a held VOD", async () => (heldSince() >= 1 ? true : null), {
      timeoutMs: RETENTION_TIMEOUT_MS,
    }),
  );
  ctx.data("heldRetention", results);
  ctx.assert("5 the retention result counts held ≥ 1", sumCounter(results, "held") >= 1, {
    held: sumCounter(results, "held"),
  });
  const left = await listMediaKeys(bucket, prefix, 5);
  ctx.assert("5 the held VOD's objects still exist", left.length > 0, { objects: left.length });
  const row = await vodRow(kit.databaseUrl, vod.id);
  ctx.assert("5 the held VOD is not marked deleted", row.status !== "deleted", { status: row.status });
}
