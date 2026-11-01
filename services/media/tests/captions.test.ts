// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Captions worker, pure parts (ADR 0011): the ffmpeg reader's flags, PTS → PDT chunking, WAV,
 * the eligibility matrix, masking, and the per-stream pipeline against a fake whisper and store.
 */
import { describe, expect, test } from "vite-plus/test";
import { MASK_TOKEN, type Cue, type LiveTrack } from "@commonair/captions";
import { createLogger } from "@commonair/observability";
import type { MediaSessionInfo } from "../src/hooks.ts";
import { createMasker } from "../src/captions/mask.ts";
import { NOOP_CAPTIONS_METRICS, type DropReason } from "../src/captions/metrics.ts";
import { firstProgramDateTime } from "../src/captions/manager.ts";
import { ineligibility, type EligibilityInput } from "../src/captions/settings.ts";
import {
  captionsAudioArgs,
  CHUNK_BYTES,
  firstPtsFrom,
  MAX_HELD_BYTES,
  OriginTimeoutError,
  PcmChunker,
  wavFile,
  type AudioChunk,
  type AudioSource,
} from "../src/captions/source.ts";
import { CaptionStream, MAX_PENDING, type CueSink } from "../src/captions/stream.ts";
import { WhisperError, whisperClient, whisperLanguage, type Transcriber } from "../src/captions/whisper.ts";

const logger = createLogger({ service: "media-test", level: "fatal" });
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const session: MediaSessionInfo = {
  broadcastId: "0192f3a4-5b6c-7d8e-9f01-0000000000b1",
  channelId: "0192f3a4-5b6c-7d8e-9f01-0000000000c1",
  slug: "alice",
  path: "live/alice",
  kind: "live",
  startedAt: new Date(T0 - 10_000),
  vodId: null,
};

describe("audio reader", () => {
  test("reads SRT with -copyts (never RTSP) as 16 kHz mono PCM, logging the first PTS once", () => {
    const args = captionsAudioArgs("srt://mediamtx:8890?streamid=read:live%2Falice:internal:s3cret");
    expect(args).toContain("-copyts");
    expect(args[args.indexOf("-i") + 1]?.startsWith("srt://")).toBe(true);
    expect(args.join(" ")).not.toMatch(/rtsp/);
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("atrim=end_sample=1,ashowinfo,anullsink");
    expect(graph).toContain("aresample=16000:async=1");
    expect(graph).toContain("channel_layouts=mono");
    expect(args.slice(-3)).toEqual(["-f", "s16le", "pipe:1"]);
  });

  test("first PTS from the ashowinfo line only", () => {
    expect(firstPtsFrom("[Parsed_ashowinfo_2 @ 0x1] n:0 pts:54502166 pts_time:1235.87678 fmt:fltp")).toBe(1235.87678);
    expect(firstPtsFrom("[aac @ 0x1] pts_time:5 something")).toBeNull();
    expect(firstPtsFrom("random")).toBeNull();
  });

  test("chunks are 3 s of PCM, stamped W0 + first PTS + i·3 s; bytes before the PTS are held", () => {
    const chunker = new PcmChunker(T0 - 1000);
    expect(chunker.push(new Uint8Array(10))).toEqual([]);
    chunker.setOrigin(T0);
    chunker.setOrigin(T0 + 999); // first wins
    const out = chunker.push(new Uint8Array(CHUNK_BYTES * 2));
    expect(out.map((c) => [c.startMs - T0, c.endMs - T0, c.w0Ms])).toEqual([
      [0, 3000, T0 - 1000],
      [3000, 6000, T0 - 1000],
    ]);
    // 10 bytes left over from the first push, plus these: a third chunk once complete.
    expect(chunker.push(new Uint8Array(CHUNK_BYTES - 11))).toEqual([]);
    expect(chunker.push(new Uint8Array(1)).map((c) => c.startMs - T0)).toEqual([6000]);
  });

  test("a run whose first PTS never arrives is given up once 10 s of PCM is held, not grown forever", () => {
    const chunker = new PcmChunker(T0);
    expect(chunker.push(new Uint8Array(MAX_HELD_BYTES))).toEqual([]);
    expect(() => chunker.push(new Uint8Array(1))).toThrow(OriginTimeoutError);
    // With the PTS in time, the same amount is chunked normally.
    const ok = new PcmChunker(T0);
    ok.push(new Uint8Array(MAX_HELD_BYTES));
    ok.setOrigin(T0);
    expect(ok.push(new Uint8Array(1)).length).toBe(Math.floor((MAX_HELD_BYTES + 1) / CHUNK_BYTES));
  });

  test("WAV header", () => {
    const wav = wavFile(new Uint8Array(32_000));
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(40, true)).toBe(32_000);
    expect(wav.byteLength).toBe(32_044);
  });

  test("the VOD's time 0 is its playlist's first PDT", () => {
    const p =
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:01.500Z\n#EXTINF:2,\na.m4s\n';
    expect(firstProgramDateTime(p)).toBe(T0 + 1500);
    expect(firstProgramDateTime("#EXTM3U\n")).toBeNull();
  });
});

