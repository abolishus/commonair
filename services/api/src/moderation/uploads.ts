// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channels.commitUpload` (docs/testing/e4c-selectors.md "T0 upload", "T1 upload"). The object in
 * `incoming/` is checked before anything is public:
 *
 * 1. size and magic bytes; audio stops here;
 * 2. ffmpeg decode (first frame of a GIF), PDQ, the hash lists. A match seals the image and
 *    enqueues `moderation.t0` for the worker (the only implementation of the T0 actions);
 * 3. the configured classifier: ≥ T1 opens a T1 case (no restriction) and rejects; ≥ T2 `sexual`
 *    rejects without a case (avatars, banners, panels and emotes appear outside the 18+ gate);
 * 4. otherwise the object is copied to its public key.
 *
 * Every rejection deletes the incoming object and answers with the same `upload_rejected`, so
 * the uploader cannot learn that a list matched. Logs carry ids, tiers, categories, scores,
 * distances and versions only.
 */
import { ORPCError } from "@orpc/server";
import type { MODERATION_SUBJECTS } from "@commonair/contracts/enums";
import { schema, uuidv7 } from "@commonair/db";
import {
  decodeImage,
  encodeImage,
  MODERATION_CONSTANTS,
  parseThresholds,
  pdqHash,
  plaintextSha256,
  reviewFrameKey,
  tierFor,
  type DecodedFrame,
  type HashMatch,
} from "@commonair/moderation";
import type { SealedEvidence } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { mediaUrl } from "../lib/dto.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { readSetting } from "../lib/settings.ts";
import { moderationRuntime, type ModerationRuntime } from "./runtime.ts";
import {
  IMAGE_PURPOSES,
  MAX_UPLOAD_BYTES,
  parseIncomingKey,
  sniffMatches,
  type ParsedIncomingKey,
} from "./upload-keys.ts";

const { LUMA, RGB } = { LUMA: MODERATION_CONSTANTS.PDQ_LUMA_SIZE, RGB: MODERATION_CONSTANTS.CLASSIFIER_INPUT_SIZE };

/** The one response for every rejection (UPLOAD_REJECTED in the contract). */
export const uploadRejected = () =>
  new ORPCError("UNPROCESSABLE_CONTENT", {
    status: 422,
    message: "This file cannot be used",
    data: { reason: "upload_rejected" as const },
    defined: true,
  });

const SUBJECT: (typeof MODERATION_SUBJECTS)[number] = "upload";

async function deleteIncoming(deps: Deps, key: string): Promise<void> {
  try {
    await deps.storage.delete(deps.env.S3_BUCKET_MEDIA, key);
  } catch (err) {
    // The incoming-cleanup job removes it within a day; the object is never served meanwhile.
    deps.logger.warn("incoming upload delete failed", { err: (err as Error).name });
  }
}

async function reject(deps: Deps, key: ParsedIncomingKey): Promise<never> {
  await deleteIncoming(deps, key.incoming);
  throw uploadRejected();
}

/** Evidence for the T0 job: the upload itself when it fits inline, else the normalized frame as PNG. */
async function sealUpload(
  rt: ModerationRuntime,
  bytes: Uint8Array,
  contentType: string,
  frame: DecodedFrame,
  pdq: { hash: string; quality: number },
  capturedAt: string,
): Promise<SealedEvidence> {
  let plain = bytes;
  let type = contentType;
  if (plain.length > MODERATION_CONSTANTS.EVIDENCE_INLINE_MAX_BYTES) {
    plain = await encodeImage(frame.rgb, { width: RGB, height: RGB, format: "rgb" }, "png");
    type = "image/png";
  }
  const sealed = await rt.sealing.seal(plain);
  return {
    kind: "upload",
    contentType: type as SealedEvidence["contentType"],
    sealedBase64: Buffer.from(sealed).toString("base64"),
    sha256: await plaintextSha256(plain),
    sizeBytes: plain.length,
    keyId: rt.sealing.keyId,
    pdq: pdq.hash,
    pdqQuality: pdq.quality,
    capturedAt,
  };
}

async function enqueueT0(
  deps: Deps,
  rt: ModerationRuntime,
  job: Parameters<ModerationRuntime["queue"]["t0"]>[0],
): Promise<void> {
  // The rejection must not be answered until the worker is sure to act on it.
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rt.queue.t0(job);
      return;
    } catch (err) {
      last = err;
      await Bun.sleep(200 * (attempt + 1));
    }
  }
  deps.logger.error("t0 enqueue failed for an upload", {
    subjectId: job.subjectId,
    channelId: job.channelId,
    listCategory: job.listCategory,
    err: (last as Error | undefined)?.name,
  });
  throw last;
}

