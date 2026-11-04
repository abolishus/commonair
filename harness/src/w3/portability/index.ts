// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `portability` steps 1–5 (docs/testing/b7-selectors.md, "Scenarios"; ADR 0037) and their run
 * state. Each step uses its own actors (a streamer and a fan for 1–2, a source and destinations for
 * 3–5). `--set via=web` (the default) drives `/move`, the landing page and `/settings/notifications` in a
 * browser; `via=api` the same through the API.
 *
 * 1. A link converts: a follow through it records `source = move_link`, the link counts it, and
 *    the trigger-kept follower count rises.
 * 2. The fan asks to be told; the streamer sets "moved to": Mailpit gets exactly one moved notice
 *    (to the fan, never the streamer), the grant is gone, and the channel page shows the notice.
 * 3. A source channel's bundle (title, tags, an emote) is exported, downloaded and imported into
 *    another channel: standing verified, every field lands.
 * 4. Step 3's bundle with a T0 fixture emote added: that emote is refused through the upload
 *    pipeline (and a T0 case opens), the rest imports, the standing is "not verified".
 * 5. A suspended channel's bundle is refused at import (the statement says `activeSuspension`).
 *
 * Database reads and the role CLI need `DATABASE_URL` (Bun loads it from the repo `.env`).
 */
import type { PortabilityImport } from "@commonair/contracts/dto";
import { download } from "../../e6/exports.ts";
import { grantRole } from "../../money-db.ts";
import type { Via } from "../../money.ts";
import { playerBundles } from "../../player-server.ts";
import { testCardPng } from "../../png.ts";
import { fixturePath, FIXTURES } from "../../safety.ts";
import { putPresigned, readFixture } from "../../safety-io.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { SignedInUser } from "../../users.ts";
import { waitFor } from "../../wait.ts";
import { signInViaUi } from "../../web/flows.ts";
import { ROUTES } from "../../web/selectors.ts";
import { WebSession } from "../../web/session.ts";
import { testIdSelector as tid } from "../../w2/rehearsal/checks.ts";
import { portabilityTitle, type PortabilityStep } from "../steps.ts";
import { readBundleJson, withExtraEmote } from "./bundle.ts";
import { followSource, t0CasesSince } from "./db.ts";

const UI_TIMEOUT_MS = 30_000;
/** The moved notice goes out through the outbox and a worker job; generous on a loaded runner. */
const MAIL_TIMEOUT_MS = 90_000;
/** A bundle export is built by the worker (images read, statement signed, archive uploaded). */
const EXPORT_TIMEOUT_MS = 120_000;
/** The worker applies an import: one upload-pipeline call per image. */
const IMPORT_TIMEOUT_MS = 120_000;
const ROLE_CLI_TIMEOUT_MS = 60_000;
const EMOTE = "ptwave";
const T0_EMOTE = "ptbad";

/** Move notices live on notifications since D5-settings (F37), in a searchable, paged list. */
export const PORTABILITY_ROUTES = { move: "/move", notifications: "/settings/notifications" } as const;

export interface PortabilityRun {
  ctx: ScenarioContext;
  via: Via;
  databaseUrl: string | undefined;
  sessions: WebSession[];
  /** Steps 1–2. */
  streamer: SignedInUser | null;
  fan: SignedInUser | null;
  /** Step 3's exported archive and its source title, for step 4. */
  bundle: Uint8Array | null;
  sourceTitle: string | null;
}

/** Set up what the selected steps share; each step signs up its own actors. */
export async function newPortabilityRun(ctx: ScenarioContext, opts: { via: Via }): Promise<PortabilityRun> {
  const run: PortabilityRun = {
    ctx,
    via: opts.via,
    databaseUrl: ctx.env.DATABASE_URL,
    sessions: [],
    streamer: null,
    fan: null,
    bundle: null,
    sourceTitle: null,
  };
  ctx.defer(async () => {
    await Promise.allSettled(run.sessions.map((s) => s.close()));
  });
  return run;
}

