// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineScenario } from "../src/scenario.ts";
import { ingestScenario } from "./_ingest.ts";

export default defineScenario({
  name: "ingest-whip",
  description: "WHIP (WebRTC) publish → live via API → Chromium + WebKit playback through the origin → offline",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "whip", "browser"],
  timeoutMs: 5 * 60_000,
  run: (ctx) => ingestScenario(ctx, "whip"),
});
