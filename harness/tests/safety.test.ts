// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The trust-safety scenario's pure parts: steps, deadlines, the NCII clock, log hygiene, args. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { PROTECTED_TABLES, isoOrNull } from "../src/safety-db.ts";
import { ffmpegFailure, internalSecret } from "../src/safety-io.ts";
import {
  ALL_SAFETY_STEPS,
  DEADLINE_SLACK_MS,
  GENERIC_NEEDLES,
  NCII_DEADLINE_MS,
  apiError,
  avatarPrefix,
  base64Windows,
  benignPatternSource,
  buildFixturePublishArgs,
  emailNeedles,
  errorOf,
  findInPages,
  firstFrameArgs,
  fixtureNeedles,
  fixturePath,
  isMatureGate,
  isNotFound,
  isUploadRejected,
  nciiClipUrl,
  nciiDeadlineOk,
  nciiTickAsOf,
  parseSampleSeconds,
  parseSteps,
  runSeed,
  scanLog,
  serviceOfContainer,
  summarizeHits,
  textNeedles,
  twoIntervalsDeadlineMs,
  withPrerequisites,
  withinDeadline,
} from "../src/safety.ts";

describe("ffmpeg failure reporting", () => {
  test("publishing and frame extraction expose only safe failure categories", () => {
    expect(ffmpegFailure("publish").message).toBe("fixture_publish_failed");
    expect(ffmpegFailure("frame").message).toBe("fixture_frame_extraction_failed");
  });
});

describe("step selection", () => {
  test("all, empty and lists", () => {
    expect(parseSteps("all")).toEqual([...ALL_SAFETY_STEPS]);
    expect(parseSteps("")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseSteps("1,2,5")).toEqual([1, 2, 5]);
    expect(parseSteps(" 5 , 1,5,2 ")).toEqual([1, 2, 5]);
    expect(parseSteps("ALL")).toHaveLength(7);
  });

  test("ranges", () => {
    expect(parseSteps("1-3")).toEqual([1, 2, 3]);
    expect(parseSteps("6-7,1")).toEqual([1, 6, 7]);
    expect(parseSteps("4-4")).toEqual([4]);
  });

  test("anything else is refused rather than running fewer checks", () => {
    for (const bad of ["0", "8", "1,x", "3-1", "1-9", "-1", "1.5", ",", "two"])
      expect(() => parseSteps(bad)).toThrow(/steps/);
  });

  test("step 2 pulls in step 1", () => {
    expect(withPrerequisites([2, 5])).toEqual({ steps: [1, 2, 5], added: [1] });
    expect(withPrerequisites([1, 2])).toEqual({ steps: [1, 2], added: [] });
    expect(withPrerequisites([7])).toEqual({ steps: [7], added: [] });
  });
});

describe("deadlines", () => {
  test("two intervals + 5 s", () => {
    expect(twoIntervalsDeadlineMs(2)).toBe(9_000);
    expect(twoIntervalsDeadlineMs(10)).toBe(25_000);
    expect(twoIntervalsDeadlineMs(2, 0)).toBe(4_000);
    expect(DEADLINE_SLACK_MS).toBe(5_000);
  });

  test("withinDeadline is inclusive and rejects nonsense", () => {
    expect(withinDeadline(9_000, 9_000)).toBe(true);
    expect(withinDeadline(9_001, 9_000)).toBe(false);
    expect(withinDeadline(0, 9_000)).toBe(true);
    expect(withinDeadline(-1, 9_000)).toBe(false);
    expect(withinDeadline(Number.NaN, 9_000)).toBe(false);
  });

  test("sample seconds: 2–60 integers", () => {
    expect(parseSampleSeconds("2")).toBe(2);
    expect(parseSampleSeconds(" 60 ")).toBe(60);
    for (const bad of ["1", "61", "2.5", "", "x"]) expect(() => parseSampleSeconds(bad)).toThrow(/sampleSeconds/);
  });
});

