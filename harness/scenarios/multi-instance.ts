// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two of each app service (ADR 0032 stage 2, rehearsed on one host): `api-2`, `chat-2`,
 * `worker-2` and `origin-2` from `harness/compose.multi-instance.yaml` (profile `multi`) next to
 * the originals. One step per replica-safety claim, each a soft check so one finding does not
 * hide the rest:
 *
 * - shared rate limits: the `auth` bucket (10 a minute per address) counts across api-1 and api-2;
 * - chat across instances: messages sent on chat-1 reach chat-2 and back, in one order;
 * - chat cache staleness: a ban and a slow-mode change made through the API take effect on both
 *   chat instances, timed per instance against the directory's TTLs;
 * - outbox exactly-once: events written through both APIs, plus a backlog, each relayed once;
 * - viewer counts: viewers heartbeating to api-1 and api-2 counted once each, the same on both;
 * - recurring jobs: a BullMQ scheduler's ticks run once each with two workers;
 * - one issuance leader: one origin computes relay issuance per tick (Valkey MONITOR);
 * - reconnect on instance loss: chat-2 is killed, its clients reconnect to chat-1 with the web
 *   client's backoff, and no message acknowledged before the kill is missing from history;
 * - worker loss: worker-2 is killed mid-backlog, worker-1 drains it.
 *
 * Every claim gets its weighted share of the time left (`ClaimBudget`), so one claim at its worst
 * case cannot push the rest past the scenario timeout. Without the replicas running, every step
 * is skipped with the reason (start the stack with
 * the override and `--profile multi`; see harness/README.md). Killed replicas are restored and
 * health-checked before the scenario ends.
 */
import type { Api } from "../src/api/client.ts";
import { createApi } from "../src/api/client.ts";
import { CookieJar } from "../src/api/cookies.ts";
import { ChatClient } from "../src/chat-client.ts";
import { HttpViewer } from "../src/http-viewer.ts";
import { percentile } from "../src/metrics.ts";
import { ClaimBudget } from "../src/multi/budget.ts";
import { chatUrlFor, connectOn, sendClassified, sendUntilRejected } from "../src/multi/chat.ts";
import { DeliveryCounter, exactlyOnce, perSenderOrderKept, withinOneBatch } from "../src/multi/exactly-once.ts";
import { oncePerTick, schedulerReport } from "../src/multi/jobs.ts";
import {
  type MonitorHandle,
  DOUBLE_LEADER_WINDOW_MS,
  ISSUANCE_INTERVAL_MS,
  ISSUANCE_LOCK_KEY,
  issuanceReport,
  startMonitor,
} from "../src/multi/monitor.ts";
import { insertOutboxBacklog, unpublishedCount } from "../src/multi/outbox-db.ts";
import { healthy, killContainer, listReplicaContainers, restoreContainer } from "../src/multi/podman-ops.ts";
import { ReconnectingChat } from "../src/multi/reconnecting-chat.ts";
import { type ReplicaContainer, containerOf, missingReplicas, replicaUrls } from "../src/multi/replicas.ts";
import { completedSchedulerRuns, listenToBus, oldestCompleted } from "../src/multi/valkey.ts";
import { startForwardingProxy } from "../src/proxy.ts";
import { errorMessage } from "../src/redact.ts";
import { type ScenarioContext, defineScenario } from "../src/scenario.ts";
import type { Need } from "../src/scenario.ts";
import type { SignedInUser } from "../src/users.ts";
import { AUTH_ROUTES } from "../src/users.ts";
import { sleep, waitFor } from "../src/wait.ts";

/** Chat directory TTLs (services/chat/src/directory.ts): standing (bans) and channel (settings). */
export const STANDING_TTL_MS = 30_000;
export const CHANNEL_TTL_MS = 60_000;
/** The API's `auth` bucket (services/api/src/lib/ratelimit.ts). */
export const AUTH_LIMIT = 10;
/** The outbox relay's batch (services/worker/src/outbox.ts). */
export const OUTBOX_BATCH = 200;
/** live-counters runs every 10 s (services/worker/src/jobs/live-counters.ts). */
export const LIVE_COUNTERS_EVERY_MS = 10_000;
export const SCORE_SESSIONS_EVERY_MS = 15_000;

/** The claims, in run order; each is one step (or one skipped step). */
export const CLAIMS = [
  "shared rate limits (auth bucket across api-1 and api-2)",
  "chat across instances",
  "chat cache staleness (ban and slow mode on both instances)",
  "outbox exactly-once with two workers",
  "viewer counts with two APIs",
  "recurring jobs once per tick",
  "one issuance leader per tick",
  "reconnect on chat instance loss",
  "worker loss mid-backlog",
] as const;

export const SCENARIO_TIMEOUT_MS = 10 * 60_000;
/** Kept back from the claims for the restores and defers at the end. */
export const TEARDOWN_RESERVE_MS = 45_000;
/** In-claim restore of a killed replica; the defer retries with longer if it is still down. */
const RESTORE_MS = 30_000;
/** Rows in the worker-loss backlog. */
export const WORKER_LOSS_BACKLOG = 10_000;
/**
 * Each claim's worst case (ms), in `CLAIMS` order: the sum of its own waits plus a little work.
 * They and the reserve fit the timeout (tests/multi-budget.test.ts), and the budget shares the
 * time actually left by these weights.
 */
