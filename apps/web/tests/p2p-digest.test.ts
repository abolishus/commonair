// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The tamper test (ADR 0005 amendment 1, decision 7; there is no harness tamperer): peer-delivered
 * segments are checked against the origin's digest and everything that is not a clean match
 * fails closed. The pinned loader's own handling of `false` (drop the bytes, disconnect the peer,
 * load again) is pinned against its source.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { DigestValidator, digestUrlFor, mediaTail, sha256Hex } from "../src/player/p2p/digest.ts";

const DIGEST_BASE = "https://play.example/p2p-digest";
const SEGMENT = new TextEncoder().encode("segment bytes as /hls/ serves them").buffer;
const HEX = createHash("sha256").update(new Uint8Array(SEGMENT)).digest("hex");

const ORIGIN_URL = "https://play.example/hls/live/rivertide/720p/seg42.mp4?t=old-token";
const RELAY_URL = "https://relay-7.example.net/hls/live/rivertide/720p/seg42.mp4?t=old-token&x=1";
const CDN_URL = "https://cdn.example/cdn/live/rivertide/720p/seg42.mp4?t=old-token";
const SOURCE_URL = "https://play.example/hls/live/rivertide/seg7.mp4?t=old-token";

function response(status: number, body: string) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function setup(answer: (url: string) => Response | Promise<Response>, token = "current-token") {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => answer(url));
  const onRejected = vi.fn<() => void>();
  const onHttpBytes = vi.fn<() => void>();
  const v = new DigestValidator({ digestBase: DIGEST_BASE, token: () => token, onRejected, onHttpBytes, fetch });
  return { v, fetch, onRejected, onHttpBytes };
}

describe("digestUrlFor", () => {
  it("builds the origin digest URL from origin, relay and CDN segment URLs with the current token", () => {
    const expected = `${DIGEST_BASE}/live/rivertide/720p/seg42.mp4?t=current-token`;
    for (const url of [ORIGIN_URL, RELAY_URL, CDN_URL])
      expect(digestUrlFor(DIGEST_BASE, url, "current-token")).toBe(expected);
  });

  it("handles the source path (no rendition) and a trailing slash on the base", () => {
    expect(digestUrlFor(`${DIGEST_BASE}/`, SOURCE_URL, "tk")).toBe(`${DIGEST_BASE}/live/rivertide/seg7.mp4?t=tk`);
  });

  it("encodes the token", () => {
    expect(digestUrlFor(DIGEST_BASE, SOURCE_URL, "a+b/c=")).toBe(
      `${DIGEST_BASE}/live/rivertide/seg7.mp4?t=a%2Bb%2Fc%3D`,
    );
  });

  it("refuses anything that is not a media path", () => {
    for (const url of [
      "https://play.example/hls/live/rivertide/a/b/seg.mp4",
      "https://play.example/other/rivertide/seg.mp4",
      "https://play.example/hls/live/RiverTide/seg.mp4",
      "https://play.example/hls/live/rivertide/seg",
      "not a url",
    ])
      expect(digestUrlFor(DIGEST_BASE, url, "tk"), url).toBeNull();
  });

  it("the cache key is the path after the route prefix, the same on every source", () => {
    expect(new Set([ORIGIN_URL, RELAY_URL, CDN_URL].map(mediaTail))).toEqual(
      new Set(["/live/rivertide/720p/seg42.mp4"]),
    );
  });
});

describe("sha256Hex", () => {
  it("is lowercase hex SHA-256", async () => {
    expect(await sha256Hex(SEGMENT)).toBe(HEX);
  });
});