/** A T1 classifier hit on an upload: case, flag, review frame, audit and event, one transaction. */
async function openUploadCase(
  deps: Deps,
  rt: ModerationRuntime,
  ctx: { channelId: string; userId: string; purpose: string },
  hit: { category: NonNullable<ReturnType<typeof tierFor> & { tier: "t1" }>["category"]; score: number },
  frame: DecodedFrame,
): Promise<void> {
  const now = deps.now();
  const caseId = uuidv7();
  const flagId = uuidv7();
  const subjectId = uuidv7();
  const frameKey = reviewFrameKey(caseId, flagId);
  const jpeg = await encodeImage(frame.rgb, { width: RGB, height: RGB, format: "rgb" }, "jpeg");
  const jpegBytes = Uint8Array.from(jpeg);
  await deps.storage.put(deps.env.S3_BUCKET_MEDIA, frameKey, new Blob([jpegBytes.buffer]), {
    contentType: "image/jpeg",
  });
  await deps.db.transaction(async (tx) => {
    await tx.insert(schema.moderationCases).values({
      id: caseId,
      tier: "t1",
      status: "open",
      origin: "classifier",
      subjectType: SUBJECT,
      subjectId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      category: hit.category,
      priority: MODERATION_CONSTANTS.T1_PRIORITY,
      slaDueAt: new Date(now.getTime() + MODERATION_CONSTANTS.T1_SLA_MINUTES * 60_000),
    });
    await tx.insert(schema.moderationFlags).values({
      id: flagId,
      tier: "t1",
      origin: "classifier",
      caseId,
      subjectType: SUBJECT,
      subjectId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      category: hit.category,
      score: hit.score,
      provider: rt.classifier.provider,
      providerVersion: rt.classifier.providerVersion,
      frameKey,
      capturedAt: now,
    });
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: "moderation.t1.upload_reject",
      subjectType: "moderation_case",
      subjectId: caseId,
      channelId: ctx.channelId,
      details: {
        caseId,
        flagId,
        subjectType: SUBJECT,
        subjectId,
        userId: ctx.userId,
        purpose: ctx.purpose,
        tier: "t1",
        category: hit.category,
        score: hit.score,
        provider: rt.classifier.provider,
        providerVersion: rt.classifier.providerVersion,
      },
    });
    await emit(tx, "moderation.flagged", ctx.channelId, {
      case_id: caseId,
      flag_id: flagId,
      tier: "t1",
      origin: "classifier",
      subject_type: SUBJECT,
      subject_id: subjectId,
      channel_id: ctx.channelId,
      category: hit.category,
      list_category: null,
      provider: rt.classifier.provider,
      provider_version: rt.classifier.providerVersion,
    });
  });
}

export interface CommitInput {
  channelId: string;
  userId: string;
  key: string;
}

export async function commitUpload(deps: Deps, input: CommitInput): Promise<{ key: string; url: string }> {
  const parsed = parseIncomingKey(input.key, input.channelId);
  if (!parsed) throw badRequest("Not an upload of this channel");
  const bucket = deps.env.S3_BUCKET_MEDIA;
  const res = await deps.storage.get(bucket, parsed.incoming);
  if (!res) throw notFound("Upload not found or expired");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const log = deps.logger.child({ component: "uploads", channelId: input.channelId, purpose: parsed.purpose });

  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES || !sniffMatches(bytes, parsed.contentType)) {
    log.info("upload rejected", { check: "type" });
    return reject(deps, parsed);
  }

  if (IMAGE_PURPOSES.includes(parsed.purpose)) {
    const rt = await moderationRuntime(deps);
    let frame: DecodedFrame;
    try {
      frame = await decodeImage(bytes);
    } catch {
      log.info("upload rejected", { check: "decode" });
      return reject(deps, parsed);
    }
    const pdq = pdqHash(frame.luma, LUMA, LUMA);
    const match: HashMatch | null = await rt.match(pdq);
    if (match) {
      const capturedAt = deps.now().toISOString();
      const subjectId = uuidv7();
      await enqueueT0(deps, rt, {
        subjectType: SUBJECT,
        subjectId,
        channelId: input.channelId,
        userId: input.userId,
        listCategory: match.category,
        provider: match.provider,
        listVersion: match.listVersion,
        distance: match.distance,
        quality: match.quality,
        capturedAt,
        evidence: [await sealUpload(rt, bytes, parsed.contentType, frame, pdq, capturedAt)],
        uploadPurpose: parsed.purpose as Exclude<typeof parsed.purpose, "alert_sound">,
      });
      // Ids and match metadata only: never the hash of the upload or its key.
      log.warn("upload matched a hash list", {
        subjectId,
        tier: "t0",
        listCategory: match.category,
        provider: match.provider,
        listVersion: match.listVersion,
        distance: match.distance,
      });
      return reject(deps, parsed);
    }

    const scores = await rt.classifier.classify({ rgb: frame.rgb, channelId: input.channelId });
    const { thresholds } = parseThresholds((await readSetting(deps.db, "moderation.thresholds")).value);
    // Uploads appear outside the 18+ gate, so they are judged as if the channel were not mature.
    const decision = tierFor(scores, thresholds, { mature: false });
    if (decision.tier === "t1") {
      await openUploadCase(
        deps,
        rt,
        { channelId: input.channelId, userId: input.userId, purpose: parsed.purpose },
        decision,
        frame,
      );
      log.info("upload rejected", { tier: "t1", category: decision.category, score: decision.score });
      return reject(deps, parsed);
    }
    if (decision.tier === "t2") {
      log.info("upload rejected", { tier: "t2", category: decision.category, score: decision.score });
      return reject(deps, parsed);
    }
  }

  await deps.storage.put(bucket, parsed.publicKey, bytes, { contentType: parsed.contentType });
  await deleteIncoming(deps, parsed.incoming);
  return { key: parsed.publicKey, url: mediaUrl(deps, parsed.publicKey) ?? "" };
}
