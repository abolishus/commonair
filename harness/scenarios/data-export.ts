// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E6, data export (docs/testing/e6-selectors.md, "Scenario `data-export`"):
 * 1 U follows S, chats and tips in S's channel; V follows, chats and tips in U's channel;
 * 2 U requests `account` and `channel` exports on `/settings/privacy` (a second `account` request
 * is `RATE_LIMITED` and the button disabled) and both become ready; 3 the email carries a link
 * valid for at most 7 days that downloads a zip; 4 the archive lists its files, holds U's own
 * account, chat, follow and tip, and nothing of V (id, email, username, display name, chat text,
 * tip message) and no session, token, key or password hash of anyone; 5 V cannot list U's exports,
 * a tampered link and an unsigned GET are refused; 6 after `expires_at` passes, `export-cleanup`
 * marks it `expired`, deletes the object and the link stops working.
 *
 * Every value scanned for is generated per run with a distinctive marker. The report carries
 * ids, counts, labels and file names only: never an email, token, key or link.
 */
import {
  type Needle,
  SECRET_PATTERNS,
  checkManifest,
  containsValue,
  jsonEntry,
  manifestOk,
  parseManifest,
  readZip,
  scanFiles,
  valueNeedles,
} from "../src/e6/archive.ts";
import { exportRow, expireExportNow, userSecrets } from "../src/e6/db.ts";
import { type ExportJob, download, exportMailLink, requestExport, waitExportReady } from "../src/e6/exports.ts";
import {
  type Kit,
  UI_TIMEOUT_MS,
  chatOnce,
  confirmedTip,
  exportsBucketConfig,
  setupKit,
  staffAccount,
} from "../src/e6/kit.ts";
import { E6_ROUTES, E6_TEST_IDS as E, byE6Id } from "../src/e6/selectors.ts";
import { presignExpiresSeconds, secondsBetween, tamperSignature, unsignedUrl } from "../src/e6/signed-url.ts";
import { exportObjectKey, EXPORT_TTL_SECONDS } from "@commonair/contracts/internal";
import { ApiTreasurer } from "../src/money-actors.ts";
import { mediaKeyExists } from "../src/safety-io.ts";
import { apiError, errorOf } from "../src/safety.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import type { SignedInUser } from "../src/users.ts";

/** Tolerance between `expiresAt` and `completedAt + 7 days` (both written in one transaction). */
const EXPIRY_TOLERANCE_S = 5;
const CLEANUP_TIMEOUT_MS = 2 * 60_000;

export default defineScenario({
  name: "data-export",
  description:
    "U and V act in each other's channels → U's account and channel exports (second refused) → emailed 7-day link downloads a zip → the archive holds U's data and nothing of V, no secret → V cannot list or fetch it, tampered/unsigned links refused → expiry deletes it",
  needs: ["api", "web", "chat", "worker", "mail", "browser"],
  timeoutMs: 15 * 60_000,
  async run(ctx) {
    const kit = await setupKit(ctx);
    await dataExport(ctx, kit);
    kit.done();
  },
});

