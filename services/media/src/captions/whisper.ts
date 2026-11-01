// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The whisper.cpp sidecar's HTTP server (`whisper-server`, internal network only): `POST
 * /inference` with the chunk as a multipart WAV, `verbose_json` for timed segments. Every call is
 * bounded; a slow or failing sidecar costs dropped chunks, never a stuck worker.
 */
import { parseWhisperResponse, type WhisperSegment } from "@commonair/captions";

export interface Transcriber {
  /** Segments of one chunk; throws on a failed, refused or timed-out request. */
  transcribe(wav: Uint8Array<ArrayBuffer>, language: string, signal?: AbortSignal): Promise<WhisperSegment[]>;
}

export class WhisperError extends Error {
  constructor(
    readonly kind: "timeout" | "unavailable" | "status" | "malformed",
    message: string,
  ) {
    super(message);
  }
}

/** whisper takes ISO 639-1 codes; a region (`pt-BR`) is not a separate model language. */
export const whisperLanguage = (tag: string): string => (tag.split("-")[0] ?? tag).toLowerCase();

export interface WhisperClientOptions {
  baseUrl: string;
  /** Per request; past it the chunk is dropped (a chunk is 3 s, so later than that is behind). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function whisperClient(opts: WhisperClientOptions): Transcriber {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/inference`;
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const doFetch = opts.fetch ?? fetch;
  return {
    async transcribe(wav, language, signal) {
      const form = new FormData();
      form.set("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
      form.set("response_format", "verbose_json");
      form.set("language", whisperLanguage(language));
      form.set("temperature", "0");
      // The language is set; detecting it again per chunk is wasted work.
      form.set("no_language_probabilities", "true");
      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          body: form,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (timeout.aborted) throw new WhisperError("timeout", `whisper did not answer within ${timeoutMs} ms`);
        throw new WhisperError("unavailable", err instanceof Error ? err.name : "fetch failed");
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new WhisperError("status", `whisper answered ${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new WhisperError(timeout.aborted ? "timeout" : "malformed", "whisper answer was not JSON");
      }
      return parseWhisperResponse(body);
    },
  };
}