describe("DigestValidator.validate", () => {
  it("accepts matching bytes and counts the digest response as HTTP bytes", async () => {
    const { v, fetch, onRejected, onHttpBytes } = setup(() => response(200, `${HEX}\n`));
    await expect(v.validate(RELAY_URL, undefined, SEGMENT)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      `${DIGEST_BASE}/live/rivertide/720p/seg42.mp4?t=current-token`,
      expect.anything(),
    );
    expect(onRejected).not.toHaveBeenCalled();
    expect(onHttpBytes).toHaveBeenCalledWith(65);
  });

  it("rejects one flipped byte and counts the rejection", async () => {
    const { v, onRejected } = setup(() => response(200, HEX));
    const tampered = new Uint8Array(SEGMENT.slice(0));
    tampered[3] = (tampered[3] ?? 0) ^ 0x01;
    await expect(v.validate(ORIGIN_URL, undefined, tampered.buffer)).resolves.toBe(false);
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a byte range", () => response(200, HEX), { start: 0, end: 10 }],
    ["a 404", () => response(404, "not found"), undefined],
    ["a 403", () => response(403, "forbidden"), undefined],
    ["a malformed body", () => response(200, "not-a-digest"), undefined],
    ["an uppercase digest", () => response(200, HEX.toUpperCase()), undefined],
    ["a 200 with a short digest", () => response(200, HEX.slice(1)), undefined],
    [
      "a network error",
      () => {
        throw new TypeError("network");
      },
      undefined,
    ],
  ] as const)("fails closed on %s", async (_name, answer, range) => {
    const { v, onRejected } = setup(answer);
    await expect(v.validate(ORIGIN_URL, range, SEGMENT)).resolves.toBe(false);
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("never fetches a digest for a byte range (whole segments only)", async () => {
    const { v, fetch } = setup(() => response(200, HEX));
    await v.validate(ORIGIN_URL, { start: 0, end: 10 }, SEGMENT);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed without a token and for a URL outside the media grammar", async () => {
    const noToken = new DigestValidator({
      digestBase: DIGEST_BASE,
      token: () => undefined,
      onRejected: vi.fn<() => void>(),
      onHttpBytes: vi.fn<() => void>(),
      fetch: vi.fn<(url: string) => Promise<Response>>(async () => response(200, HEX)),
    });
    await expect(noToken.validate(ORIGIN_URL, undefined, SEGMENT)).resolves.toBe(false);
    const { v, fetch } = setup(() => response(200, HEX));
    await expect(v.validate("https://play.example/elsewhere/seg.mp4", undefined, SEGMENT)).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the token current at fetch time", async () => {
    let token = "first";
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => response(200, HEX));
    const v = new DigestValidator({
      digestBase: DIGEST_BASE,
      token: () => token,
      onRejected: vi.fn<() => void>(),
      onHttpBytes: vi.fn<() => void>(),
      fetch,
    });
    await v.validate(ORIGIN_URL, undefined, SEGMENT);
    token = "refreshed";
    await v.validate(SOURCE_URL, undefined, SEGMENT);
    expect(fetch.mock.calls.map((c) => new URL(c[0]).searchParams.get("t"))).toEqual(["first", "refreshed"]);
  });

  it("fetches each object once per session, also from different sources and concurrently", async () => {
    const { v, fetch } = setup(() => response(200, HEX));
    await Promise.all([v.validate(ORIGIN_URL, undefined, SEGMENT), v.validate(RELAY_URL, undefined, SEGMENT)]);
    await v.validate(CDN_URL, undefined, SEGMENT);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed answer: the next delivery asks again", async () => {
    let status = 503;
    const { v, fetch } = setup(() => response(status, status === 200 ? HEX : "busy"));
    await expect(v.validate(ORIGIN_URL, undefined, SEGMENT)).resolves.toBe(false);
    status = 200;
    await expect(v.validate(ORIGIN_URL, undefined, SEGMENT)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a bounded number of digests", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => response(200, HEX));
    const v = new DigestValidator({
      digestBase: DIGEST_BASE,
      token: () => "tk",
      onRejected: vi.fn<() => void>(),
      onHttpBytes: vi.fn<() => void>(),
      fetch,
      maxEntries: 2,
    });
    const seg = (n: number) => `https://play.example/hls/live/rivertide/seg${n}.mp4?t=tk`;
    for (const n of [1, 2, 3]) await v.validate(seg(n), undefined, SEGMENT);
    await v.validate(seg(3), undefined, SEGMENT);
    expect(fetch).toHaveBeenCalledTimes(3);
    await v.validate(seg(1), undefined, SEGMENT);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("logs nothing (no URL, token or digest in the console)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { v } = setup(() => response(403, "nope"));
    await v.validate(ORIGIN_URL, undefined, SEGMENT);
    const ok = setup(() => response(200, HEX));
    await ok.v.validate(ORIGIN_URL, undefined, SEGMENT);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

describe("the pinned loader's handling of a failed validation", () => {
  // p2p-media-loader-core 4.0.0, src/p2p/peer.ts: the source this player was written against.
  const pkg = realpathSync(join(new URL("../node_modules/p2p-media-loader-core", import.meta.url).pathname));
  const peer = readFileSync(join(pkg, "src/p2p/peer.ts"), "utf8");
  const request = readFileSync(join(pkg, "src/requests/request.ts"), "utf8");
  const http = readFileSync(join(pkg, "src/http-loader.ts"), "utf8");

  it("is version 4.0.0", () => {
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("4.0.0");
  });

  it("disconnects the peer that sent a segment failing validation", () => {
    const branch =
      /const isValid = await request\.validateData\(\s*this\.#peerConfig\.validateP2PSegment,?\s*\);[\s\S]*?if \(!isValid\) \{\s*this\.#destroyOnPeerError\(\s*"validation-failed"/;
    expect(peer).toMatch(branch);
  });

  it("drops the bytes, fails the request (so it loads again) and destroys the peer", () => {
    const fn = /#destroyOnPeerError\(type: PeerErrorType, message: string\) \{([\s\S]*?)\n {2}\}/.exec(peer)?.[1] ?? "";
    expect(fn).toContain("request.clearLoadedBytes()");
    expect(fn).toContain('this.#cancelSegmentDownloading("peer-closed", error)');
    expect(fn).toContain("this.destroy(false, error)");
  });

  it("keeps a peer's partial bytes when it stalls, answers absent or is aborted; only a peer error clears them", () => {
    expect(peer.match(/clearLoadedBytes\(\)/g)).toHaveLength(1);
    const fn = /#destroyOnPeerError\(type: PeerErrorType, message: string\) \{[\s\S]*?\n {2}\}/.exec(peer)?.[0] ?? "";
    expect(fn).toContain("clearLoadedBytes()");
    const cancel = /\n {2}cancel\(\) \{([\s\S]*?)\n {2}\}/.exec(request)?.[1] ?? "";
    expect(cancel).not.toContain("clearLoadedBytes");
    expect(cancel).toContain("this.onSegmentAbort(");
  });

  it("resumes such a request over HTTP from the loaded bytes and checks the result only with validateHTTPSegment", () => {
    const execute = /\n {2}execute\(\) \{([\s\S]*?)\n {2}\}/.exec(http)?.[1] ?? "";
    expect(execute).toMatch(/tryCompleteByLoadedBytes\([\s\S]*?this\.httpConfig\.validateHTTPSegment/);
    expect(execute).toMatch(/this\.requestByteRange\.start \+ this\.request\.loadedBytes/);
    expect(http).toMatch(
      /const isValid = await this\.request\.validateData\(\s*this\.httpConfig\.validateHTTPSegment,?\s*\);[\s\S]*?if \(!isValid\) \{\s*this\.request\.clearLoadedBytes\(\);/,
    );
    // The peer that started it is reported with its URL, so the player knows which HTTP completions to check.
    expect(request).toMatch(
      /this\.onSegmentStart\(\{\s*segment: mapSegmentWithStreamToSegment\(this\.segment\),\s*downloadSource: requestData\.downloadSource/,
    );
  });

  it("treats a validator that throws as a failed validation", () => {
    const fn = /async validateData\([\s\S]*?\n {2}\}/.exec(request)?.[0] ?? "";
    expect(fn).toMatch(/catch \(err\) \{[\s\S]*return false;/);
  });
});