describe("eligibility", () => {
  const base: EligibilityInput = {
    kind: "live",
    maxStreams: 2,
    whisperUrl: "http://whisper:8080",
    channelEnabled: null,
    instanceDefault: false,
  };
  test.each<[string, Partial<EligibilityInput>, string | null]>([
    ["default off, channel follows it", {}, "default_off"],
    ["default on, channel follows it", { instanceDefault: true }, null],
    ["channel on overrides default off", { channelEnabled: true }, null],
    ["channel off overrides default on", { channelEnabled: false, instanceDefault: true }, "channel_off"],
    ["a rehearsal never", { kind: "rehearsal", channelEnabled: true }, "rehearsal"],
    ["cap 0 turns the host off", { maxStreams: 0, channelEnabled: true }, "host_off"],
    ["no whisper sidecar", { whisperUrl: undefined, channelEnabled: true }, "no_whisper"],
  ])("%s", (_name, over, want) => {
    expect(ineligibility({ ...base, ...over })).toBe(want);
  });
});

describe("masking (chat-filter)", () => {
  test("case-insensitive whole words; regex entries as written", () => {
    const m = createMasker(["darn", "h[e3]ck"]);
    expect(m.mask("Darn it, DARN! darned heck h3ck")).toBe(
      `${MASK_TOKEN} it, ${MASK_TOKEN}! darned ${MASK_TOKEN} ${MASK_TOKEN}`,
    );
  });

  test("phrases and non-ASCII words", () => {
    const m = createMasker(["oh no", "café", "ñandú"]);
    expect(m.mask("Oh  no, a café and a ñandú")).toBe(`${MASK_TOKEN}, a ${MASK_TOKEN} and a ${MASK_TOKEN}`);
  });

  test("an empty list changes nothing; an unsafe pattern is refused, counted, not run", () => {
    expect(createMasker([]).mask("anything")).toBe("anything");
    const m = createMasker(["(a+)+", "ok"]);
    expect(m.refused).toBe(1);
    expect(m.mask("aaaa ok")).toBe(`aaaa ${MASK_TOKEN}`);
  });

  test("over the filter budget the whole cue is masked (no raw text survives)", () => {
    let t = 0;
    const m = createMasker(["one", "two", "three"], 5, () => (t += 10));
    expect(m.mask("one two three secret")).toBe(MASK_TOKEN);
  });
});

