// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N3-import, the worker's half (`TWITCH_JOBS.import`), against the stack's Postgres and Garage, the
 * real API's upload pipeline and the in-harness Twitch mock's CDN (never the real Twitch):
 *
 * - the fixture channel's fields land through the studio's rules; accepted emotes are stored under
 *   our storage; the T0 fixture emote is refused and enqueues the T0 job; a clash is skipped; the
 *   schedule is carried, not applied;
 * - images come only from `TWITCH_IMAGE_HOSTS`: a host outside it is never contacted;
 * - the job is idempotent on retry (nothing inserted twice, saved images not fetched again);
 * - with the import turned off between start and run, the import fails and nothing is fetched.
 */
import { MODERATION_JOBS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import {
  HelixChannelsResponse,
  HelixEmotesResponse,
  HelixScheduleResponse,
  HelixUsersResponse,
  snapshotOf,
  type TwitchSnapshot,
} from "@commonair/twitch";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { startModeration } from "../../api/src/moderation/index.ts";
import { recordingQueue } from "../../api/src/moderation/queue.ts";
import { signUpAndSignIn, startApi, type TestApi } from "../../api/tests/harness.ts";
import { startTwitchMock, TWITCH_FIXTURE, type TwitchMock } from "../../../harness/src/mocks/twitch/server.ts";
import { commitUpload } from "../src/b7/upload-commit.ts";
import type { WorkerContext } from "../src/context.ts";
import type { StoredItem } from "../src/portability/import/index.ts";
import { runTwitchImport, type TwitchJobConfig } from "../src/twitch-import/run.ts";
import { siteAt, stackStorage } from "./e6-fixtures.ts";
import { AUTH_SECRET, fastWebhooks, quietLogger } from "./fixtures.ts";

const MOD_FIXTURES = new URL("../../../packages/moderation/fixtures/", import.meta.url);
const MOCK_FIXTURES = new URL("../../../harness/src/mocks/twitch/fixtures/", import.meta.url);
const storage = stackStorage();
const t0Queue = recordingQueue();

let api: TestApi;
let mock: TwitchMock;
let snapshot: TwitchSnapshot;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;

const config = (over: Partial<TwitchJobConfig> = {}): TwitchJobConfig => ({
  enabled: true,
  imageHosts: ["127.0.0.1"],
  allowInsecure: true,
  ...over,
});

function ctx(): WorkerContext {
  return {
    db: api.db.app.db,
    sql: api.db.app.sql,
    storage: api.deps.storage,
    mediaBucket: api.deps.env.S3_BUCKET_MEDIA,
    exportsBucket: api.deps.env.S3_BUCKET_EXPORTS,
    logger: quietLogger,
    site: siteAt(api.url),
    webhooks: fastWebhooks({ authSecret: AUTH_SECRET }),
    valkey: { publish: async () => 1 },
    now: () => new Date(),
  } as unknown as WorkerContext;
}
const realCommit = (body: Parameters<typeof commitUpload>[0]) =>
  commitUpload(body, { baseUrl: api.url, secret: api.internalSecret });

/** The fixture channel as the API's callback stores it, with the mock's CDN URLs. */
async function fixtureSnapshot(cdn: string): Promise<TwitchSnapshot> {
  const read = async (name: string) =>
    JSON.parse((await Bun.file(new URL(name, MOCK_FIXTURES)).text()).replaceAll("{{cdn}}", cdn)) as Record<
      string,
      unknown
    >;
  const id = TWITCH_FIXTURE.userId;
  const users = HelixUsersResponse.parse(await read("users.json"));
  const channels = HelixChannelsResponse.parse(await read("channels.json"));
  const emotes = HelixEmotesResponse.parse((await read("emotes.json"))[id]);
  const schedule = HelixScheduleResponse.parse({ data: { segments: (await read("schedule.json"))[id] } });
  return snapshotOf({
    user: users.data.find((u) => u.id === id)!,
    channel: channels.data.find((c) => c.broadcaster_id === id)!,
    emotes,
    schedule: schedule.data.segments ?? [],
  });
}

describe.skipIf(!storage)("twitch import (worker)", () => {
  beforeAll(async () => {
    api = await startApi({
      env: {
        MODERATION_HASHLIST_CSAM: new URL("csam.pdq", MOD_FIXTURES).pathname,
        MODERATION_TEST_HOOKS: "true",
        MODERATION_CLASSIFIER: "scripted",
      },
    });
    await startModeration(api.deps, { queue: t0Queue });
    const t0Image = new Uint8Array(await Bun.file(new URL("t0-pattern.png", MOD_FIXTURES)).arrayBuffer());
    mock = await startTwitchMock({ hostname: "127.0.0.1", t0Image });
    snapshot = await fixtureSnapshot(mock.cdnBase);
  }, 120_000);
  afterAll(async () => {
    await api?.stop();
    await mock?.close();
  });

  const db = () => api.db.db;
  const channelOf = async (u: User) =>
    (await db().select().from(schema.channels).where(eq(schema.channels.ownerId, u.userId)))[0]!;
  const cdnHits = () => mock.requests.filter((r) => r.path.startsWith("/cdn/")).length;

  /** A started import for `u`'s channel, as `twitchImport.start` leaves it. */
  async function queued(u: User, choices: { channel: boolean; emotes: string[] }, snap = snapshot): Promise<string> {
    const ch = await channelOf(u);
    const id = uuidv7();
    await db()
      .insert(schema.portabilityImports)
      .values({
        id,
        userId: u.userId,
        channelId: ch.id,
        source: "twitch",
        status: "queued",
        preview: { state: "ready", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitch: snap },
        choices: { channel: choices.channel, panels: false, emotes: choices.emotes },
        ...(choices.emotes.length ? { assertedAt: new Date(), assertionVersion: "test" } : {}),
      });
    return id;
  }
  const rowOf = async (id: string) =>
    (await db().select().from(schema.portabilityImports).where(eq(schema.portabilityImports.id, id)))[0]!;
  const outcome = (result: unknown, kind: string, ref: string) => {
    const i = ((result ?? []) as StoredItem[]).find((x) => x.kind === kind && x.ref === ref);
    return i ? [i.outcome, i.reason] : null;
  };

  test("fields land, accepted emotes are re-hosted, the T0 emote is refused, a clash is skipped", async () => {
    const u = await signUpAndSignIn(api);
    const ch = await channelOf(u);
    const [cat] = await db()
      .insert(schema.categories)
      .values({ slug: `pixel-${uuidv7().slice(-8)}`, name: TWITCH_FIXTURE.category })
      .returning();
    // The channel already uses `pgHype`.
    await db()
      .insert(schema.emotes)
      .values({ channelId: ch.id, code: "pgHype", imageKey: `channels/${ch.id}/emote/${uuidv7()}.png` });
    const id = await queued(u, { channel: true, emotes: ["pgWave", "pgHype", "pgHi", "pgBad"] });
    t0Queue.jobs.length = 0;

    const out = await runTwitchImport(ctx(), id, { config: config(), commitUpload: realCommit });
    expect(out).toMatchObject({ applied: 1, fetched: 3 });
    const row = await rowOf(id);
    expect(row.status).toBe("done");
    expect(row.finishedAt).not.toBeNull();
    expect(outcome(row.result, "channel", "channel")).toEqual(["imported", null]);
    expect(outcome(row.result, "emote", "pgWave")).toEqual(["imported", null]);
    expect(outcome(row.result, "emote", "pgHi")).toEqual(["imported", null]);
    expect(outcome(row.result, "emote", "pgHype")).toEqual(["skipped", "code_taken"]);
    expect(outcome(row.result, "emote", "pgBad")).toEqual(["rejected", "upload_rejected"]);
    expect(outcome(row.result, "schedule", "schedule")).toEqual(["skipped", "carried_not_applied"]);
    // The T0 fixture went through the same pipeline as a user upload: the T0 job was enqueued.
    expect(t0Queue.jobs.filter((j) => j.name === MODERATION_JOBS.t0)).toHaveLength(1);

    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.id, ch.id));
    expect(c).toMatchObject({
      title: TWITCH_FIXTURE.title,
      description: TWITCH_FIXTURE.description,
      tags: ["pixelart", "cozy", "gardening"],
      language: "en",
      mature: true,
    });
    expect(c?.categoryId).toBe(cat!.id);

    const emotes = await db().select().from(schema.emotes).where(eq(schema.emotes.channelId, ch.id));
    const byCode = new Map(emotes.map((e) => [e.code, e]));
    expect([...byCode.keys()].sort()).toEqual(["pgHi", "pgHype", "pgWave"]);
    expect(byCode.get("pgWave")?.tier).toBe(1);
    expect(byCode.get("pgHi")?.tier).toBe(0);
    for (const code of ["pgWave", "pgHi"]) {
      const key = byCode.get(code)!.imageKey;
      // Stored under our storage, never a Twitch URL.
      expect(key).toMatch(new RegExp(`^channels/${ch.id}/emote/[0-9a-f-]{36}\\.png$`));
      expect(await api.deps.storage.head(api.deps.env.S3_BUCKET_MEDIA, key)).not.toBeNull();
    }
    // The schedule was carried, not applied: no row anywhere names it.
    expect(JSON.stringify(c)).not.toContain("Seed swap");
  });

  test("the job is idempotent on retry", async () => {
    const u = await signUpAndSignIn(api);
    const ch = await channelOf(u);
    const id = await queued(u, { channel: true, emotes: ["pgWave", "pgHi"] });
    await runTwitchImport(ctx(), id, { config: config(), commitUpload: realCommit });
    const first = await rowOf(id);
    const hits = cdnHits();
    // A redelivered job on a finished import changes nothing.
    expect(await runTwitchImport(ctx(), id, { config: config(), commitUpload: realCommit })).toEqual({ skipped: 1 });
    // A retry after a crash mid-way (the row back to running): saved items are skipped, no image is fetched again.
    await db().update(schema.portabilityImports).set({ status: "running" }).where(eq(schema.portabilityImports.id, id));
    const commits: string[] = [];
    const out = await runTwitchImport(ctx(), id, {
      config: config(),
      commitUpload: async (b) => {
        commits.push(b.key);
        return realCommit(b);
      },
    });
    expect(out).toMatchObject({ applied: 1, fetched: 0 });
    expect(commits).toEqual([]);
    expect(cdnHits()).toBe(hits);
    const emotes = await db().select().from(schema.emotes).where(eq(schema.emotes.channelId, ch.id));
    expect(emotes.map((e) => e.code).sort()).toEqual(["pgHi", "pgWave"]);
    expect((await rowOf(id)).result).toEqual(first.result);
  });

  test("images come only from TWITCH_IMAGE_HOSTS", async () => {
    const u = await signUpAndSignIn(api);
    const ch = await channelOf(u);
    const id = await queued(u, { channel: false, emotes: ["pgWave", "pgHi"] });
    const hits = cdnHits();
    const out = await runTwitchImport(ctx(), id, {
      config: config({ imageHosts: ["static-cdn.jtvnw.net"] }),
      commitUpload: realCommit,
    });
    expect(out).toMatchObject({ applied: 1, fetched: 0 });
    // The mock's CDN (127.0.0.1) was never contacted.
    expect(cdnHits()).toBe(hits);
    const row = await rowOf(id);
    expect(outcome(row.result, "emote", "pgWave")).toEqual(["rejected", "missing_file"]);
    expect(outcome(row.result, "channel", "channel")).toEqual(["skipped", "not_chosen"]);
    expect(await db().select().from(schema.emotes).where(eq(schema.emotes.channelId, ch.id))).toHaveLength(0);

    // A hotlink-shaped URL on another host in the stored preview is refused the same way.
    const evil = structuredClone(snapshot);
    evil.emotes = evil.emotes.map((e) => ({ ...e, imageUrl: "http://169.254.169.254/latest/meta-data" }));
    const id2 = await queued(u, { channel: false, emotes: ["pgWave"] }, evil);
    await runTwitchImport(ctx(), id2, { config: config(), commitUpload: realCommit });
    expect(outcome((await rowOf(id2)).result, "emote", "pgWave")).toEqual(["rejected", "missing_file"]);
  });

  test("turned off between start and run: failed, nothing fetched", async () => {
    const u = await signUpAndSignIn(api);
    const id = await queued(u, { channel: true, emotes: ["pgWave"] });
    const hits = cdnHits();
    expect(await runTwitchImport(ctx(), id, { config: config({ enabled: false }) })).toEqual({ failed: 1 });
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(outcome(row.result, "channel", "channel")).toEqual(["rejected", "twitch_import_unavailable"]);
    expect(cdnHits()).toBe(hits);
  });

  test("a preview row without a snapshot fails; other sources and states are skipped", async () => {
    const u = await signUpAndSignIn(api);
    const ch = await channelOf(u);
    const id = uuidv7();
    await db()
      .insert(schema.portabilityImports)
      .values({
        id,
        userId: u.userId,
        channelId: ch.id,
        source: "twitch",
        status: "queued",
        preview: { state: "ready" },
        choices: { channel: true, panels: false, emotes: [] },
      });
    expect(await runTwitchImport(ctx(), id, { config: config() })).toEqual({ failed: 1 });
    expect(await runTwitchImport(ctx(), uuidv7(), { config: config() })).toEqual({ skipped: 1 });
    const prev = await queued(u, { channel: true, emotes: [] });
    await db()
      .update(schema.portabilityImports)
      .set({ status: "previewed" })
      .where(eq(schema.portabilityImports.id, prev));
    expect(await runTwitchImport(ctx(), prev, { config: config() })).toEqual({ skipped: 1 });
  });
});