const title = (n: PortabilityStep, what: string) => portabilityTitle(n, what);
const channelOf = (u: SignedInUser) => u.me.channelSlug ?? u.username;

async function webSession(run: PortabilityRun, user: SignedInUser, label: string): Promise<WebSession> {
  const { ctx } = run;
  const s = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label,
    log: ctx.log,
  });
  run.sessions.push(s);
  const page = await s.goto(ROUTES.signin);
  await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  return s;
}

/** The `data.reason` of a refused call, or `ok`. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (err) {
    const data = (err as { data?: { reason?: unknown } }).data;
    return typeof data?.reason === "string" ? data.reason : "error";
  }
}

// ------------------------------------------------------------------ 1. a link converts

async function linkConverts(run: PortabilityRun): Promise<void> {
  const { ctx } = run;
  const [streamer, fan] = await ctx.step(title(1, "sign up a streamer and a fan"), () =>
    Promise.all([ctx.platform.signUp({ prefix: "pt_streamer" }), ctx.platform.signUp({ prefix: "pt_fan" })]),
  );
  run.streamer = streamer;
  run.fan = fan;
  const channel = channelOf(streamer);
  const channelId = (await streamer.api.client.channels.get({ channel })).id;
  const before = (await ctx.platform.api().client.channels.get({ channel })).followerCount;

  let url: string;
  if (run.via === "web") {
    const s = await webSession(run, streamer, "w3-portability-streamer");
    const page = await s.goto(PORTABILITY_ROUTES.move);
    url = await ctx.step(title(1, "create a link on /move"), async () => {
      await page.locator(tid("move-link-create")).click({ timeout: UI_TIMEOUT_MS });
      const created = page.locator(tid("move-link-new"));
      await created.waitFor({ timeout: UI_TIMEOUT_MS });
      return (await created.getAttribute("data-url")) ?? "";
    });
    await page
      .locator(tid("move-link", { state: "active" }))
      .first()
      .waitFor({ timeout: UI_TIMEOUT_MS });
  } else {
    url = (await ctx.step(title(1, "create a link"), () => streamer.api.client.portability.links.create({ channel })))
      .url;
  }
  const path = new URL(url).pathname;
  const nonce = path.split("/").at(-1) ?? "";
  ctx.assert("1. the link is /m/<slug>/<nonce>", path === `/m/${channel}/${nonce}` && nonce.length >= 16, { path });

  if (run.via === "web") {
    const s = await webSession(run, fan, "w3-portability-fan");
    const page = await s.goto(path);
    await ctx.step(title(1, "follow through the landing page"), async () => {
      await page.locator(tid("move-landing", { state: "active" })).waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("move-landing-follow")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("move-landing-follow", { following: "true" })).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  } else {
    await ctx.step(title(1, "follow through the link"), () =>
      fan.api.client.channels.follow({ channel, notify: true, moveLink: { nonce } }),
    );
  }

  const links = await streamer.api.client.portability.links.list({ channel });
  ctx.assert(
    "1. the link counts one conversion",
    links.length === 1 && links[0]?.conversions === 1,
    links.map((l) => l.conversions),
  );
  const after = (await ctx.platform.api().client.channels.get({ channel })).followerCount;
  ctx.assert("1. the follower count rose by one", after === before + 1, { before, after });
  ctx.assert("1. DATABASE_URL is set (run from the repo root so Bun loads .env)", run.databaseUrl !== undefined);
  const f = await followSource(run.databaseUrl as string, fan.id, channelId);
  ctx.assert(
    "1. the follow's source is move_link, naming the link",
    f?.source === "move_link" && f.moveLinkId === links[0]?.id,
    f,
  );
}

// ------------------------------------------------------------------ 2. a grant, then a move

async function grantThenMove(run: PortabilityRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("2. step 1 left a streamer and a fan who follows", run.streamer !== null && run.fan !== null);
  const streamer = run.streamer as SignedInUser;
  const fan = run.fan as SignedInUser;
  const channel = channelOf(streamer);
  const movedTo = `https://video.example.org/${channel}`;

  if (run.via === "web") {
    const s =
      run.sessions.find((x) => x.label === "w3-portability-fan") ?? (await webSession(run, fan, "w3-portability-fan"));
    const page = await s.goto(PORTABILITY_ROUTES.notifications);
    await ctx.step(title(2, "the fan asks to be told on /settings/notifications"), async () => {
      // The list shows 20 channels per page; search puts this one on the first.
      await page.locator(tid("portability-grants-search")).fill(channel, { timeout: UI_TIMEOUT_MS });
      const row = page.locator(tid("portability-grant", { channel }));
      await row.waitFor({ timeout: UI_TIMEOUT_MS });
      await row.locator(tid("portability-grant-toggle")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("portability-grant", { channel, state: "on" })).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  } else {
    await ctx.step(title(2, "the fan asks to be told"), () =>
      fan.api.client.portability.grants.set({ channel, enabled: true }),
    );
  }
  ctx.assert(
    "2. the fan holds a grant",
    (await fan.api.client.portability.grants.mine()).some((g) => g.channel.slug === channel),
  );

  ctx.defer(() => streamer.api.client.portability.move.clear({ channel }).catch(() => undefined));
  if (run.via === "web") {
    const s =
      run.sessions.find((x) => x.label === "w3-portability-streamer") ??
      (await webSession(run, streamer, "w3-portability-streamer"));
    const page = await s.goto(PORTABILITY_ROUTES.move);
    await ctx.step(title(2, "the streamer sets moved to on /move"), async () => {
      await page.locator(tid("move-to-url")).fill(movedTo, { timeout: UI_TIMEOUT_MS });
      await page.locator(tid("move-to-save")).click({ timeout: UI_TIMEOUT_MS });
      const dialog = page.locator(tid("move-to-confirm"));
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      await dialog.locator(tid("confirm-dialog-confirm")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("move-to-current", { url: movedTo })).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  } else {
    await ctx.step(title(2, "the streamer sets moved to"), () =>
      streamer.api.client.portability.move.set({ channel, movedTo }),
    );
  }

  const mailpit = ctx.platform.mailpit;
  const isNotice = (subject: string) => subject.includes(streamer.displayName);
  const notice = await ctx.step(title(2, "Mailpit receives the moved notice"), () =>
    mailpit.waitForMessage(fan.email, (m) => isNotice(m.subject), MAIL_TIMEOUT_MS),
  );
  const headers = await mailpit.headers(notice.id);
  ctx.check(
    "2. the notice has a one-click unsubscribe on the moved list",
    (headers["List-Unsubscribe"] ?? []).some((h) => h.includes("list=moved")),
    headers["List-Unsubscribe"],
  );
  ctx.check(
    "2. the notice names the new site, never links it",
    notice.text.includes("video.example.org") && !notice.html.includes(`href="${movedTo}`),
  );
  // Let a duplicate (a retried job) land before counting.
  await Bun.sleep(5_000);
  const toFan = (await mailpit.search(`to:"${fan.email}"`)).filter((m) => isNotice(m.subject));
  ctx.assert("2. exactly one moved notice", toFan.length === 1, { count: toFan.length });
  const toStreamer = (await mailpit.search(`to:"${streamer.email}"`)).filter((m) => isNotice(m.subject));
  ctx.assert("2. the streamer gets none", toStreamer.length === 0, { count: toStreamer.length });
  ctx.assert(
    "2. the grant is gone",
    !(await fan.api.client.portability.grants.mine()).some((g) => g.channel.slug === channel),
  );

  const c = await ctx.platform.api().client.channels.get({ channel });
  ctx.assert("2. the channel says where it moved", c.movedTo?.url === movedTo, c.movedTo);
  if (run.via === "web") {
    const s = run.sessions.find((x) => x.label === "w3-portability-fan");
    const page = await (s as WebSession).goto(`/${channel}`);
    await ctx.step(title(2, "the channel page shows the notice"), () =>
      page.locator(tid("moved-notice", { url: movedTo })).waitFor({ timeout: UI_TIMEOUT_MS }),
    );
  }
}

// ------------------------------------------------------------------ 3–5. bundles

/** Request a bundle export and download it once the worker built it. */
async function exportBundle(run: PortabilityRun, user: SignedInUser, n: PortabilityStep): Promise<Uint8Array> {
  const { ctx } = run;
  const channel = channelOf(user);
  if (run.via === "web" && n === 3) {
    const s = await webSession(run, user, `w3-portability-export-${n}`);
    const page = await s.goto(PORTABILITY_ROUTES.move);
    await ctx.step(title(n, "export a bundle on /move"), () =>
      page.locator(tid("bundle-export")).click({ timeout: UI_TIMEOUT_MS }),
    );
  } else await ctx.step(title(n, "export a bundle"), () => user.api.client.portability.bundle.create({ channel }));
  const job = await ctx.step(title(n, "the worker builds it"), () =>
    waitFor(
      "a ready bundle export",
      async () => {
        const all = await user.api.client.me.exports.list();
        const e = all.find((x) => x.kind === "bundle");
        if (e?.status === "failed") throw new Error("the bundle export failed");
        return e?.status === "ready" && e.downloadUrl ? e : null;
      },
      { timeoutMs: EXPORT_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  const got = await download(job.downloadUrl as string, ctx.signal);
  ctx.assert(`${n}. the bundle downloads`, got.status === 200 && got.bytes !== null, { status: got.status });
  return got.bytes as Uint8Array;
}

/** Upload and preview through the API; the refusal reason, or the preview. */
async function previewViaApi(
  user: SignedInUser,
  archive: Uint8Array,
  signal: AbortSignal,
): Promise<{ ok: true; dto: PortabilityImport } | { ok: false; reason: string }> {
  const channel = channelOf(user);
  const up = await user.api.client.portability.imports.upload({ channel, sizeBytes: archive.byteLength });
  await putPresigned(up.uploadUrl, up.headers, archive, signal);
  try {
    return { ok: true, dto: await user.api.client.portability.imports.preview({ channel, key: up.key }) };
  } catch (err) {
    const reason = await refusal(Promise.reject(err));
    return { ok: false, reason };
  }
}

async function waitDone(run: PortabilityRun, user: SignedInUser, id: string): Promise<PortabilityImport> {
  const channel = channelOf(user);
  return waitFor(
    "the import finished",
    async () => {
      const dto = await user.api.client.portability.imports.get({ channel, id });
      return dto.status === "done" || dto.status === "failed" ? dto : null;
    },
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 2_000, signal: run.ctx.signal },
  );
}

/** Import an archive into `user`'s channel with every item chosen; the finished import. */
async function importAll(
  run: PortabilityRun,
  user: SignedInUser,
  archive: Uint8Array,
  n: PortabilityStep,
  web: boolean,
): Promise<PortabilityImport> {
  const { ctx } = run;
  const channel = channelOf(user);
  if (web) {
    const s = await webSession(run, user, `w3-portability-import-${n}`);
    const page = await s.goto(PORTABILITY_ROUTES.move);
    const id = await ctx.step(title(n, "upload and preview on /move"), async () => {
      await page
        .locator(tid("bundle-import-file"))
        .setInputFiles({ name: "bundle.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
      const preview = page.locator(tid("bundle-import-preview"));
      await preview.waitFor({ timeout: IMPORT_TIMEOUT_MS });
      return (await preview.getAttribute("data-import-id")) ?? "";
    });
    await ctx.step(title(n, "assert the emote rights and start"), async () => {
      await page.locator(tid("bundle-import-assert")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("bundle-import-start")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("bundle-import-result", { status: "done" })).waitFor({ timeout: IMPORT_TIMEOUT_MS });
    });
    return user.api.client.portability.imports.get({ channel, id });
  }
  const p = await ctx.step(title(n, "upload and preview"), () => previewViaApi(user, archive, ctx.signal));
  ctx.assert(`${n}. the preview is not refused`, p.ok, p);
  const dto = (p as { ok: true; dto: PortabilityImport }).dto;
  const emotes = dto.preview.items.filter((i) => i.kind === "emote" && i.outcome === null).map((i) => i.ref);
  await ctx.step(title(n, "start with everything chosen"), () =>
    user.api.client.portability.imports.start({
      channel,
      id: dto.id,
      choices: { channel: true, panels: true, emotes },
      assertEmoteRights: true,
    }),
  );
  return ctx.step(title(n, "the worker applies it"), () => waitDone(run, user, dto.id));
}

const outcomeOf = (dto: PortabilityImport, kind: string, ref: string) =>
  dto.result?.find((i) => i.kind === kind && i.ref === ref) ?? null;

async function roundTrip(run: PortabilityRun): Promise<void> {
  const { ctx } = run;
  const [source, dest] = await ctx.step(title(3, "sign up a source and a destination"), () =>
    Promise.all([ctx.platform.signUp({ prefix: "pt_src" }), ctx.platform.signUp({ prefix: "pt_dst" })]),
  );
  const channel = channelOf(source);
  const sourceTitle = `Portability ${ctx.runId.slice(0, 8)}`;
  await ctx.step(title(3, "the source sets its title and tags and adds an emote"), async () => {
    await source.api.client.channels.update({
      channel,
      title: sourceTitle,
      description: "Moving with everything.",
      tags: ["portability", "harness"],
    });
    const png = testCardPng(64);
    const up = await source.api.client.channels.uploadUrl({
      channel,
      purpose: "emote",
      contentType: "image/png",
      sizeBytes: png.byteLength,
    });
    await putPresigned(up.uploadUrl, up.headers, png, ctx.signal);
    const committed = await source.api.client.channels.commitUpload({ channel, key: up.key });
    await source.api.client.chat.emotes.create({ channel, code: EMOTE, imageKey: committed.key, tier: 0 });
  });
  const archive = await exportBundle(run, source, 3);
  const json = readBundleJson(archive);
  ctx.assert("3. the bundle carries a standing statement", json.standing !== null);
  run.bundle = archive;
  run.sourceTitle = sourceTitle;

  const done = await importAll(run, dest, archive, 3, run.via === "web");
  ctx.assert("3. the import finished", done.status === "done", { status: done.status, result: done.result });
  ctx.assert(
    "3. the standing is verified (this instance signed it)",
    done.standingVerified === true,
    done.standingVerified,
  );
  const dc = await ctx.platform.api().client.channels.get({ channel: channelOf(dest) });
  ctx.assert("3. the title landed", dc.title === sourceTitle, { title: dc.title });
  ctx.check(
    "3. the tags landed",
    ["portability", "harness"].every((t) => dc.tags.includes(t)),
    dc.tags,
  );
  const emotes = await ctx.platform.api().client.chat.emotes.list({ channel: channelOf(dest) });
  ctx.assert(
    `3. the ${EMOTE} emote landed`,
    emotes.some((e) => e.code === EMOTE),
  );
  ctx.check(`3. the ${EMOTE} result is imported`, outcomeOf(done, "emote", EMOTE)?.outcome === "imported", done.result);
}

async function t0Refused(run: PortabilityRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("4. step 3 left a bundle", run.bundle !== null);
  ctx.assert("4. DATABASE_URL is set (run from the repo root so Bun loads .env)", run.databaseUrl !== undefined);
  const dest = await ctx.step(title(4, "sign up a destination"), () => ctx.platform.signUp({ prefix: "pt_dst_t0" }));
  const since = new Date();
  const archive = await withExtraEmote(run.bundle as Uint8Array, T0_EMOTE, readFixture(fixturePath(FIXTURES.t0Csam)));
  const done = await importAll(run, dest, archive, 4, false);
  ctx.assert("4. the import finished", done.status === "done", { status: done.status });
  ctx.assert(
    "4. the T0 emote is refused with the opaque reason",
    outcomeOf(done, "emote", T0_EMOTE)?.outcome === "rejected" &&
      outcomeOf(done, "emote", T0_EMOTE)?.reason === "upload_rejected",
    outcomeOf(done, "emote", T0_EMOTE),
  );
  ctx.check(`4. the ${EMOTE} emote still imports`, outcomeOf(done, "emote", EMOTE)?.outcome === "imported");
  ctx.check("4. the edited bundle's standing is not verified (bound to the original)", done.standingVerified === false);
  const emotes = await ctx.platform.api().client.chat.emotes.list({ channel: channelOf(dest) });
  ctx.assert("4. no T0 emote on the channel", !emotes.some((e) => e.code === T0_EMOTE));
  const cases = await ctx.step(title(4, "the refused image opened a T0 case"), () =>
    waitFor(
      "a T0 case for the destination",
      async () => {
        const n = await t0CasesSince(
          run.databaseUrl as string,
          (await dest.api.client.channels.get({ channel: channelOf(dest) })).id,
          since,
        );
        return n > 0 ? n : null;
      },
      { timeoutMs: 60_000, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  ctx.check("4. one T0 case", cases === 1, { cases });
}

async function suspendedRefused(run: PortabilityRun): Promise<void> {
  const { ctx } = run;
  ctx.assert("5. DATABASE_URL is set (run from the repo root so Bun loads .env)", run.databaseUrl !== undefined);
  const [source, dest, admin] = await ctx.step(title(5, "sign up a source, a destination and an admin"), () =>
    Promise.all([
      ctx.platform.signUp({ prefix: "pt_sus" }),
      ctx.platform.signUp({ prefix: "pt_dst_sus" }),
      ctx.platform.signUp({ prefix: "pt_admin" }),
    ]),
  );
  await ctx.step(title(5, "grant the admin role (operator CLI)"), () =>
    grantRole(run.databaseUrl as string, admin.username, "admin", ROLE_CLI_TIMEOUT_MS),
  );
  const staff = await ctx.step(title(5, "admin: sign in again to pick up the role"), () =>
    ctx.platform.users.signIn(admin),
  );
  const suspend = (suspended: boolean) =>
    staff.api.client.safety.suspend({
      username: source.username,
      target: "channel",
      suspended,
      reason: "harness portability scenario",
      ...(suspended ? { clauseId: "guidelines.general" } : {}),
    });
  await ctx.step(title(5, "an admin suspends the source channel"), () => suspend(true));
  ctx.defer(() => suspend(false).catch(() => undefined));
  const archive = await exportBundle(run, source, 5);
  const destBefore = (await ctx.platform.api().client.channels.get({ channel: channelOf(dest) })).title;

  if (run.via === "web") {
    const s = await webSession(run, dest, "w3-portability-import-5");
    const page = await s.goto(PORTABILITY_ROUTES.move);
    await ctx.step(title(5, "the import on /move is refused by the standing"), async () => {
      await page
        .locator(tid("bundle-import-file"))
        .setInputFiles({ name: "bundle.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
      await page.locator(tid("bundle-import-standing", { state: "refused" })).waitFor({ timeout: IMPORT_TIMEOUT_MS });
    });
    ctx.assert("5. no preview to start from", (await page.locator(tid("bundle-import-start")).count()) === 0);
  } else {
    const p = await ctx.step(title(5, "upload and preview"), () => previewViaApi(dest, archive, ctx.signal));
    ctx.assert("5. the preview is refused: standing_suspended", !p.ok && p.reason === "standing_suspended", p);
  }
  const imports = await dest.api.client.portability.imports.list({ channel: channelOf(dest) });
  ctx.assert(
    "5. the import is failed with the reason",
    imports[0]?.status === "failed" && imports[0]?.result?.[0]?.reason === "standing_suspended",
    imports[0],
  );
  const destAfter = (await ctx.platform.api().client.channels.get({ channel: channelOf(dest) })).title;
  ctx.assert("5. nothing landed on the destination", destAfter === destBefore, { destBefore, destAfter });
}

export const PORTABILITY_STEP_RUNNERS: Readonly<Record<PortabilityStep, (run: PortabilityRun) => Promise<void>>> = {
  1: linkConverts,
  2: grantThenMove,
  3: roundTrip,
  4: t0Refused,
  5: suspendedRefused,
};
