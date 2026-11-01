// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live captions worker (ADR 0011), registered as a media session hook (batch 6 decision (n)) with
 * its own slot limiter (`CAPTIONS_MAX_STREAMS`), separate from the ladder's `transcodeSlots`, so
 * captions never take a transcode slot and vice versa. `onStart` returns as soon as the broadcast
 * is started or queued: the worker runs beside the ladder and never delays it.
 *
 * A host with `CAPTIONS_MAX_STREAMS=0` or no `WHISPER_URL` registers a hook that does nothing.
 */
import type { MediaContext } from "../context.ts";
import type { MediaServiceEnv } from "../env.ts";
import type { MediaSessionHook, MediaSessionHooks } from "../hooks.ts";
import { SlotLimiter } from "../transcode/slots.ts";
import { CaptionsManager } from "./manager.ts";
import { createCaptionsMetrics, type CaptionsMetrics } from "./metrics.ts";
import { ffmpegAudioSource, type AudioSource } from "./source.ts";
import { whisperClient, type Transcriber } from "./whisper.ts";

export { CaptionsManager } from "./manager.ts";

export interface CaptionsDeps {
  ctx: MediaContext;
  env: Pick<MediaServiceEnv, "CAPTIONS_MAX_STREAMS" | "WHISPER_URL">;
  /** Tests: a fake audio source, transcriber or metrics. */
  source?: AudioSource;
  transcriber?: Transcriber;
  metrics?: CaptionsMetrics;
}

export interface CaptionsRuntime {
  hook: MediaSessionHook;
  /** One slot per captioned stream on this host. */
  slots: SlotLimiter;
  /** Null when captions are off on this host. */
  manager: CaptionsManager | null;
}

export function createCaptions(deps: CaptionsDeps): CaptionsRuntime {
  const slots = new SlotLimiter(deps.env.CAPTIONS_MAX_STREAMS);
  const whisperUrl = deps.env.WHISPER_URL;
  if (slots.capacity === 0 || !whisperUrl) {
    const hook: MediaSessionHook = {
      name: "captions",
      onStart: () => Promise.resolve(),
      onEnd: () => Promise.resolve(),
    };
    return { hook, slots, manager: null };
  }
  const { ctx } = deps;
  const logger = ctx.logger.child({ worker: "captions" });
  const manager = new CaptionsManager({
    db: ctx.db,
    valkey: ctx.valkey,
    storage: ctx.storage,
    bucket: ctx.bucket,
    logger,
    slots,
    whisperUrl,
    source: deps.source ?? ffmpegAudioSource(ctx, logger),
    transcriber: deps.transcriber ?? whisperClient({ baseUrl: whisperUrl }),
    metrics: deps.metrics ?? createCaptionsMetrics(),
  });
  const hook: MediaSessionHook = {
    name: "captions",
    onStart: (session, start) => manager.onStart(session, start),
    onEnd: (session, end) => manager.onEnd(session, end),
  };
  return { hook, slots, manager };
}

export function registerCaptions(hooks: MediaSessionHooks, deps: CaptionsDeps): CaptionsRuntime {
  const runtime = createCaptions(deps);
  hooks.register(runtime.hook);
  return runtime;
}
