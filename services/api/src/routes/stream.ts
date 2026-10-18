// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { RENDITIONS, SIMULCAST_STATUSES } from "@commonair/contracts/enums";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { encryptSecret, sha256Hex } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../lib/orpc.ts";
import { displayPrefix, newStreamKeySecret, obsStreamKey } from "../lib/streamkeys.ts";
import { viewerBreakdown } from "../lib/viewers.ts";
import { outboundUrlProblem } from "../lib/outbound.ts";
import { RECOMMENDED_ENCODER, ingestUrls, obsServiceConfig } from "../stream/ingest.ts";

const { streamKeys, broadcasts, broadcastHealthSamples, simulcastTargets } = schema;
const MAX_SIMULCAST_TARGETS = 5;
const HEALTH_SAMPLES = 60;
export const SIMULCAST_PURPOSE = "simulcast";

const SimulcastState = z.object({
  status: z.enum(SIMULCAST_STATUSES),
  lastError: z.string().nullable().default(null),
});

async function simulcastStates(deps: Deps, broadcastId: string | null) {
  if (!broadcastId) return new Map<string, z.infer<typeof SimulcastState>>();
  const raw = await deps.valkey.hgetall(KEYS.simulcastStatus(broadcastId));
  const out = new Map<string, z.infer<typeof SimulcastState>>();
  for (const [id, json] of Object.entries(raw)) {
    try {
      const parsed = SimulcastState.safeParse(JSON.parse(json));
      if (parsed.success) out.set(id, parsed.data);
    } catch {
      // A malformed entry from another service is shown as idle rather than failing the dashboard.
    }
  }
  return out;
}

const toTarget = (states: Map<string, z.infer<typeof SimulcastState>>) => (t: typeof simulcastTargets.$inferSelect) => {
  const s = states.get(t.id);
  return {
    id: t.id,
    platform: t.platform,
    name: t.name,
    rtmpUrl: t.rtmpUrl,
    enabled: t.enabled,
    status: s?.status ?? "idle",
    lastError: s?.lastError ?? null,
  };
};

/** The media service pushes to this URL: rtmp(s) only, and in production public hosts only. */
async function checkRtmpUrl(deps: Deps, url: string) {
  const problem = await outboundUrlProblem(url, {
    protocols: ["rtmp:", "rtmps:"],
    allowPrivate: deps.env.NODE_ENV !== "production",
    resolve: deps.resolveHost,
  });
  if (problem === "credentials") throw badRequest("Put credentials in the stream key, not the URL");
  if (problem) {
    deps.logger.info("simulcast target refused", { reason: problem });
    throw badRequest("Invalid RTMP URL");
  }
}

const toKeyDto = (k: typeof streamKeys.$inferSelect) => ({
  id: k.id,
  prefix: k.prefix,
  createdAt: iso(k.createdAt),
  lastUsedAt: isoOrNull(k.lastUsedAt),
  revokedAt: isoOrNull(k.revokedAt),
  revokedReason: k.revokedReason,
});

