// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Encoder capability probe, run once at startup. `auto` uses NVENC only when ffmpeg lists it
 * AND a 1-frame test encode succeeds (the encoder is often compiled in without a usable GPU);
 * `nvenc` insists and fails loudly; `none` always uses libx264.
 */
import { encoderTestArgs, type H264Encoder, type ImageFormat } from "./args.ts";
import { runCommand } from "./run.ts";

export type HwaccelMode = "auto" | "nvenc" | "none";

/** Encoder names from `ffmpeg -hide_banner -encoders` (lines like ` V....D libx264  desc`). */
export function parseEncoders(output: string): Set<string> {
  const names = new Set<string>();
  let inTable = false;
  for (const line of output.split("\n")) {
    if (/^\s*-{3,}\s*$/.test(line)) {
      inTable = true;
      continue;
    }
    // The legend above the `------` separator has the same flag column; skip it.
    if (!inTable) continue;
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

export class HwaccelUnavailableError extends Error {
  constructor(reason: string) {
    super(`TRANSCODE_HWACCEL=nvenc but NVENC is unusable: ${reason}`);
    this.name = "HwaccelUnavailableError";
  }
}

export function chooseEncoder(
  mode: HwaccelMode,
  probe: { listed: boolean; testEncodeOk: boolean | null; testError?: string },
): H264Encoder {
  if (mode === "none") return "libx264";
  const usable = probe.listed && probe.testEncodeOk === true;
  if (mode === "nvenc" && !usable)
    throw new HwaccelUnavailableError(
      !probe.listed ? "ffmpeg does not list h264_nvenc" : `test encode failed: ${probe.testError ?? "unknown error"}`,
    );
  return usable ? "h264_nvenc" : "libx264";
}

export interface Capabilities {
  encoder: H264Encoder;
  /** WebP when ffmpeg has libwebp, otherwise JPEG (development builds often lack libwebp). */
  imageFormat: ImageFormat;
}

export async function probeCapabilities(mode: HwaccelMode, ffmpeg = "ffmpeg"): Promise<Capabilities> {
  const { stdout } = await runCommand(ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 });
  const encoders = parseEncoders(new TextDecoder().decode(stdout));
  const listed = encoders.has("h264_nvenc");
  let testEncodeOk: boolean | null = null;
  let testError: string | undefined;
  if (listed && mode !== "none") {
    try {
      await runCommand(ffmpeg, encoderTestArgs("h264_nvenc"), { timeoutMs: 20_000 });
      testEncodeOk = true;
    } catch (err) {
      testEncodeOk = false;
      testError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    encoder: chooseEncoder(mode, { listed, testEncodeOk, testError }),
    imageFormat: encoders.has("libwebp") ? "webp" : "jpeg",
  };
}