export const CLAIM_WEIGHTS_MS = [
  15_000, // rate limits: 12 requests
  20_000, // chat across: 10 s delivery wait
  CHANNEL_TTL_MS + 15_000, // cache staleness: ban, slow mode and empty room run side by side
  55_000, // outbox: 45 s drain + 2 s repeats
  115_000, // viewers: 40 s live + 30 s first frame + 40 s converge
  10_000, // recurring jobs: reads only
  30_000, // issuance: the monitor has watched since the start; tops up to 75 s observed
  70_000, // reconnect: 20 s reconnect + 10 s live + 2 s flush + 30 s restore
  135_000, // worker loss: 20 s start + 75 s drain + 2 s repeats + 30 s restore
] as const satisfies readonly number[];

interface Kit {
  ctx: ScenarioContext;
  tag: string;
  urls: ReturnType<typeof replicaUrls>;
  containers: ReplicaContainer[];
  /** A client of api-2 (through its own forwarding proxy), sharing `jar` when given. */
  api2: (o?: { jar?: CookieJar; clientIp?: string }) => Api;
  bus: DeliveryCounter;
  monitor: MonitorHandle | null;
  monitorError: string | null;
  /** When MONITOR started watching (epoch ms). */
  monitorAt: number;
  startedAt: number;
  budget: ClaimBudget;
}

export default defineScenario({
  name: "multi-instance",
  description:
    "two of each app service (api, chat, worker, origin): shared rate limits, chat fan-out and cache invalidation across instances, outbox exactly-once, viewer counts, recurring jobs, one issuance leader, chat reconnect and worker loss after podman kill",
  // Mail for the signups' verification links. Media and ffmpeg only for viewer counts, which is
  // skipped with the reason when they are missing.
  needs: ["api", "chat", "worker", "origin", "mail", "podman"],
  inFull: true,
  timeoutMs: SCENARIO_TIMEOUT_MS,
  async run(ctx) {
    const startedAt = Date.now();
    const urls = replicaUrls(process.env);
    const containers = await ctx.step("find the replicas (podman ps)", () =>
      listReplicaContainers(ctx.env.HARNESS_CONTAINER_PREFIX),
    );
    const reason = await notReady(urls, containers);
    if (reason) {
      ctx.data("skipReason", reason);
      for (const claim of CLAIMS) ctx.skipStep(claim, reason);
      return;
    }

    const proxy2 = startForwardingProxy({ target: urls.api2 });
    ctx.defer(() => proxy2.stop());
    const webOrigin = new URL(ctx.env.HARNESS_WEB_URL).origin;
    const api2 = (o: { jar?: CookieJar; clientIp?: string } = {}) =>
      createApi({
        baseUrl: proxy2.url,
        origin: webOrigin,
        jar: o.jar ?? new CookieJar(),
        clientIp: o.clientIp ?? ctx.platform.residential.next(),
      });

    // Watched for the whole run: the bus (outbox) and the issuance lock (MONITOR).
    const bus = new DeliveryCounter();
    const tag = ctx.runId
      .replace(/[^a-z0-9]/gi, "")
      .slice(-8)
      .toLowerCase();
    const marker = `multi:${tag}:`;
    const listener = await ctx.step("subscribe to the event bus", () =>
      listenToBus(urls.valkey, (e, at) => {
        const title = e.payload.title;
        if (e.type === "channel.update" && typeof title === "string" && title.startsWith(marker)) bus.record(title, at);
      }),
    );
    ctx.defer(() => listener.stop());
    let monitor: MonitorHandle | null = null;
    let monitorError: string | null = null;
    const monitorAt = Date.now();
    try {
      monitor = await startMonitor(urls.valkey, [ISSUANCE_LOCK_KEY]);
      const m = monitor;
      ctx.defer(() => m.stop());
    } catch (err) {
      monitorError = errorMessage(err);
    }

    const budget = new ClaimBudget({
      deadline: startedAt + SCENARIO_TIMEOUT_MS,
      weights: CLAIM_WEIGHTS_MS,
      reserveMs: TEARDOWN_RESERVE_MS,
    });
    const kit: Kit = { ctx, tag, urls, containers, api2, bus, monitor, monitorError, monitorAt, startedAt, budget };
    // Before any signup: with the forwarding proxy untrusted, signups would share the address.
    await claim(kit, 0, () => sharedRateLimit(kit));

    const p = ctx.platform;
    const [streamer, alice, bob, troll, slow1, slow2] = await ctx.step("sign up six users", () =>
      Promise.all(
        ["mi_host", "mi_alice", "mi_bob", "mi_troll", "mi_slowa", "mi_slowb"].map((prefix) => p.signUp({ prefix })),
      ),
    );
    if (!streamer || !alice || !bob || !troll || !slow1 || !slow2) throw new Error("signup returned fewer users");
    const channel = streamer.me.channelSlug ?? streamer.username;

    await claim(kit, 1, () => chatAcrossInstances(kit, channel, alice, bob));
    // Three rooms, so the three timings run side by side: the ban in the streamer's channel,
    // slow mode in bob's, the empty-room case in alice's.
    await claim(kit, 2, () =>
      allParts(kit, CLAIMS[2], {
        ban: () => banStaleness(kit, channel, streamer, troll),
        "slow mode": () => slowModeStaleness(kit, bob, slow1, slow2),
        "empty room": () => emptyRoomStaleness(kit, alice, bob),
      }),
    );
    await claim(kit, 3, () => outboxExactlyOnce(kit, channel, streamer));
    const mediaMissing = await viewerNeedsMissing(ctx);
    if (mediaMissing) ctx.skipStep(CLAIMS[4], mediaMissing);
    else await claim(kit, 4, () => viewerCounts(kit, channel, streamer));
    await claim(kit, 5, () => recurringJobs(kit));
    await claim(kit, 6, () => issuanceLeader(kit));
    await claim(kit, 7, () => reconnectOnLoss(kit, channel, streamer, alice));
    await claim(kit, 8, () => workerLoss(kit, channel, streamer));
    ctx.metric("multi.bus.invalid_messages", listener.invalid);
  },
});

