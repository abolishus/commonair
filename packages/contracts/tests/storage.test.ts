// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Media bucket layout and VOD placement (ADR 0009 amendment 1). */
import { describe, expect, test } from "vite-plus/test";
import { VISIBILITIES, VOD_STATUSES } from "../src/enums.ts";
import {
  isVodOwnPrefix,
  PUBLIC_MEDIA_PREFIXES,
  VOD_PLAYLIST,
  VOD_PRIVATE_PREFIX,
  VOD_PUBLIC_PREFIX,
  VOD_ROUTE,
  VOD_TOKEN_MAX_TTL_SECONDS,
  vodPlacement,
  vodPrefix,
  vodTokenPath,
  type VodPlacementState,
} from "../src/storage.ts";

const ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

/** Public and playable: the only state that places a VOD under `vods/`. */
const PLAYABLE: VodPlacementState = {
  status: "ready",
  visibility: "public",
  removedReason: null,
  broadcastRestricted: false,
  channelSuspended: false,
  nciiHidden: false,
  dmcaHidden: false,
};

describe("prefixes", () => {
  test("the public allowlist names vods/ and never the private prefix", () => {
    expect([...PUBLIC_MEDIA_PREFIXES].sort()).toEqual(["channels", "clips", "thumbnails", "vods"]);
    expect(PUBLIC_MEDIA_PREFIXES).toContain(VOD_PUBLIC_PREFIX.slice(0, -1));
    expect(PUBLIC_MEDIA_PREFIXES).not.toContain(VOD_PRIVATE_PREFIX.slice(0, -1));
  });

  test("vodPrefix per placement, with a trailing slash", () => {
    expect(vodPrefix(ID, "public")).toBe(`vods/${ID}/`);
    expect(vodPrefix(ID, "private")).toBe(`recordings/${ID}/`);
    expect(VOD_PLAYLIST).toBe("index.m3u8");
  });

  test("isVodOwnPrefix accepts exactly the VOD's two prefixes", () => {
    expect(isVodOwnPrefix(ID, `vods/${ID}/`)).toBe(true);
    expect(isVodOwnPrefix(ID, `recordings/${ID}/`)).toBe(true);
    for (const bad of [
      `vods/${ID}`,
      `recordings/${ID}`,
      `vods/${ID.slice(0, -1)}/`,
      `vods/${ID}/x/`,
      "vods/",
      "",
      `moderation/dmca/vods/${ID}/`,
      `moderation/ncii-hidden/vods/${ID}/`,
      `clips/${ID}/`,
      `VODS/${ID}/`,
    ])
      expect(isVodOwnPrefix(ID, bad), bad).toBe(false);
    expect(isVodOwnPrefix("other", `vods/${ID}/`)).toBe(false);
  });

  test("VOD route and token path", () => {
    expect(VOD_ROUTE).toBe("/vod/");
    expect(vodTokenPath(ID)).toBe(`vod/${ID}`);
    expect(vodTokenPath(ID).startsWith("live/")).toBe(false);
    expect(VOD_TOKEN_MAX_TTL_SECONDS).toBe(43_200);
  });
});

describe("vodPlacement", () => {
  test("public and playable is public", () => {
    expect(vodPlacement(PLAYABLE)).toBe("public");
  });

  test("every status but ready is private, and deleted is left alone", () => {
    for (const status of VOD_STATUSES) {
      const want = status === "ready" ? "public" : status === "deleted" ? "leave" : "private";
      expect(vodPlacement({ ...PLAYABLE, status }), status).toBe(want);
    }
  });

  test("subscribers and private visibility are private", () => {
    for (const visibility of VISIBILITIES)
      expect(vodPlacement({ ...PLAYABLE, visibility }), visibility).toBe(
        visibility === "public" ? "public" : "private",
      );
  });

  test("any removed_reason is private, dmca included", () => {
    for (const removedReason of ["owner", "retention", "dmca", "t0", ""])
      expect(vodPlacement({ ...PLAYABLE, removedReason }), removedReason).toBe("private");
  });

  test("a T1-restricted broadcast or a suspended channel is private", () => {
    expect(vodPlacement({ ...PLAYABLE, broadcastRestricted: true })).toBe("private");
    expect(vodPlacement({ ...PLAYABLE, channelSuspended: true })).toBe("private");
  });

  test("NCII-hidden and DMCA-hidden VODs are left where their flow put them", () => {
    expect(vodPlacement({ ...PLAYABLE, nciiHidden: true })).toBe("leave");
    expect(vodPlacement({ ...PLAYABLE, dmcaHidden: true })).toBe("leave");
    // A DMCA-disabled VOD also carries removed_reason = 'dmca'; leave still wins.
    expect(vodPlacement({ ...PLAYABLE, dmcaHidden: true, removedReason: "dmca" })).toBe("leave");
    expect(vodPlacement({ ...PLAYABLE, status: "processing", nciiHidden: true })).toBe("leave");
  });

  test("deleted wins over everything", () => {
    expect(
      vodPlacement({
        status: "deleted",
        visibility: "private",
        removedReason: "owner",
        broadcastRestricted: true,
        channelSuspended: true,
        nciiHidden: false,
        dmcaHidden: false,
      }),
    ).toBe("leave");
  });

  test("exhaustive: leave, else public exactly when every condition holds", () => {
    const bools = [false, true];
    for (const status of VOD_STATUSES)
      for (const visibility of VISIBILITIES)
        for (const removedReason of [null, "owner"])
          for (const broadcastRestricted of bools)
            for (const channelSuspended of bools)
              for (const nciiHidden of bools)
                for (const dmcaHidden of bools) {
                  const s = {
                    status,
                    visibility,
                    removedReason,
                    broadcastRestricted,
                    channelSuspended,
                    nciiHidden,
                    dmcaHidden,
                  };
                  const leave = status === "deleted" || nciiHidden || dmcaHidden;
                  const pub =
                    status === "ready" &&
                    visibility === "public" &&
                    removedReason === null &&
                    !broadcastRestricted &&
                    !channelSuspended;
                  expect(vodPlacement(s), JSON.stringify(s)).toBe(leave ? "leave" : pub ? "public" : "private");
                }
  });
});
