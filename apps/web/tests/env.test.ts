// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { themeFromCookie } from "../src/lib/theme.ts";
import { loadWebEnv, publicConfig } from "../src/server/env.ts";

describe("web env", () => {
  it("defaults to the local development instance", () => {
    const env = loadWebEnv({});
    expect(env.WEB_PORT).toBe(3000);
    expect(env.API_INTERNAL_URL).toBe("http://localhost:3001");
  });

  it("hands the browser only public URLs, from the instance env", () => {
    const config = publicConfig(
      loadWebEnv({
        PUBLIC_URL: "https://stream.example.org/",
        CHAT_PUBLIC_URL: "wss://chat.example.org/ws",
        INGEST_RTMP_PUBLIC_URL: "rtmp://ingest.example.org/live/",
        PLAYBACK_PUBLIC_URL: "https://edge.example.org/",
        INSTANCE_NAME: "Example Air",
        API_INTERNAL_URL: "http://api:3001",
      }),
    );
    expect(config).toEqual({
      instanceName: "Example Air",
      publicUrl: "https://stream.example.org",
      chatUrl: "wss://chat.example.org/ws",
      ingestRtmpUrl: "rtmp://ingest.example.org/live",
      playbackUrl: "https://edge.example.org",
      currency: "usd",
    });
    expect(JSON.stringify(config)).not.toContain("api:3001");
  });

  it("rejects an invalid port", () => {
    expect(() => loadWebEnv({ WEB_PORT: "80" })).toThrow(/WEB_PORT/);
  });
});

describe("themeFromCookie", () => {
  it("reads a valid theme and defaults to dark", () => {
    expect(themeFromCookie("a=1; commonair-theme=light; b=2")).toBe("light");
    expect(themeFromCookie("commonair-theme=system")).toBe("system");
    expect(themeFromCookie("commonair-theme=neon")).toBe("dark");
    expect(themeFromCookie(undefined)).toBe("dark");
  });
});