/**
 * Run one claim as a step within its share of the time left; a throw is recorded as a failed
 * check, so the next claim still runs.
 */
async function claim(kit: Kit, index: number, fn: () => Promise<void>): Promise<void> {
  const name = CLAIMS[index] ?? `claim ${index}`;
  const allowedMs = kit.budget.begin(index);
  kit.ctx.data(`budgetMs.${index}`, allowedMs);
  try {
    await kit.ctx.step(name, fn);
  } catch (err) {
    if (kit.ctx.signal.aborted) throw err;
    kit.ctx.check(`${name}: completed`, false, { error: errorMessage(err), allowedMs });
  }
}

/** Run independent parts of one claim side by side; each failure is its own failed check. */
async function allParts(kit: Kit, name: string, parts: Record<string, () => Promise<void>>): Promise<void> {
  const entries = Object.entries(parts);
  const results = await Promise.allSettled(entries.map(([, run]) => run()));
  if (kit.ctx.signal.aborted) throw kit.ctx.signal.reason;
  results.forEach((r, i) => {
    if (r.status === "rejected")
      kit.ctx.check(`${name}: ${entries[i]?.[0] ?? i} completed`, false, { error: errorMessage(r.reason) });
  });
}

/** Viewer counts stream through MediaMTX with ffmpeg; why they cannot run here, or null. */
async function viewerNeedsMissing(ctx: ScenarioContext): Promise<string | null> {
  const problems: string[] = [];
  for (const need of ["media", "ffmpeg"] as const satisfies readonly Need[]) {
    const problem = await ctx.platform.probe(need).catch((err: unknown) => errorMessage(err));
    if (problem) problems.push(`${need}: ${problem}`);
  }
  return problems.length > 0 ? `needs ${problems.join("; ")}` : null;
}

/** Why the scenario cannot run (replicas missing or unhealthy), or null. */
async function notReady(urls: ReturnType<typeof replicaUrls>, containers: ReplicaContainer[]): Promise<string | null> {
  const missing = missingReplicas(containers);
  if (missing.length > 0)
    return (
      `replicas not running: ${missing.join(", ")} ` +
      "(start the stack with harness/compose.multi-instance.yaml and --profile multi; see harness/README.md)"
    );
  const probes: [string, string][] = [
    ["api-2", `${urls.api2}/healthz`],
    ["chat-2", urls.chat2Health],
    ["worker-2", urls.worker2Health],
    ["origin-2", `${urls.origin2}/healthz`],
  ];
  const down = [];
  for (const [name, url] of probes) if (!(await healthy(url))) down.push(`${name} (${url})`);
  return down.length > 0 ? `replicas not healthy from the host: ${down.join(", ")}` : null;
}

// ---------------------------------------------------------------- shared rate limits