describe("NCII clock arithmetic", () => {
  const receipt = Date.parse("2026-10-20T12:00:00.000Z");

  test("deadline = receipt + 48 h within ±5 s", () => {
    expect(NCII_DEADLINE_MS).toBe(172_800_000);
    expect(nciiDeadlineOk(receipt, "2026-10-22T12:00:00.000Z")).toBe(true);
    expect(nciiDeadlineOk(receipt, "2026-10-22T12:00:05.000Z")).toBe(true);
    expect(nciiDeadlineOk(receipt, "2026-10-22T11:59:55.000Z")).toBe(true);
    expect(nciiDeadlineOk(receipt, "2026-10-22T12:00:05.001Z")).toBe(false);
    expect(nciiDeadlineOk(receipt, "2026-10-22T11:59:54.999Z")).toBe(false);
    // Offsets are honoured: the same instant written in another zone.
    expect(nciiDeadlineOk(receipt, "2026-10-22T14:00:00+02:00")).toBe(true);
    expect(nciiDeadlineOk(receipt, "2026-10-21T12:00:00.000Z")).toBe(false);
    expect(nciiDeadlineOk(receipt, "not a date")).toBe(false);
  });

  test("the tick is one minute past the deadline", () => {
    expect(nciiTickAsOf(receipt)).toBe("2026-10-22T12:01:00.000Z");
  });
});

describe("log hygiene matcher", () => {
  // A stand-in byte pattern (not an image fixture): deterministic pseudo-random bytes.
  const bytes = Uint8Array.from({ length: 600 }, (_, i) => (i * 73 + 41) % 256);
  const needles = [
    ...GENERIC_NEEDLES,
    ...fixtureNeedles("t0-pattern.png", bytes),
    ...emailNeedles(["Alice_1@harness.test"]),
  ];

  test("finds the fixture's base64 at any byte alignment inside a larger blob", () => {
    for (const prefix of [0, 1, 2, 7]) {
      const blob = Buffer.concat([Buffer.alloc(prefix, 9), Buffer.from(bytes), Buffer.alloc(5, 3)]).toString("base64");
      const line = JSON.stringify({ level: "info", msg: "frame", data: blob.slice(0, 400) });
      const hits = scanLog("worker", `ok\n${line}\n`, needles);
      expect(hits).toEqual([{ source: "worker", line: 2, kind: "fixture:t0-pattern.png" }]);
    }
  });

  test("finds emails case-insensitively", () => {
    const hits = scanLog("api", '{"msg":"sent","to":"alice_1@HARNESS.test"}', needles);
    expect(hits.map((h) => h.kind)).toEqual(["email"]);
  });

  test("finds any image or long base64 run", () => {
    const png = `{"msg":"x","img":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"}`;
    expect(scanLog("media", png, needles).map((h) => h.kind)).toEqual(["image-base64"]);
    expect(scanLog("media", `x ${"QUJD".repeat(300)} y`, needles).map((h) => h.kind)).toEqual(["long-base64"]);
  });

  test("finds arbitrary URLs and evidence locations without returning their values", () => {
    const privateValues = [
      "https://media.example.test/private/object?signature=secret",
      "wss://api.example.test/socket",
      "evidence/0199a3b2/case-1/sealed.bin",
      '"evidenceKey":"bucket/private/case-1/object"',
    ];
    const text = privateValues.join("\n");
    const hits = scanLog("api", text, needles);
    expect(hits.map((hit) => hit.kind)).toEqual(["url", "url", "evidence-location", "evidence-location"]);
    expect(JSON.stringify(hits)).not.toContain("example.test");
    expect(JSON.stringify(hits)).not.toContain("sealed.bin");
    expect(JSON.stringify(hits)).not.toContain("signature");
  });

  test("ignores ids, hashes, tiers, scores and versions", () => {
    const line = JSON.stringify({
      level: "warn",
      msg: "moderation t0 match",
      caseId: "0199a3b2-7c4d-7e8f-9a0b-1c2d3e4f5a6b",
      flagId: "0199a3b2-7c4d-7e8f-9a0b-1c2d3e4f5a6c",
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      tier: "t0",
      category: "csam",
      distance: 12,
      score: 0.97,
      provider: "pdq-local",
      providerVersion: "2026-10-20",
    });
    expect(scanLog("worker", `${line}\n${line}`, needles)).toEqual([]);
  });

  test("one hit per line and kind; the summary never carries the text", () => {
    const text = "a alice_1@harness.test alice_1@harness.test\nb\nc alice_1@harness.test\n";
    const hits = scanLog("api", text, needles);
    expect(hits).toHaveLength(2);
    const summary = summarizeHits([...hits, { source: "media", line: 4, kind: "image-base64" }]);
    expect(summary).toEqual([
      { source: "api", kind: "email", count: 2, firstLine: 1 },
      { source: "media", kind: "image-base64", count: 1, firstLine: 4 },
    ]);
    expect(JSON.stringify(summary)).not.toContain("@");
  });

  test("base64Windows: three alignments, nothing for tiny inputs", () => {
    const windows = base64Windows(bytes);
    expect(windows.length).toBeGreaterThanOrEqual(7);
    for (const w of windows) expect(w).toHaveLength(40);
    expect(base64Windows(new Uint8Array(10))).toEqual([]);
  });

  test("text and email needles drop short or empty values", () => {
    expect(textNeedles("ncii-requester", ["Jo", "  ", "Harness Requester 1"])).toEqual([
      { kind: "ncii-requester", literal: "Harness Requester 1" },
    ]);
    expect(emailNeedles(["", "no-at-sign", "A@b.test", "a@B.test"])).toEqual([
      { kind: "email", literal: "a@b.test", caseInsensitive: true },
    ]);
  });

  test("containers of the scanned services only", () => {
    expect(serviceOfContainer("commonair-api-1", "commonair")).toBe("api");
    expect(serviceOfContainer("commonair_worker_1", "commonair")).toBe("worker");
    expect(serviceOfContainer("commonair-media-2", "commonair")).toBe("media");
    expect(serviceOfContainer("commonair-postgres-1", "commonair")).toBeNull();
    expect(serviceOfContainer("commonair-mock-rtmp-1", "commonair")).toBeNull();
    expect(serviceOfContainer("other-api-1", "commonair")).toBeNull();
    expect(serviceOfContainer("commonair-api", "commonair")).toBeNull();
  });
});

