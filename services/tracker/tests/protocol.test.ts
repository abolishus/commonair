// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { binaryToHex, isBinaryId, LIMITS, parseFrame } from "../src/protocol.ts";
import { answerSdp, binaryId, id, offerSdp } from "./helpers.ts";

const announce = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ action: "announce", info_hash: binaryId(1), peer_id: binaryId(2), ...extra });

describe("isBinaryId", () => {
  test("accepts 20 chars in 0–255, including NUL and 0xff", () => {
    expect(isBinaryId(id(0))).toBe(true);
    expect(isBinaryId(id(255))).toBe(true);
    expect(isBinaryId(binaryId(7))).toBe(true);
  });
  test("refuses wrong lengths, wide chars and non-strings", () => {
    expect(isBinaryId(id(1).slice(1))).toBe(false);
    expect(isBinaryId(`${id(1)}x`)).toBe(false);
    expect(isBinaryId(`${id(1).slice(1)}Ā`)).toBe(false);
    expect(isBinaryId(`${id(1).slice(2)}😀`)).toBe(false);
    expect(isBinaryId(42)).toBe(false);
    expect(isBinaryId(null)).toBe(false);
  });
  test("binaryToHex is 40 lower-case hex chars", () => {
    expect(binaryToHex(id(255))).toBe("ff".repeat(20));
    expect(binaryToHex(id(0))).toBe("00".repeat(20));
  });
});

describe("parseFrame: announce", () => {
  test("minimal announce", () => {
    const r = parseFrame(announce());
    expect(r).toEqual({
      ok: true,
      frame: { action: "announce", infoHash: binaryId(1), peerId: binaryId(2), offers: [] },
    });
  });

  test("full announce with offers (as browser WebTorrent sends)", () => {
    const r = parseFrame(
      announce({
        numwant: 5,
        uploaded: 0,
        downloaded: 10,
        left: 0,
        event: "started",
        offers: [{ offer: offerSdp(1), offer_id: binaryId(9) }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.frame.action !== "announce") throw new Error("unreachable");
    expect(r.frame.numwant).toBe(5);
    expect(r.frame.left).toBe(0);
    expect(r.frame.event).toBe("started");
    expect(r.frame.offers).toEqual([{ offer: offerSdp(1), offerId: binaryId(9) }]);
  });

  test("answer frame", () => {
    const r = parseFrame(announce({ answer: answerSdp, to_peer_id: binaryId(3), offer_id: binaryId(4) }));
    if (!r.ok || r.frame.action !== "announce") throw new Error("expected ok");
    expect(r.frame.answer).toEqual({ sdp: answerSdp, toPeerId: binaryId(3), offerId: binaryId(4) });
  });

  test("ignores unknown extra fields and null left/event", () => {
    expect(parseFrame(announce({ trackerid: "x", left: null, event: null })).ok).toBe(true);
  });

  test.each([
    ["short info_hash", { info_hash: "abc" }, "invalid info_hash"],
    ["wide info_hash", { info_hash: `${id(1).slice(1)}ā` }, "invalid info_hash"],
    ["missing peer_id", { peer_id: undefined }, "invalid peer_id"],
    ["long peer_id", { peer_id: `${id(1)}a` }, "invalid peer_id"],
    ["negative numwant", { numwant: -1 }, "invalid numwant"],
    ["fractional numwant", { numwant: 1.5 }, "invalid numwant"],
    ["string left", { left: "0" }, "invalid left"],
    ["negative uploaded", { uploaded: -5 }, "invalid uploaded"],
    ["unknown event", { event: "paused" }, "invalid event"],
    ["offers not array", { offers: {} }, "invalid offers"],
    ["bad offer_id", { offers: [{ offer: offerSdp(), offer_id: "short" }] }, "invalid offer_id"],
    ["offer wrong type", { offers: [{ offer: answerSdp, offer_id: id(3) }] }, "invalid offer"],
    ["offer empty sdp", { offers: [{ offer: { type: "offer", sdp: "" }, offer_id: id(3) }] }, "invalid offer"],
    [
      "offer sdp too long",
      { offers: [{ offer: { type: "offer", sdp: "a".repeat(LIMITS.maxSdpLength + 1) }, offer_id: id(3) }] },
      "invalid offer",
    ],
    [
      "too many offers",
      {
        offers: Array.from({ length: LIMITS.maxOffersPerAnnounce + 1 }, (_, i) => ({
          offer: offerSdp(i),
          offer_id: id(i),
        })),
      },
      "too many offers",
    ],
    ["answer wrong type", { answer: offerSdp(), to_peer_id: id(3), offer_id: id(4) }, "invalid answer"],
    ["answer without to_peer_id", { answer: answerSdp, offer_id: id(4) }, "invalid to_peer_id"],
    ["answer without offer_id", { answer: answerSdp, to_peer_id: id(3) }, "invalid offer_id"],
  ])("refuses %s", (_, extra, reason) => {
    expect(parseFrame(announce(extra))).toMatchObject({ ok: false, reason });
  });

  test("failure carries the info_hash once it is valid", () => {
    const r = parseFrame(announce({ peer_id: "x" }));
    expect(r).toEqual({ ok: false, reason: "invalid peer_id", infoHash: binaryId(1) });
  });

  test("exactly the offer limit is accepted", () => {
    const offers = Array.from({ length: LIMITS.maxOffersPerAnnounce }, (_, i) => ({
      offer: offerSdp(i),
      offer_id: id(i),
    }));
    expect(parseFrame(announce({ offers })).ok).toBe(true);
  });
});

describe("parseFrame: scrape and envelope", () => {
  test("scrape with one, many and no hashes", () => {
    expect(parseFrame(JSON.stringify({ action: "scrape", info_hash: id(1) }))).toEqual({
      ok: true,
      frame: { action: "scrape", infoHashes: [id(1)] },
    });
    expect(parseFrame(JSON.stringify({ action: "scrape", info_hash: [id(1), id(2), id(1)] }))).toEqual({
      ok: true,
      frame: { action: "scrape", infoHashes: [id(1), id(2)] },
    });
    expect(parseFrame(JSON.stringify({ action: "scrape" }))).toEqual({
      ok: true,
      frame: { action: "scrape", infoHashes: [] },
    });
  });
  test("scrape refuses bad and too many hashes", () => {
    expect(parseFrame(JSON.stringify({ action: "scrape", info_hash: ["x"] })).ok).toBe(false);
    const many = Array.from({ length: LIMITS.maxScrapeHashes + 1 }, (_, i) => id(i));
    expect(parseFrame(JSON.stringify({ action: "scrape", info_hash: many })).ok).toBe(false);
  });
  test.each([
    ["not json", "{", "invalid json"],
    ["array", "[]", "invalid frame"],
    ["null", "null", "invalid frame"],
    ["unknown action", JSON.stringify({ action: "connect" }), "invalid action"],
    ["oversized", " ".repeat(LIMITS.maxFrameBytes + 1), "frame too large"],
  ])("refuses %s", (_, text, reason) => {
    expect(parseFrame(text)).toMatchObject({ ok: false, reason });
  });
});