describe("whisper client", () => {
  test("posts verbose_json with the base language and parses segments", async () => {
    let seen: FormData | null = null;
    const client = whisperClient({
      baseUrl: "http://w/",
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe("http://w/inference");
        seen = init.body as FormData;
        return Response.json({ segments: [{ start: 0, end: 1, text: "hi" }] });
      }) as unknown as typeof fetch,
    });
    expect(await client.transcribe(wavFile(new Uint8Array(4)), "pt-BR")).toEqual([{ start: 0, end: 1, text: "hi" }]);
    const form = seen as FormData | null;
    expect(form?.get("language")).toBe("pt");
    expect(form?.get("response_format")).toBe("verbose_json");
    expect(whisperLanguage("EN")).toBe("en");
  });

  test("errors are typed: status, unavailable, timeout", async () => {
    const mk = (f: () => Promise<Response>, timeoutMs = 1_000) =>
      whisperClient({ baseUrl: "http://w", timeoutMs, fetch: f as unknown as typeof fetch });
    const wav = wavFile(new Uint8Array(4));
    await expect(mk(async () => new Response("no", { status: 503 })).transcribe(wav, "en")).rejects.toMatchObject({
      kind: "status",
    });
    await expect(
      mk(async () => {
        throw new TypeError("refused");
      }).transcribe(wav, "en"),
    ).rejects.toMatchObject({ kind: "unavailable" });
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    await expect(
      whisperClient({ baseUrl: "http://w", timeoutMs: 20, fetch: hang as unknown as typeof fetch }).transcribe(
        wav,
        "en",
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});

// ------------------------------------------------------------------ the per-stream pipeline

class MemorySink implements CueSink {
  live: LiveTrack | null = null;
  cues: Cue[] = [];
  writes = 0;
  fail = false;
  async track() {
    return this.live;
  }
  async all() {
    return [...this.cues];
  }
  async append(_b: string, track: LiveTrack, cues: readonly Cue[]) {
    if (this.fail) throw new Error("valkey down");
    this.writes++;
    this.live = track;
    this.cues.push(...cues);
  }
}

const chunkAt = (i: number): AudioChunk => ({
  startMs: T0 + i * 3000,
  endMs: T0 + (i + 1) * 3000,
  w0Ms: T0 - 20_000,
  wav: wavFile(new Uint8Array(8)),
});

/** A source that yields the given chunks, then waits until stopped. */
function listSource(chunks: AudioChunk[], gapMs = 0): AudioSource {
  return async function* (_s, signal) {
    for (const c of chunks) {
      if (gapMs > 0) await Bun.sleep(gapMs);
      yield c;
    }
    await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  };
}

function recorder() {
  const dropped: DropReason[] = [];
  let chunks = 0;
  return {
    dropped,
    get chunks() {
      return chunks;
    },
    metrics: { ...NOOP_CAPTIONS_METRICS, dropped: (r: DropReason) => void dropped.push(r), chunk: () => void chunks++ },
  };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("CaptionStream", () => {
  test("masks before storing, keeps cue timing, and publishes throughMs on the anchor's grid", async () => {
    const sink = new MemorySink();
    const rec = recorder();
    const transcriber: Transcriber = {
      transcribe: async () => [{ start: 0.5, end: 2, text: "well darn it" }],
    };
    const stream = new CaptionStream(session, "en", {
      source: listSource([chunkAt(0), chunkAt(1)]),
      transcriber,
      store: sink,
      metrics: rec.metrics,
      logger,
      maskWords: async () => ["darn"],
    });
    stream.start();
    await until(() => sink.writes === 2);
    await stream.stop();
    expect(sink.cues).toEqual([
      { startMs: T0 + 500, endMs: T0 + 2000, text: `well ${MASK_TOKEN} it` },
      { startMs: T0 + 3500, endMs: T0 + 5000, text: `well ${MASK_TOKEN} it` },
    ]);
    expect(JSON.stringify(sink)).not.toContain("darn");
    expect(sink.live).toEqual({ language: "en", w0Ms: T0 - 20_000, anchorMs: T0, throughMs: T0 + 6000 });
    expect(rec.chunks).toBe(2);
  });

  test("whisper down: the chunk is dropped and counted, later ones back off, the playlist moves on", async () => {
    const sink = new MemorySink();
    const rec = recorder();
    let now = T0;
    let calls = 0;
    const transcriber: Transcriber = {
      transcribe: async () => {
        calls++;
        if (calls === 1) throw new WhisperError("unavailable", "down");
        return [{ start: 0, end: 1, text: "back" }];
      },
    };
    const stream = new CaptionStream(session, "en", {
      source: listSource([chunkAt(0), chunkAt(1), chunkAt(2)], 5),
      transcriber,
      store: sink,
      metrics: rec.metrics,
      logger,
      maskWords: async () => [],
      backoff: { initialMs: 4_000, maxMs: 8_000 },
      now: () => now,
    });
    stream.start();
    await until(() => sink.writes === 2);
    now += 5_000; // the backoff has passed before the third chunk is handled
    await until(() => sink.writes === 3);
    await stream.stop();
    expect(rec.dropped).toEqual(["unavailable", "backoff"]);
    expect(calls).toBe(2);
    expect(sink.cues.map((c) => c.text)).toEqual(["back"]);
    expect(sink.live?.throughMs).toBe(T0 + 9000);
  });

  test("a slow whisper never backs up the reader: past MAX_PENDING the oldest waiting chunk is skipped", async () => {
    const sink = new MemorySink();
    const rec = recorder();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const transcriber: Transcriber = {
      transcribe: async () => {
        calls++;
        if (calls === 1) await gate;
        return [];
      },
    };
    const total = MAX_PENDING + 3;
    const stream = new CaptionStream(session, "en", {
      source: listSource(Array.from({ length: total }, (_, i) => chunkAt(i))),
      transcriber,
      store: sink,
      metrics: rec.metrics,
      logger,
      maskWords: async () => [],
    });
    stream.start();
    await Bun.sleep(30);
    release();
    await until(() => sink.writes === total);
    await stream.stop();
    expect(rec.dropped.filter((r) => r === "backlog").length).toBe(total - 1 - MAX_PENDING);
    expect(sink.live?.throughMs).toBe(T0 + total * 3000);
  });

  test("no cue is stored until the mask list could be read", async () => {
    const sink = new MemorySink();
    const rec = recorder();
    let readable = false;
    const stream = new CaptionStream(session, "en", {
      source: listSource([chunkAt(0), chunkAt(1)], 5),
      transcriber: { transcribe: async () => [{ start: 0, end: 1, text: "secret" }] },
      store: sink,
      metrics: rec.metrics,
      logger,
      maskWords: async () => {
        if (!readable) {
          readable = true;
          throw new Error("db blip");
        }
        return ["secret"];
      },
    });
    stream.start();
    await until(() => sink.writes === 2);
    await stream.stop();
    expect(rec.dropped).toEqual(["mask"]);
    expect(sink.cues.map((c) => c.text)).toEqual([MASK_TOKEN]);
  });

  test("resumes a track: same anchor and W0, cues continue after the last stored one", async () => {
    const sink = new MemorySink();
    sink.live = { language: "en", w0Ms: T0 - 99_000, anchorMs: T0 - 30_000, throughMs: T0 + 3000 };
    sink.cues = [{ startMs: T0 + 1000, endMs: T0 + 3200, text: "before" }];
    const stream = new CaptionStream(session, "en", {
      source: listSource([chunkAt(1)]),
      transcriber: { transcribe: async () => [{ start: 0, end: 1, text: "after" }] },
      store: sink,
      metrics: NOOP_CAPTIONS_METRICS,
      logger,
      maskWords: async () => [],
    });
    stream.start();
    await until(() => sink.writes === 1);
    await stream.stop();
    expect(sink.live).toEqual({ language: "en", w0Ms: T0 - 99_000, anchorMs: T0 - 30_000, throughMs: T0 + 6000 });
    expect(sink.cues.at(-1)).toEqual({ startMs: T0 + 3200, endMs: T0 + 4000, text: "after" });
  });

  test("a store failure drops the chunk without crashing the stream", async () => {
    const sink = new MemorySink();
    sink.fail = true;
    const rec = recorder();
    const stream = new CaptionStream(session, "en", {
      source: listSource([chunkAt(0)]),
      transcriber: { transcribe: async () => [{ start: 0, end: 1, text: "x" }] },
      store: sink,
      metrics: rec.metrics,
      logger,
      maskWords: async () => [],
    });
    stream.start();
    await until(() => rec.dropped.length === 1);
    await stream.stop();
    expect(rec.dropped).toEqual(["store"]);
  });
});
