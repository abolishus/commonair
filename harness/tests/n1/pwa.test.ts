// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 6's checks: the manifest, Cache Storage and the shown notification. */
import { describe, expect, it } from "vite-plus/test";
import { cacheProblems, manifestProblems, notificationProblems, step } from "../../src/n1/pwa.ts";

const ORIGIN = "http://localhost:3000";

const manifest = {
  id: "/",
  name: "Harness Air",
  short_name: "Harness Air",
  start_url: "/",
  scope: "/",
  display: "standalone",
  icons: [
    { src: "/icons/icon.svg", sizes: "any", purpose: "any" },
    { src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" },
    { src: "/icons/maskable-512.png", sizes: "512x512", purpose: "maskable" },
  ],
};

describe("step 6", () => {
  it("is N1-pwa's, web only, with no other step needed", () => {
    expect(step).toMatchObject({ owner: "N1-pwa", needs: [], webOnly: true });
    expect(step.requires).toBeUndefined();
  });
});

describe("manifestProblems", () => {
  it("accepts the instance's manifest", () => {
    expect(manifestProblems(manifest, "Harness Air")).toEqual([]);
  });

  it("refuses another name, a wrong scope or display, and missing icons", () => {
    expect(manifestProblems(manifest, "Other Air")).toHaveLength(1);
    expect(manifestProblems({ ...manifest, scope: "/app/" }, "Harness Air")).toEqual([
      'scope is "/app/", expected "/"',
    ]);
    expect(manifestProblems({ ...manifest, display: "browser" }, "Harness Air")).toHaveLength(1);
    expect(manifestProblems({ ...manifest, icons: [] }, "Harness Air")).toEqual([
      "no 192x192 icon",
      "no 512x512 icon",
      "no maskable icon",
    ]);
    expect(
      manifestProblems({ ...manifest, icons: manifest.icons.filter((i) => i.purpose !== "maskable") }, "Harness Air"),
    ).toEqual(["no maskable icon"]);
  });

  it("refuses something that is not an object", () => {
    expect(manifestProblems(null, "x")).toHaveLength(1);
    expect(manifestProblems("x", "x")).toHaveLength(1);
  });
});

describe("cacheProblems", () => {
  const shell = { name: "commonair-shell-abc", urls: [`${ORIGIN}/assets/index-a.js`, `${ORIGIN}/icons/icon-192.png`] };

  it("accepts a shell cache of static files", () => {
    expect(cacheProblems([shell], ORIGIN)).toEqual([]);
  });

  it.each(["/api/auth/get-session", "/rpc/me/get", "/hls/x/index.m3u8", "/media/a.png", "/vod/x/1.ts"])(
    "refuses a cached %s",
    (path) => {
      expect(cacheProblems([{ ...shell, urls: [...shell.urls, `${ORIGIN}${path}`] }], ORIGIN)).toEqual([
        `cached ${path}`,
      ]);
    },
  );

  it("refuses a document, another origin, another cache and an empty store", () => {
    expect(cacheProblems([{ ...shell, urls: [`${ORIGIN}/somebody`] }], ORIGIN)).toHaveLength(1);
    expect(cacheProblems([{ ...shell, urls: ["https://cdn.example/assets/a.js"] }], ORIGIN)).toHaveLength(1);
    expect(cacheProblems([shell, { name: "other", urls: [`${ORIGIN}/assets/a.js`] }], ORIGIN)).toEqual([
      'unexpected cache "other"',
    ]);
    expect(cacheProblems([], ORIGIN)).toHaveLength(1);
    expect(cacheProblems([{ name: "commonair-shell-x", urls: [] }], ORIGIN)).toHaveLength(1);
  });
});

describe("notificationProblems", () => {
  const ok = { title: "abc_d is live", tag: "go-live-abc_d", data: { url: "/abc_d" } };

  it("accepts one notification for the channel", () => {
    expect(notificationProblems([ok], "abc_d")).toEqual([]);
    expect(notificationProblems([ok, { ...ok, tag: "go-live-other" }], "abc_d")).toEqual([]);
  });

  it("refuses none, two, a title without the slug and a wrong URL", () => {
    expect(notificationProblems([], "abc_d")).toHaveLength(1);
    expect(notificationProblems([ok, ok], "abc_d")).toHaveLength(1);
    expect(notificationProblems([{ ...ok, title: "Someone is live" }], "abc_d")).toHaveLength(1);
    expect(notificationProblems([{ ...ok, data: { url: "https://evil.example" } }], "abc_d")).toHaveLength(1);
    expect(notificationProblems([{ ...ok, data: null }], "abc_d")).toHaveLength(1);
  });
});
