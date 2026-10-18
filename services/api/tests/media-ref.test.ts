// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import type { Deps } from "../src/deps.ts";
import { instanceMediaPrefixes, isInstanceMediaRef } from "../src/lib/media-ref.ts";

const prefixes = instanceMediaPrefixes({
  PUBLIC_URL: "https://Example.Test",
  API_PUBLIC_URL: "https://api.example.test/api",
  S3_ENDPOINT: "http://garage:3900",
  S3_PUBLIC_ENDPOINT: "https://media.example.test/",
  S3_BUCKET_MEDIA: "media",
} as Deps["env"]);

test("prefixes are normalized origins plus the public media bucket", () => {
  expect(prefixes).toEqual(["https://example.test/", "https://api.example.test/", "https://media.example.test/media/"]);
});

test("own storage keys pass; foreign, climbing or malformed keys do not", () => {
  const own = "channels/abc/avatar/";
  expect(isInstanceMediaRef("channels/abc/avatar/01.png", prefixes, own)).toBe(true);
  expect(isInstanceMediaRef("channels/xyz/avatar/01.png", prefixes, own)).toBe(false);
  expect(isInstanceMediaRef("channels/abc/avatar/../../xyz/a.png", prefixes, own)).toBe(false);
  expect(isInstanceMediaRef("channels/abc/avatar//a.png", prefixes, own)).toBe(false);
  expect(isInstanceMediaRef("/channels/abc/avatar/a.png", prefixes, own)).toBe(false);
  expect(isInstanceMediaRef("channels/abc/avatar/a b.png", prefixes, own)).toBe(false);
  expect(isInstanceMediaRef("", prefixes, own)).toBe(false);
  expect(isInstanceMediaRef("anything/at/all.png", prefixes)).toBe(true);
  expect(isInstanceMediaRef("channels/abc/avatar/a.png", prefixes, "/")).toBe(false);
});

test("same-instance URLs pass; third-party and look-alike URLs do not", () => {
  for (const ok of [
    "https://example.test/static/default-avatar.png",
    "https://EXAMPLE.test/x.png",
    "https://media.example.test/media/channels/a/avatar/b.png",
    "https://api.example.test/anything",
  ])
    expect(isInstanceMediaRef(ok, prefixes), ok).toBe(true);
  for (const bad of [
    "https://tracker.invalid/pixel.gif",
    "https://example.test.evil.invalid/x.png",
    "https://example.test@evil.invalid/x.png",
    "https://user:pw@example.test/x.png",
    "http://example.test/x.png", // wrong scheme for the configured origin
    "https://media.example.test/other-bucket/x.png",
    "https://media.example.test/mediaevil/x.png",
    "//evil.invalid/x.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "ftp://example.test/x.png",
  ])
    expect(isInstanceMediaRef(bad, prefixes), bad).toBe(false);
});