async function dataExport(ctx: ScenarioContext, kit: Kit): Promise<void> {
  const p = ctx.platform;
  const tag = ctx.runId;
  const [u, s, v] = await ctx.step("sign up U, S and V (API)", () =>
    Promise.all([
      p.signUp({ prefix: "e6dx_u", displayName: `Uexporter ${tag}`.slice(0, 30) }),
      p.signUp({ prefix: "e6dx_s", displayName: `Sstreamer ${tag}`.slice(0, 30) }),
      p.signUp({ prefix: "e6dx_v", displayName: `Vother ${tag}`.slice(0, 30) }),
    ]),
  );
  const treasurerUser = await staffAccount(kit, "e6dx_tr", "treasurer");
  const treasurer = new ApiTreasurer(treasurerUser.api.client);
  const uChannel = u.me.channelSlug ?? u.username;
  const sChannel = s.me.channelSlug ?? s.username;
  ctx.data("users", { u: u.username, s: s.username, v: v.username, treasurer: treasurerUser.username });
  const text = {
    uChat: `e6dx uchat ${tag}`,
    uTip: `e6dx utip ${tag}`,
    vChat: `e6dx vchat ${tag}`,
    vTip: `e6dx vtip ${tag}`,
  };

  // ------------------------------------------------------------ 1. activity
  await ctx.step("1 U follows S, chats in S's channel and tips S (confirmed)", async () => {
    await u.api.client.channels.follow({ channel: sChannel });
    await chatOnce(kit, u, sChannel, text.uChat);
    await confirmedTip(kit, treasurer, u, sChannel, { cents: 200, message: text.uTip });
  });
  await ctx.step("1 V follows U's channel, chats there and tips U (confirmed)", async () => {
    await v.api.client.channels.follow({ channel: uChannel });
    await chatOnce(kit, v, uChannel, text.vChat);
    await confirmedTip(kit, treasurer, v, uChannel, { cents: 300, message: text.vTip });
  });
  // Secrets of U's that must not be in the archive: a stream key and an overlay token.
  const uStreamKey = (await u.api.client.stream.rotateKey({ channel: uChannel })).key;
  const uOverlayToken = (await u.api.client.interact.overlays.token({ channel: uChannel, expiresAt: null })).token;

  // ------------------------------------------------------------ 2. request exports
  const session = kit.via === "web" ? await kit.webSession("U", u) : null;
  const accountId = await ctx.step("2 U requests an account export", () => requestExport(kit, session, u, "account"));
  const channelId = await ctx.step("2 U requests a channel export", () => requestExport(kit, session, u, "channel"));
  ctx.data("exports", { account: accountId, channel: channelId });
  const second = await errorOf(() => u.api.client.me.exports.create({ kind: "account" }));
  ctx.assert("2 a second account export is RATE_LIMITED", apiError(second).code === "RATE_LIMITED", {
    code: apiError(second).code,
  });
  if (session) {
    const page = await session.goto(E6_ROUTES.privacy);
    const button = byE6Id(page, E.exportRequest, { kind: "account" });
    await button.waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.assert("2 the account export button is disabled during the cooldown", await button.isDisabled());
  }
  const [accountJob, channelJob] = await ctx.step("2 both exports become ready", async () => [
    await waitExportReady(kit, session, u, accountId),
    await waitExportReady(kit, session, u, channelId),
  ]);
  if (session) {
    const page = await session.goto(E6_ROUTES.privacy);
    const link = byE6Id(byE6Id(page, E.exportRow, { "export-id": accountId }), E.exportDownload);
    ctx.check("2 the ready account row has a download link", (await link.count()) > 0);
  }

  // ------------------------------------------------------------ 3. the emailed link
  const archives = new Map<string, Map<string, Uint8Array>>();
  const links: Record<string, string> = {};
  for (const [kind, job] of [
    ["account", accountJob],
    ["channel", channelJob],
  ] as const) {
    const link = await ctx.step(`3 U's ${kind} export email has its link`, () => exportMailLink(kit, u, job.id));
    links[kind] = link;
    const expires = presignExpiresSeconds(link);
    ctx.assert(`3 (${kind}) X-Amz-Expires ≤ 604800`, expires !== null && expires <= EXPORT_TTL_SECONDS, { expires });
    checkExpiry(ctx, kind, job);
    const got = await ctx.step(`3 the ${kind} link downloads a zip`, () => download(link, ctx.signal));
    ctx.assert(`3 (${kind}) the link answers 200`, got.status === 200 && got.bytes !== null, { status: got.status });
    if (!got.bytes) return;
    const files = readZip(got.bytes);
    archives.set(kind, files);
    ctx.metric(`export_${kind}_bytes`, got.bytes.byteLength, "bytes");
  }

  // ------------------------------------------------------------ 4. archive contents
  await ctx.step("4 the archives", async () => {
    const secrets = await userSecrets(kit.databaseUrl, [u.id, v.id, s.id]);
    checkArchives(ctx, archives, {
      u,
      s,
      v,
      sChannel,
      accountId,
      channelId,
      text,
      secrets: [
        ...valueNeedles("session-token", secrets.sessionTokens),
        ...valueNeedles("password-hash", secrets.passwordHashes),
        ...valueNeedles("provider-token", secrets.providerTokens),
        ...valueNeedles("stream-key", [uStreamKey]),
        ...valueNeedles("overlay-token", [uOverlayToken]),
      ],
    });
  });

  // ------------------------------------------------------------ 5. other people
  const vList = await v.api.client.me.exports.list();
  ctx.assert(
    "5 V's me.exports.list does not show U's exports",
    !vList.some((e) => e.id === accountId || e.id === channelId),
  );
  const accountLink = links.account;
  if (!accountLink) return;
  const tampered = await download(tamperSignature(accountLink), ctx.signal);
  ctx.assert(
    "5 the link with one signature character changed is refused",
    tampered.status >= 400 && tampered.bytes === null,
    {
      status: tampered.status,
    },
  );
  const unsigned = await download(unsignedUrl(accountLink), ctx.signal);
  ctx.assert("5 V cannot GET U's object key without a signature", unsigned.status >= 400 && unsigned.bytes === null, {
    status: unsigned.status,
  });

  // ------------------------------------------------------------ 6. expiry
  const moved = await ctx.step("6 move the account export's expires_at into the past (DB)", () =>
    expireExportNow(kit.databaseUrl, accountId),
  );
  ctx.assert("6 the export row was moved", moved === 1, { moved });
  await ctx.step("6 ops tick export-cleanup marks it expired", () =>
    kit.ops.tickUntil(
      "export-cleanup",
      "the account export expired",
      async () => ((await exportRow(kit.databaseUrl, accountId)).status === "expired" ? true : null),
      { timeoutMs: CLEANUP_TIMEOUT_MS },
    ),
  );
  const bucket = exportsBucketConfig(kit);
  if (bucket) {
    const exists = await mediaKeyExists(bucket, exportObjectKey(u.id, accountId));
    ctx.assert("6 the archive object is gone", !exists);
  } else ctx.check("6 S3_* credentials set to HEAD the exports bucket", false);
  const old = await download(accountLink, ctx.signal);
  ctx.assert("6 the old link answers 403/404", old.status === 403 || old.status === 404, { status: old.status });
  const after = (await u.api.client.me.exports.list()).find((e) => e.id === accountId);
  ctx.assert(
    "6 the list shows it expired with no downloadUrl",
    after?.status === "expired" && after.downloadUrl === null,
    { status: after?.status, hasUrl: after?.downloadUrl !== null },
  );
}

