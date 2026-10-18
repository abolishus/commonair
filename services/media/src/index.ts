// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export { mediaServiceEnv, type MediaServiceEnv } from "./env.ts";
export { createMediaService, type MediaService, type MediaServiceOptions } from "./service.ts";
export { DEFAULT_TIMINGS, type MediaTimings } from "./settings.ts";
export {
  NoopHashMatcher,
  StubVendorMatcher,
  type HashMatcher,
  type HashMatchResult,
  type HashCheckContext,
} from "./safety/hashmatch.ts";
export { ClipJob } from "./clips.ts";
export { VodFinalizeJob } from "./vod/finalize.ts";