describe("API error shapes", () => {
  test("upload_rejected, mature_gate, NOT_FOUND", () => {
    const rejected = { code: "UNPROCESSABLE_CONTENT", status: 422, data: { reason: "upload_rejected" } };
    expect(isUploadRejected(rejected)).toBe(true);
    expect(isUploadRejected({ code: "UNPROCESSABLE_CONTENT", status: 422 })).toBe(false);
    expect(isMatureGate({ code: "FORBIDDEN", data: { reason: "mature_gate" } })).toBe(true);
    expect(isMatureGate({ code: "FORBIDDEN" })).toBe(false);
    expect(isNotFound({ code: "NOT_FOUND" })).toBe(true);
    expect(apiError(null)).toEqual({ code: null, status: null, reason: null });
    expect(apiError(new Error("x"))).toEqual({ code: null, status: null, reason: null });
    expect(apiError(rejected)).toEqual({ code: "UNPROCESSABLE_CONTENT", status: 422, reason: "upload_rejected" });
  });

  test("errorOf", async () => {
    expect(await errorOf(async () => 1)).toBeNull();
    const e = await errorOf(async () => {
      throw { code: "CONFLICT" };
    });
    expect(apiError(e).code).toBe("CONFLICT");
    expect(await errorOf(() => Promise.reject(undefined))).toBeInstanceOf(Error);
  });
});

