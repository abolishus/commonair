// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-platform: OAuth apps and tokens, EventSub, webhooks, notifications, push and Discord. Brief: `.claude/briefs/seed-full/seed-platform.md`. */
import { startReceiver } from "../e9/receiver.ts";
import { Mailpit, findTokenLink } from "../mailpit.ts";
import { startPushReceiver } from "../n1/push-receiver.ts";
import { waitFor } from "../wait.ts";
import {
  PUSH_FIX,
  PlatformSessions,
  createApps,
  pkcePair,
  seedBot,
  seedGrants,
  seedPush,
  startDevice,
  step,
  subscribe,
  suspendApps,
  triggerEvents,
  waitDeliveries,
} from "./platform/api.ts";
import { FEDERATION_FIX, seedFederation } from "./platform/federation.ts";
import { TWITCH_FIX, seedImports } from "./platform/portability.ts";
import { MINUTE_MS, planPlatform } from "./platform/plan.ts";
import { buildActivateQuery, buildAuthorizeQuery, parseUnsubscribeLink } from "./platform/queries.ts";
import { closedPort, startDiscordSink } from "./platform/sinks.ts";
import {
  deliveryStates,
  emailDigestMinutes,
  insertDeviceCode,
  queuedEmails,
  readWorld,
  tableCounts,
  writeDiscordWebhooks,
  writeEmailQueue,
  writeNotificationRows,
} from "./platform/write.ts";
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "oauth_apps",
  "oauth_codes",
  "oauth_tokens",
  "oauth_device_codes",
  "event_subscriptions",
  "webhook_deliveries",
  "notifications",
  "notification_preferences",
  "notification_go_live_sends",
  "notification_email_queue",
  "push_subscriptions",
  "discord_webhooks",
  // Batch 7: portability imports and keys, federation.
  "portability_imports",
  "portability_signing_keys",
  "federation_actors",
  "federation_actor_keys",
  "federation_followers",
  "federation_domain_blocks",
  "federation_inbox_items",
  "federation_deliveries",
  "federation_objects",
] as const;

/** The digest sweep runs every 30 s; allow a few sweeps on a loaded stack. */
const DIGEST_TIMEOUT_MS = 120_000;

/** What seed-platform publishes as `store.extra.platform` (the keys its brief names). */
export interface PlatformExtra {
  /** developer's main app (`/developer/apps/$appId`). */
  appId: string;
  /** A valid `/oauth2/authorize` query for an app viewer1 has not authorized (streamer1's bot app). */
  authorizeQuery: string;
  /** `/activate?code=…` with a pending device code that outlives the run (`code=XXXX-XXXX`). */
  activateQuery: string;
  /** A signed one-click unsubscribe link the worker mailed to viewer1 (`list=go_live&token=…`). */
  unsubscribeQuery: string;
}

