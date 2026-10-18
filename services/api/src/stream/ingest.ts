// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Ingest endpoints, recommended encoder settings and the OBS service file (pure). */

export const RECOMMENDED_ENCODER = {
  videoCodec: "H.264 (High profile)",
  audioCodec: "AAC-LC",
  resolution: "1920x1080",
  fps: 60,
  bitrateKbps: 6000,
  keyframeIntervalSeconds: 2,
  rateControl: "CBR",
  audioBitrateKbps: 160,
  notes: [
    "Use a 2 second keyframe interval: playback segments and adaptive renditions are cut on keyframes.",
    "Use constant bitrate (CBR); variable bitrate causes buffering for viewers on slower links.",
    "If your upload is under 8 Mbps, stream 720p60 at 4500 kbps or 720p30 at 3000 kbps instead.",
    "Disable B-frames above 2 if your encoder allows it, to keep latency low.",
    "Never share your stream key. Anyone with it can broadcast as you; rotate it if it leaks.",
  ],
} as const;

export function ingestUrls(rtmpBase: string, whipBase: string, slug: string) {
  return {
    rtmpUrl: rtmpBase.replace(/\/+$/, ""),
    whipUrl: `${whipBase.replace(/\/+$/, "")}/${slug}/whip`,
  };
}

/** OBS `services.json`-style custom service (no key: the streamer pastes it in OBS). */
export function obsServiceConfig(opts: { instanceName: string; instanceSlug: string; rtmpUrl: string }) {
  const service = {
    name: opts.instanceName,
    common: true,
    servers: [{ name: `${opts.instanceName} (default)`, url: opts.rtmpUrl }],
    recommended: {
      keyint: RECOMMENDED_ENCODER.keyframeIntervalSeconds,
      profile: "high",
      "max video bitrate": RECOMMENDED_ENCODER.bitrateKbps,
      "max audio bitrate": RECOMMENDED_ENCODER.audioBitrateKbps,
      bframes: 2,
      x264opts: "scenecut=0",
      supported_resolutions: ["1920x1080", "1280x720", "852x480"],
      max_fps: RECOMMENDED_ENCODER.fps,
    },
    supported_video_codecs: ["h264"],
    supported_audio_codecs: ["aac"],
  };
  return {
    filename: `${opts.instanceSlug}-obs-service.json`,
    json: JSON.stringify({ $schema: "schema/service-schema-v3.json", format_version: 5, services: [service] }, null, 2),
  };
}
