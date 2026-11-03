// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-server's extensions (docs/testing/b8-selectors.md, "Scenarios"):
 *
 * - `interact` `raid-restart-keeps-raid`: a raid surge restarted by a moderator inside its window
 *   keeps `raid`, and the moderator's end clears it;
 * - `twitch-import` `field-choices` (only the `twitch-import-field` boxes left ticked apply) and
 *   `import-expiry` (`finished_at` aged past 30 days; the Twitch data is cleared, the status and an
 *   audit row with a count, and no names, are kept);
 * - `federation` `actor-disabled-event`: turning federation off reaches the peer as one actor
 *   `Delete` sent by the worker from the outbox events (never `channel.update`), and so does a
 *   suspension; no `Delete` has the form the API used to queue itself;
 * - `portability` `incoming-cleanup`: an abandoned import (aged in the database) loses its archive,
 *   a fresh one keeps it;
 * - `data-export` `giveaway-section`: `interact-giveaways.json` holds the caller's own rows only;
 * - `trust-safety` `sor-staff-action` (a staff suspension has a `staff_action` statement, and its
 *   email cites no case) and `lapsed-ban-signin` (a lapsed ban cleared at sign-in writes one
 *   `channel.suspension {suspended:false}`, also with two sign-ins at once).
 *
 * The daily jobs (`portability-incoming-cleanup`, `import-record-expiry`) run now through the batch 7
 * test hook (`INTERNAL_ROUTES.b7Tick`, `OPS_TEST_HOOKS`), which runs them once the contract adds them
 * to `B7_TICK_JOBS`. Ages are set in the database (`DATABASE_URL`, the stack's owner connection),
 * timestamps through `w2/sql-time.ts`.
 */
import { RAID_RULES } from "@commonair/contracts/enums";
import { B8_JOBS, INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS } from "@commonair/contracts/internal";
import { createDb } from "@commonair/db";
import { commit, newSalt, newSeed } from "@commonair/draw";
import { RedisClient } from "bun";
import type { Page } from "playwright";
import { jsonEntry, readZip } from "../e6/archive.ts";
import { exportLinkIn } from "../e6/signed-url.ts";
import { extractLinks } from "../mailpit.ts";
import { startTwitchMock, TWITCH_FIXTURE, type TwitchMock } from "../mocks/twitch/server.ts";
import { valkeyUrl } from "../multi/replicas.ts";
import { grantRole } from "../money-db.ts";
import { arrivedSince, isAcceptOf, isActorDelete, rewriteToApi } from "../n4/match.ts";
import { playerBundles } from "../player-server.ts";
import type { Run } from "../safety-run.ts";
import { fixturePath, FIXTURES } from "../safety.ts";
import { internalSecret, putPresigned, readFixture } from "../safety-io.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { testIdSelector as tid } from "../w2/rehearsal/checks.ts";
import { toDate, tsParam } from "../w2/sql-time.ts";
import { sleep, waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES } from "../web/selectors.ts";
import { WebSession } from "../web/session.ts";
import type {
  DataExportB8Extension,
  FederationB8Extension,
  InteractB8Extension,
  PortabilityB8Extension,
  SafetyB8Extension,
  TwitchImportB8Extension,
} from "./kit.ts";

// The scenarios' own values, repeated here: this module is imported by six scenarios, so it imports
// no scenario's module (scripts/ci-changes.ts selects scenarios by import edges).
/** `n3/index.ts` `TWITCH_MOCK_PORT`: `harness/compose.n3.yaml` points the stack at it. */
const TWITCH_MOCK_PORT = 4791;
const IMPORT_ROUTE = "/import";
/** `n4/index.ts`: delivery runs outbox relay → job → deliver; "nothing more" watches this long. */
const DELIVERY_TIMEOUT_MS = 90_000;
const QUIET_WINDOW_MS = 20_000;
const EXPORT_READY_TIMEOUT_MS = 3 * 60_000;
const DAY_MS = 86_400_000;
const UI_TIMEOUT_MS = 30_000;
const IMPORT_TIMEOUT_MS = 120_000;
const TICK_TIMEOUT_MS = 75_000;
const ROLE_CLI_TIMEOUT_MS = 60_000;
/** The statement builder runs every 15 s and delivery after it. */
const STATEMENT_TIMEOUT_MS = 120_000;
/** How long a second `channel.suspension {suspended:false}` is watched for. */
const ONCE_WINDOW_MS = 10_000;
/** The clause the harness's staff actions cite. */
const STAFF_CLAUSE = "guidelines.general";
/** A short statement or case reference, which a staff action's email must never carry. */
export const CASE_REF = /\b(MA|MC)-[0-9A-F]{8}\b/;

// ---------------------------------------------------------------------- shared helpers

type Sql = ReturnType<typeof createDb>["sql"];

async function withSql<T>(databaseUrl: string | undefined, label: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error(`${label}: DATABASE_URL is not set (run from the repo root so Bun loads .env)`);
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: `commonair-harness-b8-${label}` });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