export const unit: SeedUnit = {
  name: "platform",
  // media: the go-live email digest needs a real broadcast (`notification_email_queue.broadcast_id`)
  // and the federation activity toggles one of streamer1's recorded VODs.
  after: ["social", "media"],
  tables: TABLES,
  pending: [],
  async run(ctx) {
    const { env, signal } = ctx;
    const progress = (line: string) => ctx.log.info(`seed-platform: ${line}`);
    // Flags first: fail at once with the exact fix.
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret)
      throw new Error(
        "seed-platform: AUTH_SECRET is not set: run from the repo root so Bun loads .env (the Discord webhook URLs are encrypted with the stack's AUTH_SECRET)",
      );
    const sessions = new PlatformSessions(env, ctx.password, ctx.store.users, signal);
    const viewer1 = await sessions.as("viewer1");
    const push = await step("viewer1", "read the push status", () => viewer1.api.client.notifications.push.status());
    if (!push.enabled || push.vapidPublicKey === null) throw new Error(`seed-platform: ${PUSH_FIX}`);
    const slugOf = (h: string) => {
      const c = ctx.store.channels.find((x) => x.ownerHandle === h);
      if (c) return c.slug;
      const u = ctx.store.users.find((x) => x.handle === h);
      if (!u) throw new Error(`seed-platform: no channel for ${h}`);
      return u.username; // Every human has a channel named after them (signup's ensureChannel).
    };
    const s1 = ctx.store.channels.find((c) => c.ownerHandle === "streamer1");
    if (!s1) throw new Error("seed-platform: streamer1 has no channel (seed-social runs first)");
    const streamer1 = await sessions.as("streamer1");
    const fed = await step("streamer1", "read federation settings", () =>
      streamer1.api.client.federation.settings.get({ channel: s1.slug }),
    );
    if (!fed.instanceEnabled) throw new Error(`seed-platform: ${FEDERATION_FIX}`);
    const streamer3 = await sessions.as("streamer3");
    const tw = await step("streamer3", "read the Twitch import status", () =>
      streamer3.api.client.twitchImport.status({ channel: slugOf("streamer3") }),
    );
    if (!tw.available) throw new Error(`seed-platform: ${TWITCH_FIX}`);

    const world = await readWorld(ctx.db, ctx.store);
    const plan = planPlatform(ctx.rng, ctx.scale, world, ctx.now);
    const ids = new Map(ctx.store.users.map((u) => [u.handle, u.id]));
    const before = await tableCounts(ctx.db, TABLES);
    const notes: string[] = [];
    const rows: Record<string, number> = {};

    // Local peers for the life of the unit.
    const host = env.HARNESS_WEBHOOK_HOST;
    const receiver = startReceiver({ webhookHost: host });
    const flaky = startReceiver({ webhookHost: host });
    let flakyOpen = true;
    const pushSink = startPushReceiver({ webhookHost: host });
    const discordSink = startDiscordSink({ webhookHost: host });
    try {
      // Apps, grants, the bot, device codes ---------------------------------------------------
      const apps = await createApps(sessions, plan.apps, signal);
      progress(`${apps.size} apps registered`);
      await suspendApps(sessions, plan.apps, apps);
      const grants = await seedGrants(env, sessions, plan, apps, signal);
      await seedBot(sessions, plan.bot);
      const deviceApp = apps.get(plan.device.appKey);
      const mainApp = apps.get("dev-web");
      const consentApp = apps.get(plan.authorize.appKey);
      if (!deviceApp || !mainApp || !consentApp) throw new Error("seed-platform: a named app was not created");
      const started = await startDevice(env, deviceApp, plan.device.scopes, signal);
      const direct = await insertDeviceCode(ctx.db, {
        appId: deviceApp.id,
        scopes: plan.device.scopes,
        now: new Date(),
        expiresInDays: plan.device.directExpiresInDays,
      });
      const { challenge } = await pkcePair();

      // EventSub: subscribe, verify, then make the flaky receiver go away and trigger events.
      const closed = `http://${host}:${await closedPort()}/hook`;
      const subs = await subscribe(
        sessions,
        plan.subscriptions,
        apps,
        ids,
        { receiver, flaky, closedUrl: closed },
        signal,
      );
      await flaky.close();
      flakyOpen = false;
      const triggered = await triggerEvents(sessions, plan, subs, s1.slug, signal);
      await waitDeliveries(
        sessions,
        subs.filter((s) => s.target === "receiver"),
        signal,
      );
      const subIds = subs.map((s) => s.id);
      const states = await waitFor(
        "delivered, failed and retrying webhook deliveries",
        async () => {
          const st = await deliveryStates(ctx.db, subIds);
          return st.delivered > 0 && st.failed > 0 && st.retrying > 0 ? st : null;
        },
        { timeoutMs: 90_000, intervalMs: 1_000, signal },
      ).catch(() => deliveryStates(ctx.db, subIds));
      if (states.delivered === 0) throw new Error("seed-platform: no webhook delivery succeeded");
      if (states.failed === 0 || states.retrying === 0)
        notes.push(
          `seed-platform: webhook deliveries are ${JSON.stringify(states)}; a state is missing (the retries may still be queued)`,
        );
      progress(`webhook deliveries ${JSON.stringify(states)} from ${JSON.stringify(triggered)}`);

      // Notifications (plain tables) and the drained email queue -------------------------------
      const direct1 = await writeNotificationRows(ctx.db, plan, ids, { signal });
      for (const s of plan.emailQueue)
        await step(
          "viewer1",
          `turn the bell on for ${s.slug}`,
          () => viewer1.api.client.channels.follow({ channel: s.slug, notify: true }),
          signal,
        );
      if (plan.emailQueue.length === 0)
        throw new Error("seed-platform: no recorded broadcast to queue a go-live email for (seed-media runs first)");
      const windowMin = await emailDigestMinutes(ctx.db);
      const queued = await writeEmailQueue(
        ctx.db,
        plan.emailQueue,
        ids,
        new Date(Date.now() - windowMin * MINUTE_MS - MINUTE_MS),
      );
      const v1Id = ids.get("viewer1") ?? "";
      await waitFor(
        "the go-live digest sweep drained viewer1's queue",
        async () => (await queuedEmails(ctx.db, v1Id)) === 0 || null,
        {
          timeoutMs: DIGEST_TIMEOUT_MS,
          intervalMs: 2_000,
          signal,
        },
      );
      const mailpit = new Mailpit(env.HARNESS_MAILPIT_URL, env.HARNESS_MAILPIT_AUTH);
      const mail = await mailpit.waitForMessage(
        viewer1.email,
        (m) => findTokenLink(m, /unsubscribe\?list=go_live/) !== null,
        60_000,
      );
      const link = findTokenLink(mail, /unsubscribe\?list=go_live/);
      const unsubscribeQuery = link ? parseUnsubscribeLink(link) : null;
      if (!unsubscribeQuery) throw new Error("seed-platform: the go-live digest carries no unsubscribe link");

      // Push and Discord ------------------------------------------------------------------------
      await seedPush(sessions, plan, pushSink);
      const discord = await writeDiscordWebhooks(ctx.db, plan.discord, ids, {
        authSecret,
        sinkOrigin: discordSink.origin,
      });

      // Federation and imports (independent: run side by side) --------------------------------
      // Both settle before either failure is thrown, so neither leaves a peer running.
      const [fedSettled, importsSettled] = await Promise.allSettled([
        seedFederation(ctx.db, sessions, plan.federation, {
          apiUrl: env.HARNESS_API_URL,
          webhookHost: host,
          channelId: s1.id,
          slug: s1.slug,
          signal,
        }),
        seedImports(sessions, plan.portability, slugOf, { webhookHost: host, signal }),
      ]);
      if (fedSettled.status === "rejected") throw fedSettled.reason;
      if (importsSettled.status === "rejected") throw importsSettled.reason;
      const fedResult = fedSettled.value;
      const imports = importsSettled.value;
      notes.push(...fedResult.notes);

      ctx.store.extra.platform = {
        appId: mainApp.id,
        authorizeQuery: buildAuthorizeQuery({
          clientId: consentApp.clientId,
          redirectUri: consentApp.redirectUri,
          scopes: plan.authorize.scopes,
          state: plan.authorize.state,
          codeChallenge: challenge,
        }),
        activateQuery: buildActivateQuery(direct.userCode),
        unsubscribeQuery,
      } satisfies PlatformExtra;

      const after = await tableCounts(ctx.db, TABLES);
      for (const t of TABLES) rows[t] = (after[t] ?? 0) - (before[t] ?? 0);
      // Drained by the worker, as it should be: report what was queued.
      rows.notification_email_queue = queued;
      notes.push(
        `seed-platform: ${sessions.signedIn} accounts signed in; ${grants.granted} grants (${grants.revoked} revoked); direct inserts ${JSON.stringify({ ...direct1, discord_webhooks: discord })}`,
        `seed-platform: the API's device code (${started.expiresIn} s) expires during the run; activateQuery names a second pending code inserted directly with a ${plan.device.directExpiresInDays}-day expiry. The coverage visit must still happen before it lapses`,
        "seed-platform: EventSub subscriptions point at a receiver that stopped when the unit finished; later deliveries fail and retry, then the worker fails the subscription. One subscription points at a closed port and failed its verification",
        "seed-platform: the ActivityPub peers, the Twitch mock, the push sink and the Discord sink stopped when the unit finished; deliveries to them fail from then on",
        "seed-platform: discord_webhooks rows are inserted directly (the API accepts discord.com URLs only) and point at the local sink; the worker refuses non-Discord URLs, so no go-live post is made",
        `seed-platform: notification_email_queue was drained by the worker's digest sweep (${queued} queued, 0 left); the digest is in Mailpit and unsubscribeQuery comes from it`,
        "seed-platform: notifications, preferences and go-live send history are backdated inside the prune job's horizons (90 days, 30 for read go-live rows); oauth, eventsub, federation and import rows carry today's times",
        `seed-platform: streamer3's Twitch import finished ${imports.twitch.status}${imports.bundle ? `; the bundle import finished ${imports.bundle.status} (standing verified: ${String(imports.bundle.standingVerified)})` : "; no bundle round trip (fewer than two bulk streamers)"}. The Twitch category is not matched (the fixture category is not seeded)`,
        "seed-platform: /import is filled for streamer3 (the brief's importer); routes.ts signs /import in as streamer1",
        `seed-platform: federation: ${fedResult.followers} peer followers, ${fedResult.blocked} blocked, ${fedResult.rotated} key(s) rotated`,
      );
      return { rows, notes };
    } finally {
      await Promise.allSettled([
        receiver.close(),
        flakyOpen ? flaky.close() : Promise.resolve(),
        pushSink.close(),
        discordSink.close(),
      ]);
    }
  },
};
