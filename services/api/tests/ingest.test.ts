// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { RECOMMENDED_ENCODER, ingestUrls, obsServiceConfig } from "../src/stream/ingest.ts";

test("recommended encoder settings", () => {
  expect(RECOMMENDED_ENCODER).toMatchObject({
    bitrateKbps: 6000,
    fps: 60,
    resolution: "1920x1080",
    keyframeIntervalSeconds: 2,
    rateControl: "CBR",
    audioBitrateKbps: 160,
  });
  expect(RECOMMENDED_ENCODER.videoCodec).toContain("High");
  expect(RECOMMENDED_ENCODER.audioCodec).toContain("AAC");
  expect(RECOMMENDED_ENCODER.notes.length).toBeGreaterThan(0);
});

test("ingest URLs: RTMP base without trailing slash, WHIP per channel", () => {
  expect(ingestUrls("rtmp://ingest.example.invalid/live/", "https://whip.example.invalid/live", "alice")).toEqual({
    rtmpUrl: "rtmp://ingest.example.invalid/live",
    whipUrl: "https://whip.example.invalid/live/alice/whip",
  });
});

test("OBS service file has the server and recommendations, never a key", () => {
  const { filename, json } = obsServiceConfig({
    instanceName: "Test Air",
    instanceSlug: "test-air",
    rtmpUrl: "rtmp://ingest.example.invalid/live",
  });
  expect(filename).toBe("test-air-obs-service.json");
  const doc = JSON.parse(json) as {
    format_version: number;
    services: {
      name: string;
      servers: { url: string }[];
      recommended: Record<string, unknown>;
    }[];
  };
  expect(doc.format_version).toBeGreaterThan(0);
  const svc = doc.services[0];
  expect(svc?.name).toBe("Test Air");
  expect(svc?.servers[0]?.url).toBe("rtmp://ingest.example.invalid/live");
  expect(svc?.recommended).toMatchObject({ keyint: 2, "max video bitrate": 6000, "max audio bitrate": 160, profile: "high" });
  expect(json).not.toMatch(/live_[A-Za-z0-9_-]{43}/);
  expect(json.toLowerCase()).not.toContain("key=");
});
