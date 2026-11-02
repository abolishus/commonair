// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `federation` steps 1–9 (docs/testing/b7-selectors.md, "Scenarios"; ADR 0030) and their run
 * state, against the in-harness ActivityPub peer (`src/mocks/activitypub/`). With `via=web` the
 * steps that have a studio or admin page use `src/n4/web.ts` (N4-web); `via=api` calls the API.
 *
 * - The peer listens on this machine; the stack's containers reach it through
 *   `HARNESS_WEBHOOK_HOST` (the e9 receiver's way) and `harness/compose.n4.yaml` lets the worker
 *   reach a private http address. The peer reaches the instance's actor URLs at the API's own
 *   port (`rewriteToApi`).
 * - Steps 1–7 and 9 share one streamer whose channel federates; step 8 suspends a channel of its
 *   own, so a later step still has a channel to follow. Step 7's admin and blocked peer are its
 *   own. Steps that need the follow (4, 5, 8's own, 9) follow again when an earlier step undid it.
 * - Timing assertions allow for a loaded CI runner: deliveries go through the outbox relay and a
 *   queue, so each waits up to `DELIVERY_TIMEOUT_MS`; "nothing delivered" watches a quiet window.
 * - No token, key or remote handle is logged; the report carries ids and outcomes.
 */
import { startActivityPubPeer, type ActivityPubPeer } from "../mocks/activitypub/peer.ts";
import { grantRole } from "../money-db.ts";
import type { Via } from "../money.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { Streamer } from "../streamer.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import type { FederationStep } from "../w3/steps.ts";
import { federationTitle } from "../w3/steps.ts";
import {
  acctOf,
  anyCreateFrom,
  arrivedSince,
  isAcceptOf,
  isActorDelete,
  isCreate,
  rewriteToApi,
  webfingerEndpoint,
} from "./match.ts";
import * as federationWeb from "./web.ts";

/** Delivery runs outbox relay → fan-out job → deliver job; generous for a loaded runner. */
export const DELIVERY_TIMEOUT_MS = 90_000;
/** A VOD is ready some time after the broadcast ends (finalize, thumbnail). */
export const VOD_TIMEOUT_MS = 240_000;
const LIVE_TIMEOUT_MS = 60_000;
/** How long "nothing is delivered" watches after the trigger. */
export const QUIET_WINDOW_MS = 20_000;
const ROLE_CLI_TIMEOUT_MS = 60_000;
/** The blocked peer's host name: it never needs to resolve (the API refuses it before any fetch). */
export const BLOCKED_PEER_HOST = "fed-blocked.test";

export interface FederatedChannel {
  owner: SignedInUser;
  slug: string;
  channelId: string;
  actorId: string;
  handle: string;
  /** The actor's inbox as the peer reaches it. */
  inbox: string;
  encoder: Streamer | null;
}

export interface FederationRun {
  ctx: ScenarioContext;
  via: Via;
  /** N4-web's studio and admin steps, for `via=web`. */
  web: typeof federationWeb;
  /** Where this machine reaches the API. */
  apiUrl: string;
  /** The peer (started on first use, closed at the end). */
  peer(): Promise<ActivityPubPeer>;
  /** The shared channel, federated by step 1 (or on first use when step 1 is not selected). */
  channel(): Promise<FederatedChannel>;
  /** The current Follow of the shared channel, or null after an Undo or a removal. */
  follow: Record<string, unknown> | null;
  /** Origin of the instance's actor ids (learned from the first actor id). */
  instanceOrigin: string | null;
}

/** Set up what the selected steps share. Every actor is signed up on first use. */
export async function newFederationRun(ctx: ScenarioContext, opts: { via: Via }): Promise<FederationRun> {
  let peerP: Promise<ActivityPubPeer> | null = null;
  let channelP: Promise<FederatedChannel> | null = null;
  const run: FederationRun = {
    ctx,
    via: opts.via,
    web: federationWeb,
    apiUrl: ctx.env.HARNESS_API_URL.replace(/\/+$/, ""),
    follow: null,
    instanceOrigin: null,
    peer: () =>
      (peerP ??= startActivityPubPeer({
        host: ctx.env.HARNESS_WEBHOOK_HOST,
        rewrite: (u) => rewriteToApi(u, run.instanceOrigin, run.apiUrl),
      }).then((p) => {
        ctx.defer(() => p.close());
        ctx.data("federationPeer", { origin: p.origin });
        return p;
      })),
    channel: () => (channelP ??= federatedChannel(run, "fed", opts.via)),
  };
  return run;
}

/** Sign up a streamer and turn federation on (via web or the API); VODs on for step 5. */
async function federatedChannel(run: FederationRun, prefix: string, via: Via): Promise<FederatedChannel> {
  const { ctx } = run;
  const owner = await ctx.platform.signUp({ prefix });
  const slug = owner.me.channelSlug ?? owner.username;
  await owner.api.client.channels.update({ channel: slug, vodEnabled: true });
  if (via === "web") await run.web.enableFederationViaWeb(ctx, owner);
  else await owner.api.client.federation.settings.update({ channel: slug, enabled: true });
  const settings = await owner.api.client.federation.settings.get({ channel: slug });
  ctx.assert("federation is on for the channel (instance and channel)", settings.enabled && settings.instanceEnabled, {
    enabled: settings.enabled,
    instanceEnabled: settings.instanceEnabled,
  });
  if (!settings.actorId || !settings.handle) throw new Error("federation settings carry no actor id or handle");
  if (via === "web") {
    const shown = await run.web.readHandleViaWeb(ctx, owner);
    ctx.check("the studio shows the handle the API reports", shown === settings.handle);
  }
  run.instanceOrigin ??= new URL(settings.actorId).origin;
  const channelId = settings.actorId.split("/").pop() ?? "";
  return {
    owner,
    slug,
    channelId,
    actorId: settings.actorId,
    handle: settings.handle,
    inbox: rewriteToApi(`${settings.actorId}/inbox`, run.instanceOrigin, run.apiUrl),
    encoder: null,
  };
}

async function goLive(run: FederationRun, ch: FederatedChannel): Promise<void> {
  const p = run.ctx.platform;
  if (!ch.encoder) {
    ch.encoder = await p.streamerFor(ch.owner, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
    const enc = ch.encoder;
    run.ctx.defer(() => enc.stop());
  }
  if (!ch.encoder.running) await ch.encoder.start();
  await p.waitForLive(ch.slug, true, LIVE_TIMEOUT_MS);
}

async function goOffline(run: FederationRun, ch: FederatedChannel): Promise<void> {
  if (ch.encoder?.running) await ch.encoder.stop();
  await run.ctx.platform.waitForLive(ch.slug, false, LIVE_TIMEOUT_MS);
}

/** Follow `ch` from the peer and wait for the signed Accept. */
async function followAndAccept(run: FederationRun, ch: FederatedChannel): Promise<Record<string, unknown>> {
  const peer = await run.peer();
  const { activity, response } = await peer.follow(ch.actorId, ch.inbox);
  run.ctx.assert("the instance inbox accepts the Follow (202)", response.status === 202, { status: response.status });
  const followId = String(activity.id);
  await peer.waitFor((r) => isAcceptOf(r, ch.actorId, followId), DELIVERY_TIMEOUT_MS);
  return activity;
}

async function ensureFollowing(run: FederationRun, ch: FederatedChannel): Promise<void> {
  if (!run.follow) run.follow = await followAndAccept(run, ch);
}

async function followerIds(ch: FederatedChannel): Promise<{ id: string; actor: string }[]> {
  const page = await ch.owner.api.client.federation.followers.list({ channel: ch.slug, limit: 100 });
  return page.items.map((f) => ({ id: f.id, actor: f.actor }));
}

// ------------------------------------------------------------ steps

async function step1(run: FederationRun): Promise<void> {
  const ch = await run.ctx.step(federationTitle(1, `turn it on (${run.via})`), () => run.channel());
  run.ctx.data("federationChannel", { channelId: ch.channelId });
}

async function step2(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const ch = await run.channel();
  const peer = await run.peer();
  const wf = await ctx.step(federationTitle(2, "the peer resolves the handle through WebFinger"), () =>
    peer.webfinger(webfingerEndpoint(run.apiUrl), ch.handle),
  );
  ctx.assert("2. WebFinger's self link is the actor id", wf.actorId === ch.actorId);
  ctx.check("2. the subject is the acct: handle", wf.subject === `acct:${acctOf(ch.handle)}`, { subject: wf.subject });
  const a = wf.actor;
  const key = a.publicKey as { id?: unknown; owner?: unknown; publicKeyPem?: unknown } | undefined;
  ctx.assert("2. the actor is a Service with a public key it owns", a.type === "Service" && key?.owner === ch.actorId);
  ctx.check("2. the key id is <actor>#main-key", key?.id === `${ch.actorId}#main-key`);
  ctx.check(
    "2. the key is a PEM",
    typeof key?.publicKeyPem === "string" && key.publicKeyPem.includes("BEGIN PUBLIC KEY"),
  );
  ctx.check("2. preferredUsername is the slug", a.preferredUsername === ch.slug);
  ctx.check(
    "2. the actor names an inbox and a shared inbox",
    typeof a.inbox === "string" &&
      typeof (a.endpoints as { sharedInbox?: unknown } | undefined)?.sharedInbox === "string",
  );
}

async function step3(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const ch = await run.channel();
  const peer = await run.peer();
  run.follow = await ctx.step(federationTitle(3, "the peer follows and gets a signed Accept"), () =>
    followAndAccept(run, ch),
  );
  if (run.via === "web")
    await ctx.step(federationTitle(3, "the studio lists the follower"), () =>
      run.web.waitForFollowerViaWeb(ctx, ch.owner, peer.actorId),
    );
  else
    await ctx.step(federationTitle(3, "followers.list has the peer"), () =>
      waitFor(
        "the peer listed as a follower",
        async () => (await followerIds(ch)).some((f) => f.actor === peer.actorId),
        {
          timeoutMs: DELIVERY_TIMEOUT_MS,
          signal: ctx.signal,
        },
      ),
    );
}

async function step4(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const ch = await run.channel();
  const peer = await run.peer();
  await ensureFollowing(run, ch);
  const fresh = arrivedSince(peer.received);
  await ctx.step(federationTitle(4, "go live"), () => goLive(run, ch));
  const note = await ctx.step(federationTitle(4, "the peer receives a signed Create{Note} that verifies"), () =>
    peer.waitFor(
      fresh((r) => isCreate(r, ch.actorId, "Note")),
      DELIVERY_TIMEOUT_MS,
    ),
  );
  const o = note.json?.object as Record<string, unknown>;
  ctx.check("4. the Note links the channel page", typeof o.url === "string" && o.url.endsWith(`/${ch.slug}`));
  ctx.check("4. the Note is addressed to Public and the followers", JSON.stringify(note.json?.to).includes("#Public"));
}

async function step5(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const ch = await run.channel();
  const peer = await run.peer();
  await ensureFollowing(run, ch);
  // Marked before the broadcast ends: the VOD's Create{Video} can arrive while `goOffline` still
  // waits for the channel to read offline (CI: VOD ready 0.4 s after the session stopped).
  const fresh = arrivedSince(peer.received);
  if (!ch.encoder?.running) await ctx.step(federationTitle(5, "go live to record a VOD"), () => goLive(run, ch));
  await ctx.step(federationTitle(5, "record 20 s, then end the broadcast"), async () => {
    await Bun.sleep(20_000);
    await goOffline(run, ch);
  });
  const video = await ctx.step(federationTitle(5, "the peer receives a signed Create{Video}"), () =>
    peer.waitFor(
      fresh((r) => isCreate(r, ch.actorId, "Video")),
      VOD_TIMEOUT_MS,
    ),
  );
  const o = video.json?.object as Record<string, unknown>;
  const text = JSON.stringify(o);
  ctx.check("5. the Video links the watch page", text.includes(`/${ch.slug}/vods/`));
  ctx.assert("5. no media URL in the Video", !text.includes(".m3u8") && !text.includes(".m4s"));
}

async function step6(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const ch = await run.channel();
  const peer = await run.peer();
  await ensureFollowing(run, ch);
  const follow = run.follow;
  if (!follow) throw new Error("step 6 has no follow to undo");
  await ctx.step(federationTitle(6, "the peer sends Undo{Follow}"), async () => {
    const res = await peer.undoFollow(follow, ch.inbox);
    ctx.assert("6. the inbox accepts the Undo (202)", res.status === 202, { status: res.status });
    run.follow = null;
  });
  await ctx.step(federationTitle(6, "the follower is gone"), () =>
    waitFor(
      "the peer no longer a follower",
      async () => !(await followerIds(ch)).some((f) => f.actor === peer.actorId),
      {
        timeoutMs: DELIVERY_TIMEOUT_MS,
        signal: ctx.signal,
      },
    ),
  );
  if (ch.encoder?.running) await goOffline(run, ch);
  const from = peer.received.length;
  await ctx.step(federationTitle(6, "go live again"), () => goLive(run, ch));
  await Bun.sleep(QUIET_WINDOW_MS);
  const late = peer.since(from, (r) => anyCreateFrom(r, ch.actorId));
  ctx.assert("6. nothing is delivered after the Undo", late.length === 0, { creates: late.length });
  await goOffline(run, ch);
}

async function step7(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const ch = await run.channel();
  const databaseUrl = ctx.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set (the admin role grant)");
  const signedUp = await ctx.platform.signUp({ prefix: "fedadm" });
  await ctx.step(federationTitle(7, "grant the admin role (operator CLI)"), () =>
    grantRole(databaseUrl, signedUp.username, "admin", ROLE_CLI_TIMEOUT_MS),
  );
  const admin = await ctx.platform.users.signIn(signedUp);
  await ctx.step(federationTitle(7, `the admin blocks ${BLOCKED_PEER_HOST} (${run.via})`), async () => {
    if (run.via === "web") await run.web.addDomainBlockViaWeb(ctx, admin, BLOCKED_PEER_HOST);
    else await admin.api.client.federation.admin.blocks.add({ domain: BLOCKED_PEER_HOST });
  });
  ctx.defer(() =>
    admin.api.client.federation.admin.blocks.remove({ domain: BLOCKED_PEER_HOST }).catch(() => undefined),
  );
  const blocked = await startActivityPubPeer({ host: BLOCKED_PEER_HOST, username: "spam" });
  ctx.defer(() => blocked.close());
  const { response } = await ctx.step(federationTitle(7, "the blocked domain's Follow"), () =>
    blocked.follow(ch.actorId, ch.inbox),
  );
  ctx.assert("7. the inbox refuses it (4xx)", response.status >= 400 && response.status < 500, {
    status: response.status,
  });
  await Bun.sleep(2_000);
  const listed = (await followerIds(ch)).some((f) => f.actor === blocked.actorId);
  ctx.assert("7. the blocked actor is not a follower", !listed);
}

async function step8(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const databaseUrl = ctx.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set (the admin role grant)");
  // A channel of its own: the suspension is permanent for its remote followers.
  const ch = await ctx.step(federationTitle(8, "a second channel federates"), () =>
    federatedChannel(run, "fedsus", "api"),
  );
  const peer = await run.peer();
  await ctx.step(federationTitle(8, "the peer follows it"), () => followAndAccept(run, ch));
  const signedUp = await ctx.platform.signUp({ prefix: "fedmod" });
  await grantRole(databaseUrl, signedUp.username, "admin", ROLE_CLI_TIMEOUT_MS);
  const admin = await ctx.platform.users.signIn(signedUp);
  const suspend = (suspended: boolean) =>
    admin.api.client.safety.suspend({
      username: ch.owner.username,
      target: "channel",
      suspended,
      reason: "harness federation scenario",
      ...(suspended ? { clauseId: "guidelines.general" } : {}),
    });
  const fresh = arrivedSince(peer.received);
  await ctx.step(federationTitle(8, "an admin suspends the channel"), () => suspend(true));
  ctx.defer(() => suspend(false).catch(() => undefined));
  await ctx.step(federationTitle(8, "the peer receives a signed Delete of the actor"), () =>
    peer.waitFor(
      fresh((r) => isActorDelete(r, ch.actorId)),
      DELIVERY_TIMEOUT_MS,
    ),
  );
  const left = await followerIds(ch);
  ctx.check("8. the channel's followers are dropped", left.length === 0, { followers: left.length });
}

async function step9(run: FederationRun): Promise<void> {
  const { ctx } = run;
  const ch = await run.channel();
  const peer = await run.peer();
  await ensureFollowing(run, ch);
  const row = (await followerIds(ch)).find((f) => f.actor === peer.actorId);
  if (!row) throw new Error("step 9: the peer is not listed as a follower");
  await ctx.step(federationTitle(9, `the streamer removes the peer (${run.via})`), async () => {
    if (run.via === "web") await run.web.removeFollowerViaWeb(ctx, ch.owner, peer.actorId);
    else await ch.owner.api.client.federation.followers.remove({ channel: ch.slug, id: row.id });
    run.follow = null;
  });
  const listed = (await followerIds(ch)).some((f) => f.actor === peer.actorId);
  ctx.assert("9. the peer is gone from the list", !listed);
  if (ch.encoder?.running) await goOffline(run, ch);
  const from = peer.received.length;
  await ctx.step(federationTitle(9, "go live again"), () => goLive(run, ch));
  await Bun.sleep(QUIET_WINDOW_MS);
  const late = peer.since(from, (r) => anyCreateFrom(r, ch.actorId));
  ctx.assert("9. the removed follower receives nothing more", late.length === 0, { creates: late.length });
  await goOffline(run, ch);
}

export const FEDERATION_STEP_RUNNERS: Readonly<Record<FederationStep, (run: FederationRun) => Promise<void>>> = {
  1: step1,
  2: step2,
  3: step3,
  4: step4,
  5: step5,
  6: step6,
  7: step7,
  8: step8,
  9: step9,
};