/**
 * Run a batch 8 daily job now through the batch 7 test hook. Its `B7_TICK_JOBS` list names the job
 * once the contract request lands; until then the API answers 400 and the step says why.
 */
export async function b8Tick(ctx: ScenarioContext, job: string): Promise<Record<string, number>> {
  const secret = internalSecret(ctx.env);
  if (!secret) throw new Error(`${job}: the internal API secret is not set (HARNESS_INTERNAL_API_SECRET)`);
  const res = await fetch(new URL(INTERNAL_ROUTES.b7Tick, ctx.env.HARNESS_API_URL), {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify({ job, data: {} }),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TICK_TIMEOUT_MS)]),
  });
  if (res.status === 404)
    throw new Error(
      `${INTERNAL_ROUTES.b7Tick} answered 404: start the stack with OPS_TEST_HOOKS=true (api and worker)`,
    );
  if (res.status === 400)
    throw new Error(`${INTERNAL_ROUTES.b7Tick} does not run ${job} (it is not in B7_TICK_JOBS on this build)`);
  if (!res.ok) throw new Error(`${INTERNAL_ROUTES.b7Tick} (${job}) answered HTTP ${res.status}`);
  return (await res.json()) as Record<string, number>;
}

const slugOf = (u: SignedInUser) => u.me.channelSlug ?? u.username;

async function channelIdOf(u: SignedInUser): Promise<string> {
  return (await u.api.client.channels.get({ channel: slugOf(u) })).id;
}

/** `suspended` of each `channel.suspension` event about the channel, oldest first. */
async function suspensionsOf(databaseUrl: string | undefined, channelId: string): Promise<boolean[]> {
  return withSql(databaseUrl, "suspensions", async (sql) => {
    const rows = await sql<{ suspended: boolean }[]>`
      select (payload ->> 'suspended')::boolean as suspended from events
       where type = 'channel.suspension' and channel_id = ${channelId}::uuid
       order by occurred_at, id`;
    return rows.map((r) => r.suspended);
  });
}

// ---------------------------------------------------------------------- interact

/**
 * `raid-restart-keeps-raid`: the surge value a raid leaves (the worker's `RaidSurgeOverride`, as
 * W3's `surge-raid` makes it end to end) is planted on a channel of its own; a moderator's start
 * keeps `raid` while the raid's window lasts, and the moderator's end clears it.
 */
export async function stepRaidRestartKeepsRaid(run: InteractB8Extension): Promise<void> {
  const { ctx } = run;
  const features = (await ctx.platform.api().client.instance.info()).features;
  if (!features.surgeGuard)
    throw new Error("raid-restart-keeps-raid: the instance surge guard is off (CHAT_SURGE_GUARD, compose.w1.yaml)");
  const dst = await ctx.step("raid-restart-keeps-raid: sign up a target streamer", async () => {
    const user = await ctx.platform.signUp({ prefix: "b8rrk" });
    return { user, channel: slugOf(user), channelId: await channelIdOf(user) };
  });
  const api = dst.user.api.client;
  await ctx.step("raid-restart-keeps-raid: the guard on, with Protect raids", () =>
    api.chat.updateSettings({
      channel: dst.channel,
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10, onRaid: true },
    }),
  );
  const valkey = new RedisClient(valkeyUrl(process.env));
  await valkey.connect();
  ctx.defer(async () => {
    await valkey.send("DEL", [KEYS.surgeOverride(dst.channelId), KEYS.surgeOpen(dst.channelId)]).catch(() => 0);
    valkey.close();
  });
  const raid = { fromChannel: run.streamer.channel, verifiedCount: 2 };
  await ctx.step("raid-restart-keeps-raid: a raid holds chat (the worker's surge value)", async () => {
    const now = Date.now();
    const value = {
      state: "on",
      since: new Date(now).toISOString(),
      until: new Date(now + RAID_RULES.surgeMinutes * 60_000).toISOString(),
      by: null,
      raid,
    };
    const ttl = String(RAID_RULES.surgeMinutes * 60 + 60);
    await valkey.send("SET", [KEYS.surgeOverride(dst.channelId), JSON.stringify(value), "EX", ttl]);
    await valkey.send("SET", [KEYS.surgeOpen(dst.channelId), "1", "EX", ttl]);
    const s = await api.chat.surge.state({ channel: dst.channel });
    ctx.assert("raid-restart-keeps-raid: the banner names the raid", s.raid?.fromChannel === raid.fromChannel, s);
  });
  await ctx.step("raid-restart-keeps-raid: a moderator starts surge mode again: raid stays", async () => {
    const started = await api.chat.surge.override({ channel: dst.channel, action: "start" });
    ctx.assert("raid-restart-keeps-raid: surge mode is on", started.state === "on", started);
    const s = await api.chat.surge.state({ channel: dst.channel });
    ctx.assert(
      "raid-restart-keeps-raid: chat.surge.state still names the raid and its count",
      s.raid?.fromChannel === raid.fromChannel && s.raid.verifiedCount === raid.verifiedCount,
      s,
    );
  });
  await ctx.step("raid-restart-keeps-raid: the moderator's end clears raid", async () => {
    const ended = await api.chat.surge.override({ channel: dst.channel, action: "end" });
    ctx.assert("raid-restart-keeps-raid: suppressed", ended.state === "suppressed", ended);
    const s = await api.chat.surge.state({ channel: dst.channel });
    ctx.assert("raid-restart-keeps-raid: no raid after the end", (s.raid ?? null) === null, s);
  });
}