function checkExpiry(ctx: ScenarioContext, kind: string, job: ExportJob): void {
  const ok =
    job.completedAt !== null &&
    job.expiresAt !== null &&
    Math.abs(secondsBetween(job.completedAt, job.expiresAt) - EXPORT_TTL_SECONDS) <= EXPIRY_TOLERANCE_S;
  ctx.assert(`3 (${kind}) expiresAt is completion + 7 days`, ok, {
    deltaSeconds: job.completedAt && job.expiresAt ? secondsBetween(job.completedAt, job.expiresAt) : null,
  });
}

interface ArchiveExpectations {
  u: SignedInUser;
  s: SignedInUser;
  v: SignedInUser;
  sChannel: string;
  accountId: string;
  channelId: string;
  text: { uChat: string; uTip: string; vChat: string; vTip: string };
  secrets: Needle[];
}

function checkArchives(
  ctx: ScenarioContext,
  archives: Map<string, Map<string, Uint8Array>>,
  x: ArchiveExpectations,
): void {
  for (const [kind, files] of archives) {
    const manifest = parseManifest(jsonEntry(files, "manifest.json"));
    const check = checkManifest(files, manifest);
    ctx.data(`archive.${kind}`, { files: [...files.keys()].sort(), manifest: check });
    ctx.assert(`4 (${kind}) manifest.json lists every file present`, manifestOk(check), check);
    ctx.assert(
      `4 (${kind}) manifest names this export, kind and user`,
      manifest.kind === kind &&
        manifest.userId === x.u.id &&
        manifest.exportId === (kind === "account" ? x.accountId : x.channelId),
    );
  }
  const account = archives.get("account");
  if (account) {
    const acc = jsonEntry(account, "account.json") as { id?: unknown };
    ctx.assert("4 account.json is U's", acc.id === x.u.id);
    ctx.assert(
      "4 U's chat message is in chat.json",
      containsValue(account, x.text.uChat, (n) => n === "chat.json"),
    );
    ctx.assert(
      "4 U's follow of S is in follows.json",
      containsValue(account, x.sChannel, (n) => n === "follows.json"),
    );
    ctx.assert(
      "4 U's tip message is in tips.json",
      containsValue(account, x.text.uTip, (n) => n === "tips.json"),
    );
  }
  // Another person never appears; S's channel appears only by its public slug (so S's username,
  // which is that slug, is not a needle: S's id, email and display name are).
  const needles: Needle[] = [
    ...valueNeedles("v.id", [x.v.id]),
    ...valueNeedles("v.email", [x.v.email], true),
    ...valueNeedles("v.username", [x.v.username]),
    ...valueNeedles("v.displayName", [x.v.displayName]),
    ...valueNeedles("v.chat", [x.text.vChat]),
    ...valueNeedles("v.tipMessage", [x.text.vTip]),
    ...valueNeedles("s.id", [x.s.id]),
    ...valueNeedles("s.email", [x.s.email], true),
    ...valueNeedles("s.displayName", [x.s.displayName]),
    ...x.secrets,
    ...SECRET_PATTERNS,
  ];
  for (const [kind, files] of archives) {
    const hits = scanFiles(files, needles);
    ctx.data(`archive.${kind}.scan`, { needles: needles.length, hits });
    ctx.assert(`4 (${kind}) no file holds another person's data or any secret`, hits.length === 0, hits);
  }
}
