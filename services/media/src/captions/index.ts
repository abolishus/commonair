// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live captions worker (ADR 0011). W2-captions owns this directory; the contract step registers a
 * no-op session hook with its own slot limiter (`CAPTIONS_MAX_STREAMS`), separate from the
 * ladder's `transcodeSlots`, so captions never take a transcode slot and vice versa.
 */
import type { MediaContext } from "../context.ts";
import type { MediaServiceEnv } from "../env.ts";
import type { MediaSessionHook, MediaSessionHooks } from "../hooks.ts";
import { SlotLimiter } from "../transcode/slots.ts";

export interface CaptionsDeps {
  ctx: MediaContext;
  env: Pick<MediaServiceEnv, "CAPTIONS_MAX_STREAMS" | "WHISPER_URL">;
}

export interface CaptionsRuntime {
  hook: MediaSessionHook;
  /** One slot per captioned stream on this host. */
  slots: SlotLimiter;
}

export function createCaptions(deps: CaptionsDeps): CaptionsRuntime {
  const slots = new SlotLimiter(deps.env.CAPTIONS_MAX_STREAMS);
  const hook: MediaSessionHook = {
    name: "captions",
    onStart: () => Promise.resolve(),
    onEnd: () => Promise.resolve(),
  };
  return { hook, slots };
}

export function registerCaptions(hooks: MediaSessionHooks, deps: CaptionsDeps): CaptionsRuntime {
  const runtime = createCaptions(deps);
  hooks.register(runtime.hook);
  return runtime;
}