// ---------------------------------------------------------------------- twitch-import

/** The fields `field-choices` leaves ticked; the rest stay as the channel has them. */
export const FIELD_CHOICES_KEPT = ["title", "tags"] as const;
export const FIELD_CHOICES_UNTICKED = ["category", "language", "description", "mature"] as const;

async function twitchMock(run: TwitchImportB8Extension): Promise<TwitchMock> {
  // The scenario's own mock when an earlier step started it; it closes it at the end.
  run.mock ??= await startTwitchMock({
    port: TWITCH_MOCK_PORT,
    hostname: "0.0.0.0",
    publicHost: run.ctx.env.HARNESS_WEBHOOK_HOST,
    t0Image: readFixture(fixturePath(FIXTURES.t0Csam)),
  });
  return run.mock;
}

/** Authorize through the API and follow the mock's redirect with the user's session (N3's way). */
async function connectTwitch(
  run: TwitchImportB8Extension,
  mock: TwitchMock,
  user: SignedInUser,
): Promise<string | null> {
  const { authorizeUrl } = await user.api.client.twitchImport.connect({ channel: slugOf(user) });
  const u = new URL(authorizeUrl);
  const res = await fetch(`${mock.origin}${u.pathname}${u.search}`, { redirect: "manual", signal: run.ctx.signal });
  const cb = new URL(res.headers.get("location") ?? "");
  const api = new URL(user.api.baseUrl);
  const back = await user.api.fetch(new Request(`${api.origin}${cb.pathname}${cb.search}`, { redirect: "manual" }));
  return new URL(back.headers.get("location") ?? "http://x/").searchParams.get("twitch");
}

async function importPage(run: TwitchImportB8Extension, user: SignedInUser): Promise<Page> {
  const { ctx } = run;
  const s = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label: "b8-field-choices",
    log: ctx.log,
  });
  run.sessions.push(s);
  await signInViaUi(await s.goto(ROUTES.signin), user, UI_TIMEOUT_MS, ctx.signal);
  return s.goto(IMPORT_ROUTE);
}