async function sharedRateLimit(kit: Kit): Promise<void> {
  const { ctx } = kit;
  // One simulated address for both APIs; through the forwarding proxy it is the bucket key.
  const ip = ctx.platform.residential.next();
  const clients = [
    { name: "api-1", api: ctx.platform.api({ clientIp: ip }) },
    { name: "api-2", api: kit.api2({ clientIp: ip }) },
  ];
  const body = JSON.stringify({
    email: `nobody_${kit.tag}@${ctx.env.HARNESS_EMAIL_DOMAIN}`,
    password: "not-the-password-1",
  });
  const statuses: { instance: string; status: number }[] = [];
  for (let i = 0; i < AUTH_LIMIT + 2; i++) {
    const c = clients[i % 2] as (typeof clients)[number];
    const res = await c.api.fetch(
      new Request(`${c.api.baseUrl}${AUTH_ROUTES.signIn}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    await res.body?.cancel();
    statuses.push({ instance: c.name, status: res.status });
  }
  const first = statuses.slice(0, AUTH_LIMIT);
  const over = statuses.slice(AUTH_LIMIT);
  ctx.data("rateLimit", statuses);
  ctx.check(
    `the first ${AUTH_LIMIT} auth requests (alternating api-1/api-2) pass the limiter`,
    first.every((s) => s.status !== 429),
    // A 429 here means the address was already counted: is the harness proxy in TRUSTED_PROXY_CIDRS?
    { statuses: first },
  );
  ctx.check(
    `request ${AUTH_LIMIT + 1} on api-1 and ${AUTH_LIMIT + 2} on api-2 are refused (429): one bucket for both`,
    over.every((s) => s.status === 429),
    { statuses: over },
  );
}

// ---------------------------------------------------------------- chat across instances

async function chatAcrossInstances(kit: Kit, channel: string, alice: SignedInUser, bob: SignedInUser): Promise<void> {
  const { ctx } = kit;
  const a = await connectOn(alice.api, null, ctx.log);
  ctx.defer(() => a.close());
  const b = await connectOn(bob.api, kit.urls.chat2, ctx.log);
  ctx.defer(() => b.close());
  await Promise.all([a.join(channel), b.join(channel)]);

  const prefix = `x:${kit.tag}:`;
  const sentAt = new Map<string, number>();
  const got: Record<"a" | "b", { sender: string; key: string; at: number }[]> = { a: [], b: [] };
  for (const [name, c] of [
    ["a", a],
    ["b", b],
  ] as const)
    c.onFrame((f) => {
      if (f.op === "message" && f.channel === channel && f.message.body.startsWith(prefix))
        got[name].push({ sender: f.message.user.username, key: f.message.body, at: Date.now() });
    });

  const perSender = 8;
  const sent = new Map<string, string[]>([
    [alice.username, []],
    [bob.username, []],
  ]);
  for (let i = 0; i < perSender; i++) {
    for (const [c, user, side] of [
      [a, alice, "a"],
      [b, bob, "b"],
    ] as const) {
      const key = `${prefix}${side}${i}`;
      sentAt.set(key, Date.now());
      const ack = await c.send(channel, key);
      if (ack.id) sent.get(user.username)?.push(key);
    }
  }
  const total = [...sent.values()].reduce((n, k) => n + k.length, 0);
  ctx.check("every message was accepted", total === perSender * 2, { accepted: total });
  await waitFor("both instances deliver every message", () => got.a.length >= total && got.b.length >= total, {
    timeoutMs: 10_000,
    intervalMs: 100,
    signal: ctx.signal,
  }).catch(() => undefined);

  const crossed = (side: "a" | "b", from: string) =>
    got[side].filter((r) => r.sender === from).map((r) => (r.at - (sentAt.get(r.key) ?? r.at)) as number);
  const latencies = [...crossed("b", alice.username), ...crossed("a", bob.username)];
  ctx.metric("multi.chat.cross_latency_ms", percentile(latencies, 50), "ms");
  ctx.metric("multi.chat.cross_latency_max_ms", latencies.length ? Math.max(...latencies) : null, "ms");
  ctx.check(
    "chat-1 → chat-2: a client on chat-2 got every message sent on chat-1",
    crossed("b", alice.username).length === sent.get(alice.username)?.length,
    {
      got: crossed("b", alice.username).length,
    },
  );
  ctx.check(
    "chat-2 → chat-1: a client on chat-1 got every message sent on chat-2",
    crossed("a", bob.username).length === sent.get(bob.username)?.length,
    {
      got: crossed("a", bob.username).length,
    },
  );
  const orderA = got.a.map((r) => r.key);
  const orderB = got.b.map((r) => r.key);
  ctx.check("both instances deliver the room in the same order", orderA.join("|") === orderB.join("|"), {
    chat1: orderA,
    chat2: orderB,
  });
  ctx.check(
    "each sender's messages arrive in the order sent",
    perSenderOrderKept(got.a, sent) && perSenderOrderKept(got.b, sent),
  );
}

// ---------------------------------------------------------------- cache staleness

const INSTANCES = (urls: Kit["urls"]) =>
  [
    { name: "chat1", base: null },
    { name: "chat2", base: urls.chat2 },
  ] as const;

async function banStaleness(kit: Kit, channel: string, streamer: SignedInUser, troll: SignedInUser): Promise<void> {
  const { ctx } = kit;
  const instances = INSTANCES(kit.urls);

  // Ban: made through api-2, observed by the troll's own socket on each instance.
  const trollOn = await Promise.all(instances.map((i) => connectOn(troll.api, i.base, ctx.log)));
  for (const c of trollOn) ctx.defer(() => c.close());
  await Promise.all(trollOn.map((c) => c.join(channel)));
  const before = await Promise.all(trollOn.map((c, i) => sendClassified(c, channel, `ban:${kit.tag}:pre${i}`)));
  ctx.check(
    "the troll can chat on both instances before the ban",
    before.every((r) => r.accepted),
    {
      codes: before.map((r) => r.code),
    },
  );
  const banFrames = trollOn.map((c) =>
    c
      .next("ban", (f) => f.userId === troll.id, 10_000)
      .then(
        () => Date.now(),
        () => null,
      ),
  );
  const host2 = kit.api2({ jar: streamer.api.jar });
  await host2.client.chat.bans.ban({ channel, username: troll.username, durationSeconds: 300, reason: "" });
  const banAt = Date.now();
  ctx.defer(() => streamer.api.client.chat.bans.unban({ channel, username: troll.username }).catch(() => undefined));
  const banned = await Promise.all(
    trollOn.map((c, i) =>
      sendUntilRejected(c, channel, `ban:${kit.tag}:i${i}:`, {
        intervalMs: 2_000,
        deadline: kit.budget.until(STANDING_TTL_MS + 10_000),
        signal: ctx.signal,
      }),
    ),
  );
  const frames = await Promise.all(banFrames);
  instances.forEach((inst, i) => {
    const r = banned[i];
    const rejectedAt = r?.rejectedAt ?? null;
    const ms = rejectedAt === null ? null : Math.max(0, rejectedAt - banAt);
    ctx.metric(`multi.cache_stale_ms.ban.${inst.name}`, ms, "ms");
    const frameAt = frames[i] ?? null;
    ctx.metric(`multi.chat.control_ms.ban.${inst.name}`, frameAt === null ? null : frameAt - banAt, "ms");
    ctx.check(
      `the ban takes effect on ${inst.name} within the standing TTL (${STANDING_TTL_MS / 1000} s)`,
      ms !== null && ms <= STANDING_TTL_MS && (r?.code === "msg_banned" || r?.code === "msg_timedout"),
      { ms, code: r?.code ?? null, acceptedAfterBan: r?.acceptedBefore.length ?? null, banFrame: frameAt !== null },
    );
  });
}

/**
 * Slow mode in `owner`'s channel, set through api-1; one regular chatter per instance sends every
 * 3 s. A send is refused only after an accepted one reserved the slow-mode window, so slow mode
 * was in effect at that accepted send: its time bounds the staleness from above.
 */
async function slowModeStaleness(
  kit: Kit,
  owner: SignedInUser,
  slow1: SignedInUser,
  slow2: SignedInUser,
): Promise<void> {
  const { ctx, urls } = kit;
  const instances = INSTANCES(urls);
  const channel = owner.me.channelSlug ?? owner.username;
  const slowSeconds = 20;
  const chatters = await Promise.all([connectOn(slow1.api, null, ctx.log), connectOn(slow2.api, urls.chat2, ctx.log)]);
  for (const c of chatters) ctx.defer(() => c.close());
  await Promise.all(chatters.map((c) => c.join(channel)));
  const settingsFrames = chatters.map((c) =>
    c
      .next("settings", (f) => f.settings.slowModeSeconds === slowSeconds, 10_000)
      .then(
        () => Date.now(),
        () => null,
      ),
  );
  await owner.api.client.chat.updateSettings({ channel, slowModeSeconds: slowSeconds });
  const slowAt = Date.now();
  ctx.defer(() => owner.api.client.chat.updateSettings({ channel, slowModeSeconds: 0 }).catch(() => undefined));
  const slowed = await Promise.all(
    chatters.map((c, i) =>
      sendUntilRejected(c, channel, `slow:${kit.tag}:${i}:`, {
        intervalMs: 3_000,
        deadline: kit.budget.until(CHANNEL_TTL_MS + 10_000),
        signal: ctx.signal,
      }),
    ),
  );
  const sFrames = await Promise.all(settingsFrames);
  instances.forEach((inst, i) => {
    const r = slowed[i];
    const reserving = r?.acceptedBefore.at(-1);
    const rejectedAt = r?.rejectedAt ?? null;
    const ms = rejectedAt === null ? null : Math.max(0, (reserving?.at ?? rejectedAt) - slowAt);
    ctx.metric(`multi.cache_stale_ms.slow_mode.${inst.name}`, ms, "ms");
    const frameAt = sFrames[i] ?? null;
    ctx.metric(`multi.chat.control_ms.settings.${inst.name}`, frameAt === null ? null : frameAt - slowAt, "ms");
    ctx.check(
      `slow mode takes effect on ${inst.name} within the channel TTL (${CHANNEL_TTL_MS / 1000} s)`,
      ms !== null && ms <= CHANNEL_TTL_MS && r?.code === "msg_slowmode",
      { ms, code: r?.code ?? null, accepted: r?.acceptedBefore.length ?? null, settingsFrame: frameAt !== null },
    );
  });
  await owner.api.client.chat.updateSettings({ channel, slowModeSeconds: 0 });
}

/**
 * An instance unsubscribes from a room's control channel when its last local member leaves
 * (services/chat/src/rooms.ts `part`), but keeps the room's cached settings until their TTL. A
 * change made while it has no members is never heard there: the next member to join that
 * instance gets the old settings until the cache expires. Owner `host`, chatter `guest`, in the
 * host's own channel so no other step keeps chat-2 subscribed to it.
 */
async function emptyRoomStaleness(kit: Kit, host: SignedInUser, guest: SignedInUser): Promise<void> {
  const { ctx, urls } = kit;
  const room = host.me.channelSlug ?? host.username;
  const slowSeconds = 20;
  const warm = await connectOn(guest.api, urls.chat2, ctx.log);
  try {
    await warm.join(room);
    const first = await sendClassified(warm, room, `empty:${kit.tag}:warm`);
    ctx.check("chatting on chat-2 caches the room there", first.accepted, { code: first.code });
  } finally {
    warm.close();
  }
  // The socket close parts the room; give chat-2 a moment to unsubscribe.
  await sleep(1_000, ctx.signal);
  await host.api.client.chat.updateSettings({ channel: room, slowModeSeconds: slowSeconds });
  const changedAt = Date.now();
  ctx.defer(() => host.api.client.chat.updateSettings({ channel: room, slowModeSeconds: 0 }).catch(() => undefined));
  const again = await connectOn(guest.api, urls.chat2, ctx.log);
  ctx.defer(() => again.close());
  const joined = await again.join(room);
  const r = await sendUntilRejected(again, room, `empty:${kit.tag}:`, {
    intervalMs: 3_000,
    deadline: kit.budget.until(CHANNEL_TTL_MS + 10_000),
    signal: ctx.signal,
  });
  const reserving = r.acceptedBefore.at(-1);
  const ms = r.rejectedAt === null ? null : Math.max(0, (reserving?.at ?? r.rejectedAt) - changedAt);
  ctx.metric("multi.cache_stale_ms.slow_mode.empty_room", ms, "ms");
  ctx.check(
    "slow mode set while chat-2 had no members of the room applies when someone joins there (no stale cache)",
    ms !== null && ms <= 5_000 && r.code === "msg_slowmode",
    {
      ms,
      code: r.code,
      joinedSlowModeSeconds: joined.settings.slowModeSeconds,
      acceptedWhileStale: r.acceptedBefore.length,
      ttlMs: CHANNEL_TTL_MS,
    },
  );
  await host.api.client.chat.updateSettings({ channel: room, slowModeSeconds: 0 });
}

// ---------------------------------------------------------------- outbox

async function broadcasterOf(api: Api, channel: string) {
  const c = await api.client.channels.get({ channel });
  return { channelId: c.id, userId: c.owner.id, login: c.slug, name: c.displayName };
}

/** Wait until every key of a tracked group was on the bus (capped by the claim's budget). */
async function waitDelivered(kit: Kit, group: string, total: number, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  await waitFor(`${total} events on the bus`, () => kit.bus.seenCount(group) >= total, {
    timeoutMs: kit.budget.cap(timeoutMs - 2_000),
    intervalMs: 100,
    signal: kit.ctx.signal,
  }).catch(() => undefined);
  const drained = Date.now() - t0;
  // Late repeats (a batch relayed again) arrive after the last first delivery.
  await sleep(2_000, kit.ctx.signal);
  return drained;
}

async function outboxExactlyOnce(kit: Kit, channel: string, streamer: SignedInUser): Promise<void> {
  const { ctx } = kit;
  // Through both APIs: each `channels.update` writes one outbox row in its transaction.
  const host2 = kit.api2({ jar: streamer.api.jar });
  const viaApi = Array.from({ length: 20 }, (_, i) => `multi:${kit.tag}:api:${i}`);
  const viaDbAll = Array.from({ length: 2_000 }, (_, i) => `multi:${kit.tag}:once:${i}`);
  kit.bus.track("outbox", [...viaApi, ...(ctx.env.DATABASE_URL ? viaDbAll : [])]);
  for (const [i, title] of viaApi.entries())
    await (i % 2 === 0 ? streamer.api : host2).client.channels.update({ channel, title });
  let viaDb: string[] = [];
  if (ctx.env.DATABASE_URL) {
    viaDb = viaDbAll;
    await insertOutboxBacklog(ctx.env.DATABASE_URL, await broadcasterOf(streamer.api, channel), viaDb);
  } else ctx.skipStep("outbox backlog of 2000 rows", "DATABASE_URL not set (the repo .env provides it)");
  const expected = [...viaApi, ...viaDb];
  const drained = await waitDelivered(kit, "outbox", expected.length, 47_000);
  const s = kit.bus.summary(expected);
  ctx.metric("multi.outbox.events", expected.length);
  ctx.metric("multi.outbox.drain_ms", drained, "ms");
  ctx.metric("multi.outbox.duplicates", s.extra);
  ctx.data("outboxExactlyOnce", s);
  ctx.check("every outbox event relayed exactly once with two workers", exactlyOnce(s), s);
}

async function workerLoss(kit: Kit, channel: string, streamer: SignedInUser): Promise<void> {
  const { ctx } = kit;
  const databaseUrl = ctx.env.DATABASE_URL;
  if (!databaseUrl) {
    ctx.skipStep("worker-2 killed mid-backlog", "DATABASE_URL not set (the backlog is written to the outbox table)");
    return;
  }
  const worker2 = containerOf(kit.containers, "worker-2");
  if (!worker2) throw new Error("worker-2 container not found");
  const n = WORKER_LOSS_BACKLOG;
  const titles = Array.from({ length: n }, (_, i) => `multi:${kit.tag}:kill:${i}`);
  kit.bus.track("kill", titles);
  const ids = await insertOutboxBacklog(databaseUrl, await broadcasterOf(streamer.api, channel), titles);
  // Kill while the relays are draining: after the first batches, long before the last.
  await waitFor("relay started on the backlog", () => kit.bus.seenCount("kill") >= OUTBOX_BATCH * 2, {
    timeoutMs: kit.budget.cap(20_000),
    intervalMs: 10,
    signal: ctx.signal,
  });
  const killedAt = await killContainer(worker2.name);
  ctx.defer(() => restoreContainer(worker2.name, kit.urls.worker2Health).catch(() => undefined));
  const seenAtKill = kit.bus.seenCount("kill");
  ctx.metric("multi.worker_loss.relayed_before_kill", seenAtKill);
  ctx.check("worker-2 died with the backlog still draining", seenAtKill < n, { seenAtKill, backlog: n });
  // Leave the in-claim restore its time.
  const drained = await waitDelivered(kit, "kill", n, Math.max(0, kit.budget.remaining() - RESTORE_MS));
  const s = kit.bus.summary(titles);
  ctx.metric("multi.worker_loss.drain_ms", Date.now() - killedAt, "ms");
  ctx.metric("multi.worker_loss.duplicates", s.extra);
  ctx.data("workerLoss", { ...s, drainedMs: drained });
  ctx.check("worker-1 relayed the whole backlog (nothing lost)", s.missing.length === 0, s);
  ctx.check("every row is marked published", (await unpublishedCount(databaseUrl, ids)) === 0);
  // At-least-once by design: a batch the dead worker published but never committed is relayed again.
  ctx.check(
    `nothing relayed twice beyond the killed worker's in-flight batch (≤ ${OUTBOX_BATCH})`,
    withinOneBatch(s, OUTBOX_BATCH),
    { duplicates: s.extra, sample: s.duplicated.slice(0, 5) },
  );
  const back = await restoreContainer(worker2.name, kit.urls.worker2Health, kit.budget.cap(RESTORE_MS, 15_000));
  ctx.metric("multi.restore_ms.worker", back, "ms");
}

// ---------------------------------------------------------------- viewer counts

async function viewerCounts(kit: Kit, channel: string, streamer: SignedInUser): Promise<void> {
  const { ctx } = kit;
  const p = ctx.platform;
  const s = await p.streamerFor(streamer, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
  ctx.defer(() => s.stop());
  await s.start();
  await p.waitForLive(channel, true, kit.budget.cap(40_000, 5_000));
  const perApi = 2;
  const viewers = [
    ...Array.from({ length: perApi }, () => p.api()),
    ...Array.from({ length: perApi }, () => kit.api2()),
  ].map((api) => new HttpViewer({ target: { channel }, api: api.client, log: ctx.log }));
  for (const v of viewers) {
    ctx.defer(() => v.stop());
    await v.start();
  }
  const total = viewers.length;
  const firstFrameMs = kit.budget.cap(30_000, 5_000);
  const first = await Promise.allSettled(viewers.map((v) => v.waitForFirstFrame(firstFrameMs)));
  const started = first.filter((r) => r.status === "fulfilled").length;
  ctx.check("every viewer started playback", started === total, { started, total });

  const read1 = p.api().client;
  const read2 = kit.api2().client;
  const count = async (c: typeof read1) => (await c.channels.get({ channel })).live?.viewerCount ?? 0;
  const samples: { api1: number; api2: number }[] = [];
  const t0 = Date.now();
  const converged = await waitFor(
    `viewer count ${started} on api-1 and api-2`,
    async () => {
      const [c1, c2] = await Promise.all([count(read1), count(read2)]);
      samples.push({ api1: c1, api2: c2 });
      return c1 === started && c2 === started;
    },
    { timeoutMs: kit.budget.cap(40_000, 2_000), intervalMs: 2_000, signal: ctx.signal },
  ).then(
    () => true,
    () => false,
  );
  ctx.metric("multi.viewers.converge_ms", converged ? Date.now() - t0 : null, "ms");
  const max = Math.max(0, ...samples.flatMap((x) => [x.api1, x.api2]));
  const disagreed = samples.filter((x) => x.api1 !== x.api2).length;
  ctx.data("viewerSamples", samples.slice(-20));
  ctx.check(`both APIs count the ${started} viewers (two heartbeating to each)`, converged, { last: samples.at(-1) });
  ctx.check("no viewer counted twice (never above the audience)", max <= started, { max, started });
  ctx.metric("multi.viewers.disagreeing_samples", disagreed);
  await Promise.all(viewers.map((v) => v.stop()));
  await s.stop();
}

// ---------------------------------------------------------------- recurring jobs

async function recurringJobs(kit: Kit): Promise<void> {
  const { ctx } = kit;
  const oldest = await oldestCompleted(kit.urls.valkey, "integrity");
  const from = Math.max(kit.startedAt, oldest ?? kit.startedAt);
  // Leave the tick in flight out of the window.
  const to = Date.now() - 5_000;
  const runs = await completedSchedulerRuns(kit.urls.valkey, "integrity");
  const live = schedulerReport(runs, "live-counters", LIVE_COUNTERS_EVERY_MS, from, to);
  const score = schedulerReport(runs, "score-sessions", SCORE_SESSIONS_EVERY_MS, from, to);
  ctx.data("recurringJobs", { windowMs: to - from, live, score });
  ctx.metric("multi.jobs.live_counters.ticks", live.ticks);
  ctx.metric("multi.jobs.live_counters.expected", live.expectedTicks);
  ctx.check("live-counters ran once per 10 s tick with two workers", oncePerTick(live), live);
  ctx.check("score-sessions (integrity run lock) ran once per 15 s tick with two workers", oncePerTick(score), score);
}

// ---------------------------------------------------------------- issuance leader

async function issuanceLeader(kit: Kit): Promise<void> {
  const { ctx, monitor } = kit;
  if (!monitor) {
    ctx.check("Valkey MONITOR available to watch the issuance lock", false, { error: kit.monitorError });
    return;
  }
  // Every origin ticks at least once in any minute; a quarter more for a late timer. MONITOR has
  // watched since the scenario started, so this is usually already true.
  const enough = ISSUANCE_INTERVAL_MS + 15_000;
  await waitFor("a full issuance interval observed", () => Date.now() - kit.monitorAt >= enough, {
    timeoutMs: kit.budget.cap(Math.max(0, kit.monitorAt + enough - Date.now()) + 1_000),
    intervalMs: 1_000,
    signal: ctx.signal,
  }).catch(() => undefined);
  const observedMs = Date.now() - kit.monitorAt;
  const r = issuanceReport(monitor.entries, { observedMs });
  ctx.data("issuance", {
    observedMs,
    windowMs: DOUBLE_LEADER_WINDOW_MS,
    // Contention is context, not a claim: a late timer may find the lock already released.
    contenders: r.contenders,
    leaders: r.leaders,
    releases: r.releases.slice(-20),
    doubled: r.doubled.slice(0, 10),
    monitorError: monitor.error,
  });
  ctx.metric("multi.issuance.contenders", r.contenders.length);
  ctx.metric("multi.issuance.releases_per_minute", r.releasesPerMinute);
  ctx.metric("multi.issuance.max_leaders_in_window", r.maxLeadersInWindow);
  ctx.metric("multi.issuance.double_leader_windows", r.doubled.length);
  ctx.check("issuance ran while watched (the lock was taken and released)", r.releases.length > 0, {
    observedMs,
    monitorError: monitor.error,
  });
  ctx.check(
    `exactly one origin computes issuance at a time (one leader in any ${DOUBLE_LEADER_WINDOW_MS / 1000} s)`,
    r.releases.length > 0 && r.maxLeadersInWindow === 1,
    {
      maxLeadersInWindow: r.maxLeadersInWindow,
      releasesPerMinute: r.releasesPerMinute,
      doubled: r.doubled.slice(0, 5),
    },
  );
}

// ---------------------------------------------------------------- reconnect on instance loss

async function reconnectOnLoss(kit: Kit, channel: string, streamer: SignedInUser, alice: SignedInUser): Promise<void> {
  const { ctx, urls } = kit;
  const chat2 = containerOf(kit.containers, "chat-2");
  if (!chat2) throw new Error("chat-2 container not found");
  const anon = ctx.platform.api();
  const watchers = Array.from(
    { length: 3 },
    () =>
      new ReconnectingChat({
        channel,
        endpoints: ["chat-2", "chat-1"],
        urlFor: (ep) => chatUrlFor(anon, ep === "chat-2" ? urls.chat2 : null),
        connect: (url) => ChatClient.connect({ url, log: ctx.log }),
        log: ctx.log,
      }),
  );
  for (const w of watchers) ctx.defer(() => w.stop());
  await Promise.all(watchers.map((w) => w.start()));
  ctx.check(
    "the watchers start on chat-2",
    watchers.every((w) => w.endpoint === "chat-2"),
  );

  // A burst on chat-2 acknowledged right up to the kill (the owner's limit is 100 per 30 s).
  const burst = await connectOn(streamer.api, urls.chat2, ctx.log);
  await burst.join(channel);
  const acked: string[] = [];
  for (let i = 0; i < 30; i++) {
    const ack = await burst.send(channel, `k:${kit.tag}:${i}`);
    if (ack.id) acked.push(ack.id);
  }
  const killedAt = await killContainer(chat2.name);
  ctx.defer(() => restoreContainer(chat2.name, urls.chat2Health).catch(() => undefined));
  burst.close();

  const reconnectMs = kit.budget.cap(20_000, 5_000);
  const back = await Promise.allSettled(watchers.map((w) => w.waitConnected(killedAt, reconnectMs)));
  const reconnected = back.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const ms = reconnected.map((c) => c.connectedAt - killedAt);
  ctx.metric("multi.reconnect_ms", ms.length ? Math.max(...ms) : null, "ms");
  ctx.data(
    "reconnects",
    watchers.map((w) => ({ attempts: w.attempts, connections: w.connections })),
  );
  ctx.check(
    "every client of chat-2 reconnected to chat-1",
    reconnected.length === watchers.length && reconnected.every((c) => c.endpoint === "chat-1"),
    { reconnected: reconnected.length, endpoints: reconnected.map((c) => c.endpoint) },
  );

  const after = `k:${kit.tag}:after`;
  const sender = await connectOn(alice.api, null, ctx.log);
  ctx.defer(() => sender.close());
  await sender.join(channel);
  await sender.send(channel, after);
  const live = await waitFor(
    "reconnected clients receive new messages",
    () => watchers.every((w) => w.messages().some((m) => m.body === after)),
    { timeoutMs: kit.budget.cap(10_000, 2_000), intervalMs: 100, signal: ctx.signal },
  ).then(
    () => true,
    () => false,
  );
  ctx.check("reconnected clients receive messages sent after the kill", live);

  // chat-1 flushes within 250 ms; what chat-2 had not flushed when it died never arrives.
  await sleep(2_000, ctx.signal);
  const history = await ctx.platform.api().client.chat.history({ channel, limit: 200 });
  const kept = new Set(history.map((m) => m.id));
  const lost = acked.filter((id) => !kept.has(id));
  ctx.metric("multi.chat.lost_on_kill", lost.length);
  ctx.check("no message acknowledged before the kill is missing from history", lost.length === 0, {
    acked: acked.length,
    lost: lost.length,
    sample: lost.slice(0, 5),
  });

  const restored = await restoreContainer(chat2.name, urls.chat2Health, kit.budget.cap(RESTORE_MS, 15_000));
  ctx.metric("multi.restore_ms.chat", restored, "ms");
}
