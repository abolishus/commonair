// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import type { Deps } from "../src/deps.ts";
import { mediaUrl } from "../src/lib/dto.ts";
import { instanceMediaBase, isInstanceMediaRef } from "../src/lib/media-ref.ts";

const base = instanceMediaBase({ MEDIA_PUBLIC_URL: "https://Media.Example.Test/media/" });
const own = "channels/abc/avatar/";

test("the base is the normalized MEDIA_PUBLIC_URL, never the S3 API", () => {
  expect(base).toBe("https://media.example.test/media/");
  expect(instanceMediaBase({ MEDIA_PUBLIC_URL: "http://localhost:3003/media" })).toBe("http://localhost:3003/media/");
});

test("mediaUrl builds MEDIA_PUBLIC_URL/<key> with each segment encoded", () => {
  const deps = { env: { MEDIA_PUBLIC_URL: "http://localhost:3003/media/" } as Deps["env"] };
  expect(mediaUrl(deps, "clips/0190-ab.mp4")).toBe("http://localhost:3003/media/clips/0190-ab.mp4");
  expect(mediaUrl(deps, "channels/c/avatar/a b#.png")).toBe(
    "http://localhost:3003/media/channels/c/avatar/a%20b%23.png",
  );
  expect(mediaUrl(deps, "https://avatars.example.test/u.png")).toBe("https://avatars.example.test/u.png");
  expect(mediaUrl(deps, null)).toBeNull();
  expect(mediaUrl(deps, "")).toBeNull();
  // URLs it builds are accepted back as instance media references.
  const own = mediaUrl(deps, "channels/abc/avatar/01.png") as string;
  expect(isInstanceMediaRef(own, instanceMediaBase(deps.env), "channels/abc/avatar/")).toBe(true);
});

test("own storage keys pass; foreign, climbing or malformed keys do not", () => {
  expect(isInstanceMediaRef("channels/abc/avatar/01.png", base, own)).toBe(true);
  expect(isInstanceMediaRef("channels/xyz/avatar/01.png", base, own)).toBe(false);
  expect(isInstanceMediaRef("channels/abc/avatar/../../xyz/a.png", base, own)).toBe(false);
  expect(isInstanceMediaRef("channels/abc/avatar//a.png", base, own)).toBe(false);
  expect(isInstanceMediaRef("/channels/abc/avatar/a.png", base, own)).toBe(false);
  expect(isInstanceMediaRef("channels/abc/avatar/a b.png", base, own)).toBe(false);
  expect(isInstanceMediaRef("", base, own)).toBe(false);
  expect(isInstanceMediaRef("anything/at/all.png", base)).toBe(true);
});

test("URLs must be in the media bucket and their key must carry the channel prefix", () => {
  expect(isInstanceMediaRef("https://media.example.test/media/channels/abc/avatar/b.png", base, own)).toBe(true);
  expect(isInstanceMediaRef("https://MEDIA.example.test/media/channels/abc/avatar/b.png", base, own)).toBe(true);
  for (const bad of [
    "https://media.example.test/media/channels/xyz/avatar/b.png", // another channel's upload
    "https://media.example.test/media/channels/abc/banner/b.png", // wrong purpose
    "https://media.example.test/media/channels/abc/avatar/%2e%2e/%2e%2e/xyz/avatar/b.png",
    "https://media.example.test/media/channels/abc/avatar/../../xyz/avatar/b.png",
    "https://media.example.test/media/channels/abc/avatar/b.png?x=1",
    "https://media.example.test/media/channels/abc/avatar/b.png#f",
    "https://example.test/static/default-avatar.png", // the web origin is not the media bucket
    "https://tracker.invalid/pixel.gif",
    "https://media.example.test.evil.invalid/media/channels/abc/avatar/b.png",
    "https://media.example.test@evil.invalid/media/channels/abc/avatar/b.png",
    "https://user:pw@media.example.test/media/channels/abc/avatar/b.png",
    "http://media.example.test/media/channels/abc/avatar/b.png", // wrong scheme
    "https://media.example.test/other/channels/abc/avatar/b.png",
    "https://media.example.test/commonair-media/channels/abc/avatar/b.png", // the S3 API path shape
    "https://media.example.test/mediaevil/channels/abc/avatar/b.png",
    "//evil.invalid/x.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
  ])
    expect(isInstanceMediaRef(bad, base, own), bad).toBe(false);
});