/** `field-choices`: a streamer of its own keeps two fields ticked; only those change. */
export async function stepFieldChoices(run: TwitchImportB8Extension): Promise<void> {
  const { ctx } = run;
  const mock = await twitchMock(run);
  const user = await ctx.step("field-choices: sign up a streamer", () => ctx.platform.signUp({ prefix: "b8_fields" }));
  const channel = slugOf(user);
  const before = { title: "Kept from before", description: "My own words", language: "fr" };
  await ctx.step("field-choices: the channel has its own details", () =>
    user.api.client.channels.update({ channel, ...before }),
  );
  const outcome = await ctx.step("field-choices: connect Twitch through the mock", () =>
    connectTwitch(run, mock, user),
  );
  ctx.assert("field-choices: connected", outcome === "connected", { outcome });
  const preview = await ctx.step("field-choices: read the preview", () =>
    user.api.client.twitchImport.preview({ channel }),
  );
  const fields = Object.fromEntries([
    ...FIELD_CHOICES_KEPT.map((f) => [f, true] as const),
    ...FIELD_CHOICES_UNTICKED.map((f) => [f, false] as const),
  ]);

  if (run.via === "web") {
    const page = await importPage(run, user);
    await ctx.step("field-choices: untick every field but title and tags, and every emote", async () => {
      await page.locator(tid("import-preview", { "import-id": preview.id })).waitFor({ timeout: UI_TIMEOUT_MS });
      for (const f of FIELD_CHOICES_UNTICKED) {
        const row = page.locator(tid("twitch-import-field", { field: f }));
        await row.locator('[data-slot="checkbox"]').click({ timeout: UI_TIMEOUT_MS });
        await page.locator(tid("twitch-import-field", { field: f, state: "off" })).waitFor({ timeout: UI_TIMEOUT_MS });
      }
      for (const f of FIELD_CHOICES_KEPT)
        await page.locator(tid("twitch-import-field", { field: f, state: "on" })).waitFor({ timeout: UI_TIMEOUT_MS });
      const ticked = page.locator(tid("import-emote")).locator('[data-slot="checkbox"][aria-checked="true"]');
      while ((await ticked.count()) > 0) await ticked.first().click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-start")).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid("import-progress", { status: "done" })).waitFor({ timeout: IMPORT_TIMEOUT_MS });
    });
  } else {
    await ctx.step("field-choices: start with title and tags only", () =>
      user.api.client.twitchImport.start({
        channel,
        id: preview.id,
        choices: { channel: true, fields, panels: false, emotes: [] },
        assertEmoteRights: false,
      }),
    );
  }
  const done = await ctx.step("field-choices: the worker applies it", () =>
    waitFor(
      "the field-choices import finished",
      async () => {
        const l = (await user.api.client.twitchImport.status({ channel })).latest;
        return l && l.id === preview.id && (l.status === "done" || l.status === "failed") ? l : null;
      },
      { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  ctx.assert("field-choices: the import finished", done.status === "done", { status: done.status });
  const c = await user.api.client.channels.get({ channel });
  const imported = preview.preview.channel;
  ctx.assert("field-choices: the title came from Twitch", c.title === TWITCH_FIXTURE.title, { title: c.title });
  ctx.assert("field-choices: the tags came from Twitch", JSON.stringify(c.tags) === JSON.stringify(imported.tags), {
    tags: c.tags,
  });
  ctx.assert(
    "field-choices: the unticked fields are as they were",
    c.description === before.description && c.language === before.language && c.category === null && !c.mature,
    { description: c.description === before.description, language: c.language, category: c.category, mature: c.mature },
  );
}

/** `import-expiry`: step 3's finished import, aged past 30 days, loses its Twitch data only. */
export async function stepImportExpiry(run: TwitchImportB8Extension): Promise<void> {
  const { ctx } = run;
  ctx.assert("import-expiry: step 3 finished an import", run.done !== null);
  const id = (run.done as { id: string }).id;
  const started = new Date();
  await ctx.step("import-expiry: age finished_at past 30 days", () =>
    withSql(run.databaseUrl, "import-expiry", (sql) =>
      sql`update portability_imports set finished_at = ${tsParam(new Date(Date.now() - 31 * DAY_MS))}::timestamptz
           where id = ${id}::uuid`.then(() => undefined),
    ),
  );
  const result = await ctx.step("import-expiry: run import-record-expiry now", () =>
    b8Tick(ctx, B8_JOBS.importRecordExpiry),
  );
  ctx.data("b8.importExpiry", result);
  ctx.assert("import-expiry: at least this import was cleared", (result.cleared ?? 0) >= 1, result);
  const row = await withSql(run.databaseUrl, "import-expiry", async (sql) => {
    const rows = await sql<
      {
        preview: string;
        result_null: boolean;
        status: string;
        source: string;
        finished_at: string | null;
        asserted: boolean;
      }[]
    >`
      select preview::text as preview, result is null as result_null, status::text as status,
             source::text as source, finished_at, asserted_at is not null as asserted
        from portability_imports where id = ${id}::uuid`;
    return rows[0] ?? null;
  });
  ctx.assert("import-expiry: the Twitch data is cleared", row?.preview === "{}" && row.result_null, row);
  ctx.assert(
    "import-expiry: the status, source, times and assertion stay",
    row?.status === "done" && row.source === "twitch" && toDate(row.finished_at) !== null && row.asserted,
    row,
  );
  const audit = await withSql(run.databaseUrl, "import-expiry", async (sql) => {
    const rows = await sql<{ details: string }[]>`
      select details::text as details from audit_log
       where action = 'portability.import.expire' and created_at >= ${tsParam(started)}::timestamptz
       order by created_at desc limit 1`;
    return rows[0]?.details ?? null;
  });
  ctx.assert("import-expiry: one audit row with a count", audit !== null && /"cleared":\s*[1-9]/.test(audit), audit);
  ctx.assert("import-expiry: the audit row names nobody", !(audit ?? "").includes(TWITCH_FIXTURE.login));
}

// ---------------------------------------------------------------------- federation

interface OwnChannel {
  owner: SignedInUser;
  slug: string;
  channelId: string;
  actorId: string;
  inbox: string;
}

async function federate(run: FederationB8Extension, prefix: string): Promise<OwnChannel> {
  const owner = await run.ctx.platform.signUp({ prefix });
  const slug = slugOf(owner);
  await owner.api.client.federation.settings.update({ channel: slug, enabled: true });
  const s = await owner.api.client.federation.settings.get({ channel: slug });
  if (!s.enabled || !s.actorId) throw new Error("actor-disabled-event: federation did not turn on");
  run.instanceOrigin ??= new URL(s.actorId).origin;
  return {
    owner,
    slug,
    channelId: s.actorId.split("/").pop() ?? "",
    actorId: s.actorId,
    inbox: rewriteToApi(`${s.actorId}/inbox`, run.instanceOrigin, run.apiUrl),
  };
}

/** Whether a received actor `Delete` has the id the API used to mint (`#delete-<uuid>`). */
export const apiMintedDelete = (id: unknown): boolean => typeof id === "string" && /#delete-[0-9a-f-]{36}$/.test(id);

/** Event types written for a channel since `since`. */
async function eventTypesSince(databaseUrl: string | undefined, channelId: string, since: Date): Promise<string[]> {
  return withSql(databaseUrl, "federation", async (sql) => {
    const rows = await sql<{ type: string }[]>`
      select type from events where channel_id = ${channelId}::uuid and occurred_at >= ${tsParam(since)}::timestamptz
       order by occurred_at, id`;
    return rows.map((r) => r.type);
  });
}

/**
 * `actor-disabled-event`: a channel of its own turns federation off; the peer receives one actor
 * `Delete`, sent by the worker from `channel.federation` (no `channel.update`), and the followers go.
 * Then the scenario's own channel (followed in step 3) is suspended: one `Delete` again, through the
 * suspension's fan-out, and no `federation.actor.disabled` beside it.
 */
export async function stepActorDisabledEvent(run: FederationB8Extension): Promise<void> {
  const { ctx } = run;
  const databaseUrl = ctx.env.DATABASE_URL;
  const peer = await run.peer();

  const own = await ctx.step("actor-disabled-event: a channel of its own federates and is followed", async () => {
    const ch = await federate(run, "b8fedoff");
    const { activity, response } = await peer.follow(ch.actorId, ch.inbox);
    ctx.assert("actor-disabled-event: the Follow is accepted (202)", response.status === 202, response.status);
    await peer.waitFor((r) => isAcceptOf(r, ch.actorId, String(activity.id)), DELIVERY_TIMEOUT_MS);
    return ch;
  });
  const fromOff = peer.received.length;
  const offAt = new Date();
  await ctx.step("actor-disabled-event: the streamer turns federation off", () =>
    own.owner.api.client.federation.settings.update({ channel: own.slug, enabled: false }),
  );
  await ctx.step("actor-disabled-event: the peer receives the actor Delete", () =>
    peer.waitFor(
      arrivedSince(peer.received)((r) => isActorDelete(r, own.actorId)),
      DELIVERY_TIMEOUT_MS,
    ),
  );
  await sleep(QUIET_WINDOW_MS, ctx.signal);
  const offDeletes = peer.since(fromOff, (r) => isActorDelete(r, own.actorId));
  ctx.assert("actor-disabled-event: exactly one Delete", offDeletes.length === 1, { deletes: offDeletes.length });
  ctx.assert(
    "actor-disabled-event: sent by the worker from the event, not queued by the API",
    offDeletes.every((r) => !apiMintedDelete(r.json?.id)),
    offDeletes.map((r) => r.json?.id),
  );
  const types = await eventTypesSince(databaseUrl, own.channelId, offAt);
  ctx.assert("actor-disabled-event: channel.federation was written", types.includes("channel.federation"), types);
  ctx.assert("actor-disabled-event: no channel.update for the toggle", !types.includes("channel.update"), types);
  await ctx.step("actor-disabled-event: the worker removes the followers", () =>
    waitFor(
      "the turned-off channel's followers removed",
      async () =>
        (
          await withSql(
            databaseUrl,
            "federation",
            (sql) =>
              sql<
                { n: number }[]
              >`select count(*)::int as n from federation_followers where channel_id = ${own.channelId}::uuid`,
          )
        )[0]?.n === 0,
      { timeoutMs: DELIVERY_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );

  // The suspension: the scenario's channel, followed by step 3.
  const shared = await run.channel();
  if (databaseUrl === undefined) throw new Error("actor-disabled-event: DATABASE_URL is not set (the admin role)");
  const signedUp = await ctx.platform.signUp({ prefix: "b8fedmod" });
  await grantRole(databaseUrl, signedUp.username, "admin", ROLE_CLI_TIMEOUT_MS);
  const admin = await ctx.platform.users.signIn(signedUp);
  const suspend = (suspended: boolean) =>
    admin.api.client.safety.suspend({
      username: shared.owner.username,
      target: "channel",
      suspended,
      reason: "harness b8 federation",
      ...(suspended ? { clauseId: STAFF_CLAUSE } : {}),
    });
  const fromSus = peer.received.length;
  const susAt = new Date();
  await ctx.step("actor-disabled-event: an admin suspends the followed channel", () => suspend(true));
  ctx.defer(() => suspend(false).catch(() => undefined));
  await ctx.step("actor-disabled-event: the peer receives the actor Delete after the suspension", () =>
    peer.waitFor(
      arrivedSince(peer.received)((r) => isActorDelete(r, shared.actorId)),
      DELIVERY_TIMEOUT_MS,
    ),
  );
  await sleep(QUIET_WINDOW_MS, ctx.signal);
  const susDeletes = peer.since(fromSus, (r) => isActorDelete(r, shared.actorId));
  ctx.assert("actor-disabled-event: one Delete for the suspension", susDeletes.length === 1, {
    deletes: susDeletes.length,
  });
  ctx.assert(
    "actor-disabled-event: none queued by the API",
    susDeletes.every((r) => !apiMintedDelete(r.json?.id)),
    susDeletes.map((r) => r.json?.id),
  );
  const susTypes = await eventTypesSince(databaseUrl, shared.channelId, susAt);
  ctx.assert(
    "actor-disabled-event: the suspension writes channel.suspension and no second actor event",
    susTypes.includes("channel.suspension") && !susTypes.includes("federation.actor.disabled"),
    susTypes,
  );
}

// ---------------------------------------------------------------------- portability

/** An empty zip: the cleanup never reads the archive. */
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array.from({ length: 18 }, () => 0)]);

/**
 * `incoming-cleanup`: two uploaded archives, each named by a `previewed` import; one is aged past
 * 24 h in the database. `portability-incoming-cleanup` deletes the abandoned one's archive and
 * clears its key; the fresh one keeps both.
 */
export async function stepIncomingCleanup(run: PortabilityB8Extension): Promise<void> {
  const { ctx } = run;
  const user = await ctx.step("incoming-cleanup: sign up a streamer", () => ctx.platform.signUp({ prefix: "b8inc" }));
  const channel = slugOf(user);
  const channelId = await channelIdOf(user);
  const upload = async () => {
    const up = await user.api.client.portability.imports.upload({ channel, sizeBytes: EMPTY_ZIP.byteLength });
    await putPresigned(up.uploadUrl, up.headers, EMPTY_ZIP, ctx.signal);
    return up.key;
  };
  const [oldKey, freshKey] = await ctx.step("incoming-cleanup: upload two archives", () =>
    Promise.all([upload(), upload()]),
  );
  const [abandoned, fresh] = await ctx.step("incoming-cleanup: an abandoned and a fresh preview", () =>
    withSql(run.databaseUrl, "incoming-cleanup", async (sql) => {
      const row = async (key: string, createdAt: Date) =>
        (
          await sql<{ id: string }[]>`
            insert into portability_imports (user_id, channel_id, source, status, archive_key, created_at, updated_at)
            values (${user.id}::uuid, ${channelId}::uuid, 'commonair', 'previewed', ${key},
                    ${tsParam(createdAt)}::timestamptz, ${tsParam(createdAt)}::timestamptz)
            returning id::text as id`
        )[0]?.id ?? "";
      return Promise.all([row(oldKey, new Date(Date.now() - 25 * 3_600_000)), row(freshKey, new Date())]);
    }),
  );
  const result = await ctx.step("incoming-cleanup: run portability-incoming-cleanup now", () =>
    b8Tick(ctx, B8_JOBS.incomingCleanup),
  );
  ctx.data("b8.incomingCleanup", result);
  ctx.assert("incoming-cleanup: at least the abandoned archive went", (result.deleted ?? 0) >= 1, result);
  const keys = await withSql(
    run.databaseUrl,
    "incoming-cleanup",
    (sql) =>
      sql<{ id: string; archive_key: string | null; status: string }[]>`
      select id::text as id, archive_key, status::text as status from portability_imports
       where id in (${abandoned}::uuid, ${fresh}::uuid)`,
  );
  const of = (id: string) => keys.find((k) => k.id === id);
  ctx.assert("incoming-cleanup: the abandoned import's key is cleared", of(abandoned)?.archive_key === null, keys);
  ctx.assert("incoming-cleanup: the fresh upload is kept", of(fresh)?.archive_key === freshKey, keys);
  ctx.assert(
    "incoming-cleanup: the abandoned preview is failed, the fresh one still previewed",
    of(abandoned)?.status === "failed" && of(fresh)?.status === "previewed",
    keys,
  );
}

// ---------------------------------------------------------------------- data export

/** Problems with `interact-giveaways.json` for the caller; empty when it holds only their rows. */
export function giveawayFileProblems(
  value: unknown,
  want: { title: string; pseudonym: string; rank: number },
  secrets: readonly string[],
): string[] {
  const out: string[] = [];
  const v = value as { entries?: Record<string, unknown>[]; wins?: Record<string, unknown>[] } | null;
  if (!v || !Array.isArray(v.entries) || !Array.isArray(v.wins)) return ["shape"];
  if (v.entries.length !== 1) out.push(`entries ${v.entries.length}`);
  const e = v.entries[0];
  if (e?.giveawayTitle !== want.title) out.push("entry title");
  if (e?.pseudonym !== want.pseudonym) out.push("entry pseudonym");
  if (v.wins.length !== 1 || v.wins[0]?.rank !== want.rank) out.push("wins");
  const text = JSON.stringify(v);
  for (const s of secrets) if (s && text.includes(s)) out.push("a secret or another member's row");
  return out;
}

/**
 * `giveaway-section`: a drawn giveaway the caller entered and won, and another member's entry,
 * written in the database (giveaways stay off on this stack); the caller's account export holds
 * their entry and win only: no other pseudonym, no salt, no seed.
 */
export async function stepGiveawaySection(kit: DataExportB8Extension): Promise<void> {
  const { ctx } = kit;
  const [streamer, me, other] = await ctx.step("giveaway-section: sign up a streamer and two entrants", () =>
    Promise.all([
      ctx.platform.signUp({ prefix: "b8gws" }),
      ctx.platform.signUp({ prefix: "b8gwme" }),
      ctx.platform.signUp({ prefix: "b8gwot" }),
    ]),
  );
  const channelId = await channelIdOf(streamer);
  const seed = newSeed();
  const salt = newSalt();
  const title = `Harness ${crypto.randomUUID().slice(0, 8)}`;
  const mine = `p${crypto.randomUUID().replaceAll("-", "")}`;
  const theirs = `p${crypto.randomUUID().replaceAll("-", "")}`;
  await ctx.step("giveaway-section: a drawn giveaway both entered, the caller won", async () => {
    const commitment = await commit(seed);
    await withSql(kit.databaseUrl, "giveaway-section", async (sql) => {
      const [g] = await sql<{ id: string }[]>`
        insert into giveaways (channel_id, title, prize, eligibility, winner_count, seed_commitment, sealed_seed, salt)
        values (${channelId}::uuid, ${title}, 'a mug',
                ${JSON.stringify({ minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 })}::jsonb,
                1, ${commitment}, 'v1.harness', ${salt})
        returning id::text as id`;
      const id = g?.id ?? "";
      await sql`insert into giveaway_entries (giveaway_id, user_id, pseudonym)
                values (${id}::uuid, ${me.id}::uuid, ${mine}), (${id}::uuid, ${other.id}::uuid, ${theirs})`;
      await sql`update giveaways set status = 'closed', closed_at = now() where id = ${id}::uuid`;
      await sql.begin(async (tx) => {
        await tx`update giveaways set seed = ${seed} where id = ${id}::uuid`;
        await tx`insert into giveaway_winners (giveaway_id, user_id, rank, draw_index) values (${id}::uuid, ${me.id}::uuid, 1, 0)`;
        await tx`update giveaways set status = 'drawn', drawn_at = now() where id = ${id}::uuid`;
      });
    });
  });
  const exportId = await ctx.step(
    "giveaway-section: the caller requests an account export",
    async () => (await me.api.client.me.exports.create({ kind: "account" })).id,
  );
  await ctx.step("giveaway-section: the export is ready", () =>
    waitFor(
      `export ${exportId} ready`,
      async () => {
        const job = (await me.api.client.me.exports.list()).find((e) => e.id === exportId);
        if (job?.status === "failed") throw new Error("the export failed");
        return job?.status === "ready" ? job : null;
      },
      { timeoutMs: EXPORT_READY_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  const message = await ctx.platform.mailpit.waitForMessage(
    me.email,
    (m) => exportLinkIn(extractLinks(m), me.id, exportId) !== null,
    60_000,
  );
  const link = exportLinkIn(extractLinks(message), me.id, exportId);
  if (!link) throw new Error("giveaway-section: the export email has no link for this export");
  const res = await ctx.step("giveaway-section: download it", () =>
    fetch(link, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]) }),
  );
  ctx.assert("giveaway-section: the archive downloads", res.status === 200, res.status);
  if (res.status !== 200) return;
  const file = jsonEntry(readZip(new Uint8Array(await res.arrayBuffer())), "interact-giveaways.json");
  const problems = giveawayFileProblems(file, { title, pseudonym: mine, rank: 1 }, [theirs, salt, seed, other.id]);
  ctx.assert("giveaway-section: the caller's own entry and win only, no salt", problems.length === 0, problems);
}

// ---------------------------------------------------------------------- trust-safety

/**
 * `sor-staff-action`: a moderator's account suspension (no moderation case) gets a statement with
 * `staff_action` facts; its email names the action and cites no case.
 */
export const sorStaffActionExtension: SafetyB8Extension = {
  async before(_run: Run): Promise<unknown> {
    return undefined;
  },
  async after(run: Run, _before: unknown): Promise<void> {
    const { ctx } = run;
    const target = await ctx.step("sor-staff-action: sign up the account staff suspend", () =>
      ctx.platform.signUp({ prefix: "ts_b8_staff" }),
    );
    run.emails.push(target.email);
    const suspend = (suspended: boolean) =>
      run.staff.mod.api.client.safety.suspend({
        username: target.username,
        target: "user",
        suspended,
        reason: "harness b8 staff action",
        ...(suspended ? { durationSeconds: 3_600, clauseId: STAFF_CLAUSE } : {}),
      });
    const at = new Date();
    await ctx.step("sor-staff-action: a moderator suspends the account", () => suspend(true));
    ctx.defer(() => suspend(false).catch(() => undefined));
    const auditId = await withSql(run.databaseUrl, "sor-staff-action", async (sql) => {
      const rows = await sql<{ id: string }[]>`
        select id::text as id from audit_log
         where action = 'user.suspend' and details ->> 'userId' = ${target.id}
           and created_at >= ${tsParam(new Date(at.getTime() - 60_000))}::timestamptz
         order by created_at desc limit 1`;
      return rows[0]?.id ?? null;
    });
    ctx.assert("sor-staff-action: the suspension is audited", auditId !== null);
    if (!auditId) return;
    const facts = await ctx.step("sor-staff-action: the builder writes the statement", () =>
      waitFor(
        "a statement for the staff suspension",
        async () => {
          const facts = await withSql(run.databaseUrl, "sor-staff-action", async (sql) => {
            const rows = await sql<{ facts: string }[]>`
              select facts::text as facts from enforcement_statements where source_audit_id = ${auditId}::uuid`;
            return rows.map((r) => JSON.parse(r.facts) as Record<string, unknown>);
          });
          return facts.length > 0 ? facts : null;
        },
        { timeoutMs: STATEMENT_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
      ),
    );
    ctx.assert("sor-staff-action: one statement", facts.length === 1, facts);
    const f = facts[0];
    ctx.assert(
      "sor-staff-action: staff_action facts (the action, clause and time), no case",
      f?.code === "staff_action" && f.action === "user.suspend" && f.clauseId === STAFF_CLAUSE && !("caseId" in f),
      f,
    );
    const mail = await ctx.step("sor-staff-action: the statement email arrives", () =>
      ctx.platform.mailpit.waitForMessage(
        target.email,
        (m) => /statement of reasons/i.test(m.subject),
        STATEMENT_TIMEOUT_MS,
      ),
    );
    ctx.assert("sor-staff-action: the email cites no case", !CASE_REF.test(mail.text), mail.subject);
    ctx.assert("sor-staff-action: the email names the action", /suspended the account/.test(mail.text), mail.subject);
  },
};

/**
 * `lapsed-ban-signin`: a timed suspension through the audited path, its expiry moved into the past
 * in the database; two sign-ins at once clear it, and exactly one `channel.suspension
 * {suspended:false}` follows the `true` (decision (g)).
 */
export const lapsedBanSigninExtension: SafetyB8Extension = {
  async before(_run: Run): Promise<unknown> {
    return undefined;
  },
  async after(run: Run, _before: unknown): Promise<void> {
    const { ctx } = run;
    const user = await ctx.step("lapsed-ban-signin: sign up an account", () =>
      ctx.platform.signUp({ prefix: "ts_b8_lapse" }),
    );
    run.emails.push(user.email);
    const channelId = await channelIdOf(user);
    await ctx.step("lapsed-ban-signin: a moderator suspends it for an hour", () =>
      run.staff.mod.api.client.safety.suspend({
        username: user.username,
        target: "user",
        suspended: true,
        reason: "harness b8 lapsed ban",
        durationSeconds: 3_600,
        clauseId: STAFF_CLAUSE,
      }),
    );
    ctx.assert(
      "lapsed-ban-signin: the suspension's event",
      (await suspensionsOf(run.databaseUrl, channelId)).at(-1) === true,
    );
    await ctx.step("lapsed-ban-signin: the ban lapses (its expiry moved into the past)", () =>
      withSql(run.databaseUrl, "lapsed-ban-signin", (sql) =>
        sql`update users set ban_expires = ${tsParam(new Date(Date.now() - 60_000))}::timestamptz
             where id = ${user.id}::uuid and banned`.then(() => undefined),
      ),
    );
    const signIns = await ctx.step("lapsed-ban-signin: two sign-ins at once", () =>
      Promise.allSettled([ctx.platform.users.signIn(user), ctx.platform.users.signIn(user)]),
    );
    ctx.assert(
      "lapsed-ban-signin: both sign in",
      signIns.every((s) => s.status === "fulfilled"),
      signIns.map((s) => s.status),
    );
    const after = await ctx.step("lapsed-ban-signin: the unsuspension is written", () =>
      waitFor(
        "channel.suspension {suspended:false}",
        async () => {
          const s = await suspensionsOf(run.databaseUrl, channelId);
          return s.at(-1) === false ? s : null;
        },
        { timeoutMs: 30_000, intervalMs: 1_000, signal: ctx.signal },
      ),
    );
    await sleep(ONCE_WINDOW_MS, ctx.signal);
    const final = await suspensionsOf(run.databaseUrl, channelId);
    ctx.assert("lapsed-ban-signin: exactly one unsuspension", JSON.stringify(final) === JSON.stringify([true, false]), {
      first: after,
      final,
    });
  },
};