describe("fixtures, media and URLs", () => {
  test("fixture paths point at unit A's generated files", () => {
    expect(fixturePath("t0-pattern.png", "/repo/")).toBe("/repo/packages/moderation/fixtures/t0-pattern.png");
    expect(fixturePath("csam.pdq", "/repo")).toBe("/repo/packages/moderation/fixtures/csam.pdq");
  });

  test("the compose override mounts the same fixture list names", () => {
    const yaml = readFileSync(new URL("../compose.trust-safety.yaml", import.meta.url), "utf8");
    expect(yaml).toContain("csam.pdq");
    expect(yaml).toContain("ncii.pdq");
    expect(yaml).toContain('MODERATION_CLASSIFIER: "scripted"');
    expect(yaml).toContain('MODERATION_SAMPLE_SECONDS: "2"');
    expect(yaml).toContain('MODERATION_TEST_HOOKS: "true"');
    for (const service of ["media", "worker", "api"]) expect(yaml).toMatch(new RegExp(`^  ${service}:`, "m"));
  });

  test("the fixture publisher stretches the still (no padding) and loops it", () => {
    const args = buildFixturePublishArgs({ image: "/f/t0-pattern.png", url: "rtmp://h/live/a?key=k" });
    expect(args.slice(args.indexOf("-loop"), args.indexOf("-loop") + 2)).toEqual(["-loop", "1"]);
    expect(args).toContain("/f/t0-pattern.png");
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("scale=1280:720");
    expect(graph).not.toContain("pad=");
    expect(args.at(-1)).toBe("rtmp://h/live/a?key=k");
    expect(args.at(-2)).toBe("flv");
  });

  test("the publisher takes exactly one source", () => {
    expect(() => buildFixturePublishArgs({ url: "rtmp://h" })).toThrow(/exactly one/);
    expect(() => buildFixturePublishArgs({ url: "rtmp://h", image: "a", lavfi: "b" })).toThrow(/exactly one/);
    expect(() => buildFixturePublishArgs({ url: "rtmp://h", lavfi: "b", width: 641 })).toThrow(/even/);
    const lavfi = buildFixturePublishArgs({ url: "rtmp://h", lavfi: benignPatternSource(5) });
    expect(lavfi).toContain("cellauto=rule=30:size=32x18:rate=1:random_seed=5");
    expect(lavfi).not.toContain("-loop");
  });

  test("run seeds are stable, 31-bit and differ between runs", () => {
    expect(runSeed("run-a")).toBe(runSeed("run-a"));
    expect(runSeed("run-a")).not.toBe(runSeed("run-b"));
    for (const id of ["", "x", "20261020-abcdef"]) {
      expect(runSeed(id)).toBeGreaterThanOrEqual(0);
      expect(runSeed(id)).toBeLessThan(2 ** 31);
    }
  });

  test("first frame to stdout as PNG", () => {
    expect(firstFrameArgs("http://m/clip.mp4")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "http://m/clip.mp4",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "pipe:1",
    ]);
  });

  test("URLs and prefixes", () => {
    expect(nciiClipUrl("http://localhost:3000", "f_1", "c-1")).toBe("http://localhost:3000/f_1/clip/c-1");
    expect(avatarPrefix("abc")).toBe("channels/abc/avatar/");
    expect(PROTECTED_TABLES).toEqual(["evidence_objects", "legal_holds", "ncmec_reports"]);
  });

  test("internal secret: harness override first, then the instance env", () => {
    expect(internalSecret({ HARNESS_INTERNAL_API_SECRET: " h " }, { INTERNAL_API_SECRET: "i" })).toBe("h");
    expect(internalSecret({ HARNESS_INTERNAL_API_SECRET: undefined }, { INTERNAL_API_SECRET: "i" })).toBe("i");
    expect(internalSecret({ HARNESS_INTERNAL_API_SECRET: undefined }, {})).toBeUndefined();
  });

  test("findInPages follows cursors and stops", async () => {
    const pages = [
      { items: [1, 2], nextCursor: "a" },
      { items: [3, 4], nextCursor: "b" },
      { items: [5], nextCursor: null },
    ];
    const seen: (string | undefined)[] = [];
    const fetchPage = async (cursor: string | undefined) => {
      seen.push(cursor);
      return pages[seen.length - 1] ?? { items: [], nextCursor: null };
    };
    expect(await findInPages(fetchPage, (n) => n === 4)).toBe(4);
    expect(seen).toEqual([undefined, "a"]);
    seen.length = 0;
    expect(await findInPages(fetchPage, (n) => n === 9)).toBeNull();
    expect(seen).toEqual([undefined, "a", "b"]);
    seen.length = 0;
    expect(await findInPages(fetchPage, (n) => n === 5, 2)).toBeNull();
  });
});

describe("isoOrNull (timestamps from raw queries on the shared client)", () => {
  test("accepts the strings drizzle's adapter leaves behind as well as Dates", () => {
    expect(isoOrNull("2026-10-21 22:05:01.123456+00")).toBe("2026-10-21T22:05:01.123Z");
    expect(isoOrNull(new Date("2026-10-21T22:05:01.123Z"))).toBe("2026-10-21T22:05:01.123Z");
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
  });

  test("refuses garbage instead of reporting a bogus time", () => {
    expect(() => isoOrNull("not a time")).toThrow(/unparseable/);
  });
});