export const stream = {
  ingest: os.stream.ingest.handler(async ({ context }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const [active] = await deps.db
      .select({ prefix: streamKeys.prefix })
      .from(streamKeys)
      .where(and(eq(streamKeys.channelId, c.id), isNull(streamKeys.revokedAt)))
      .orderBy(desc(streamKeys.createdAt))
      .limit(1);
    return {
      ...ingestUrls(deps.env.INGEST_RTMP_PUBLIC_URL, deps.env.INGEST_WHIP_PUBLIC_URL, c.slug),
      activeKeyPrefix: active?.prefix ?? null,
      recommended: { ...RECOMMENDED_ENCODER, notes: [...RECOMMENDED_ENCODER.notes] },
    };
  }),

  obsConfig: os.stream.obsConfig.handler(async ({ context }) => {
    const { deps } = context;
    requireChannel(context);
    const slug =
      deps.site.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "stream";
    return obsServiceConfig({
      instanceName: deps.site.name,
      instanceSlug: slug,
      rtmpUrl: deps.env.INGEST_RTMP_PUBLIC_URL.replace(/\/+$/, ""),
    });
  }),

  keys: os.stream.keys.handler(async ({ context }) => {
    const c = requireChannel(context);
    const rows = await context.deps.db
      .select()
      .from(streamKeys)
      .where(eq(streamKeys.channelId, c.id))
      .orderBy(desc(streamKeys.createdAt))
      .limit(50);
    return rows.map(toKeyDto);
  }),

  rotateKey: os.stream.rotateKey.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const c = requireChannel(context);
    const secret = newStreamKeySecret();
    const now = deps.now();
    const created = await deps.db.transaction(async (tx) => {
      const revoked = await tx
        .update(streamKeys)
        .set({ revokedAt: now, revokedReason: "rotated" })
        .where(and(eq(streamKeys.channelId, c.id), isNull(streamKeys.revokedAt)))
        .returning({ id: streamKeys.id });
      const [row] = await tx
        .insert(streamKeys)
        .values({ channelId: c.id, keyHash: await sha256Hex(secret), prefix: displayPrefix(secret), createdAt: now })
        .returning();
      if (!row) throw new Error("stream key insert returned no row");
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "stream_key.rotate",
        subjectType: "stream_key",
        subjectId: row.id,
        channelId: c.id,
        details: { revoked: revoked.map((r) => r.id) },
      });
      return row;
    });
    return { ...toKeyDto(created), key: obsStreamKey(c.slug, secret) };
  }),

  health: os.stream.health.handler(async ({ context }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const [b] = c.liveBroadcastId
      ? await deps.db.select().from(broadcasts).where(eq(broadcasts.id, c.liveBroadcastId))
      : [];
    const live = b !== undefined && b.endedAt === null;
    const [samples, renditionsRaw, targets, states, viewers] = await Promise.all([
      b
        ? deps.db
            .select()
            .from(broadcastHealthSamples)
            .where(eq(broadcastHealthSamples.broadcastId, b.id))
            .orderBy(desc(broadcastHealthSamples.at))
            .limit(HEALTH_SAMPLES)
        : Promise.resolve([]),
      live ? deps.valkey.get(KEYS.renditions(c.id)) : Promise.resolve(null),
      deps.db.select().from(simulcastTargets).where(eq(simulcastTargets.channelId, c.id)),
      simulcastStates(deps, live && b ? b.id : null),
      viewerBreakdown(deps, c.id),
    ]);
    let renditions: (typeof RENDITIONS)[number][] = live ? ["source"] : [];
    if (renditionsRaw) {
      try {
        const parsed = z.array(z.enum(RENDITIONS)).safeParse(JSON.parse(renditionsRaw));
        if (parsed.success && parsed.data.length > 0) renditions = parsed.data;
      } catch {
        // keep the source-only default
      }
    }
    return {
      live,
      broadcastId: live && b ? b.id : null,
      ingestProtocol: live && b ? b.ingestProtocol : null,
      transcodeActive: live && b ? b.transcodeActive : false,
      renditions,
      samples: samples
        .sort((x, y) => x.at.getTime() - y.at.getTime())
        .map((s) => ({
          at: iso(s.at),
          bitrateKbps: s.bitrateKbps,
          fps: s.fps,
          width: s.width,
          height: s.height,
          videoCodec: s.videoCodec,
          audioCodec: s.audioCodec,
          keyframeIntervalMs: s.keyframeIntervalMs,
          droppedFrames: s.droppedFrames,
          warnings: s.warnings,
        })),
      simulcast: targets.map((t) => {
        const s = states.get(t.id);
        return { targetId: t.id, name: t.name, status: s?.status ?? "idle", lastError: s?.lastError ?? null };
      }),
      viewers,
    };
  }),

  simulcast: {
    list: os.stream.simulcast.list.handler(async ({ context }) => {
      const { deps } = context;
      const c = requireChannel(context);
      const rows = await deps.db
        .select()
        .from(simulcastTargets)
        .where(eq(simulcastTargets.channelId, c.id))
        .orderBy(asc(simulcastTargets.createdAt));
      return rows.map(toTarget(await simulcastStates(deps, c.liveBroadcastId)));
    }),

    create: os.stream.simulcast.create.handler(async ({ context, input }) => {
      const { deps } = context;
      const c = requireChannel(context);
      await checkRtmpUrl(deps, input.rtmpUrl);
      const [{ n } = { n: 0 }] = await deps.db
        .select({ n: count() })
        .from(simulcastTargets)
        .where(eq(simulcastTargets.channelId, c.id));
      if (n >= MAX_SIMULCAST_TARGETS)
        throw precondition("simulcast_limit", `At most ${MAX_SIMULCAST_TARGETS} simulcast targets`);
      const [row] = await deps.db
        .insert(simulcastTargets)
        .values({
          channelId: c.id,
          platform: input.platform,
          name: input.name,
          rtmpUrl: input.rtmpUrl,
          streamKeyCiphertext: await encryptSecret(deps.env.AUTH_SECRET, SIMULCAST_PURPOSE, input.streamKey),
          enabled: input.enabled,
        })
        .returning();
      if (!row) throw new Error("simulcast insert returned no row");
      return toTarget(new Map())(row);
    }),

    update: os.stream.simulcast.update.handler(async ({ context, input }) => {
      const { deps } = context;
      const c = requireChannel(context);
      const set: Partial<typeof simulcastTargets.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.enabled !== undefined) set.enabled = input.enabled;
      if (input.streamKey !== undefined)
        set.streamKeyCiphertext = await encryptSecret(deps.env.AUTH_SECRET, SIMULCAST_PURPOSE, input.streamKey);
      const where = and(eq(simulcastTargets.id, input.id), eq(simulcastTargets.channelId, c.id));
      const [row] =
        Object.keys(set).length > 0
          ? await deps.db.update(simulcastTargets).set(set).where(where).returning()
          : await deps.db.select().from(simulcastTargets).where(where);
      if (!row) throw notFound("Simulcast target not found");
      return toTarget(await simulcastStates(deps, c.liveBroadcastId))(row);
    }),

    remove: os.stream.simulcast.remove.handler(async ({ context, input }) => {
      const c = requireChannel(context);
      const deleted = await context.deps.db
        .delete(simulcastTargets)
        .where(and(eq(simulcastTargets.id, input.id), eq(simulcastTargets.channelId, c.id)))
        .returning({ id: simulcastTargets.id });
      if (deleted.length === 0) throw notFound("Simulcast target not found");
      return { ok: true as const };
    }),
  },
};
