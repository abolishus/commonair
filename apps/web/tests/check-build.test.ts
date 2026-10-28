// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { checkBuild, linkedStylesheets, missingStylesheets } from "../scripts/check-build.ts";

describe("missingStylesheets", () => {
  it("passes when every linked stylesheet is a client asset", () => {
    const server = [`{rel:"stylesheet",href:"/assets/styles-xV0I8Qky.css"}`];
    expect(missingStylesheets(server, ["styles-xV0I8Qky.css", "main-abc.js"])).toEqual([]);
  });

  it("reports the SSR/client hash mismatch seen in the image", () => {
    const server = [`href:"/assets/styles-DMoutwGj.css"`];
    expect(missingStylesheets(server, ["styles-xV0I8Qky.css"])).toEqual(["styles-DMoutwGj.css"]);
  });

  it("dedupes and sorts across files", () => {
    const server = [`"/assets/b-1.css" "/assets/a-1.css"`, `"/assets/b-1.css"`];
    expect(linkedStylesheets(server)).toEqual(["a-1.css", "b-1.css"]);
    expect(missingStylesheets(server, [])).toEqual(["a-1.css", "b-1.css"]);
  });

  it("ignores non-asset css paths", () => {
    expect(linkedStylesheets([`import "./styles.css"; "/static/x.css"`])).toEqual([]);
  });
});

describe("checkBuild", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function dist(serverJs: string, clientAssets: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "check-build-"));
    dirs.push(root);
    mkdirSync(join(root, "server", "assets"), { recursive: true });
    mkdirSync(join(root, "client", "assets"), { recursive: true });
    writeFileSync(join(root, "server", "assets", "router-x.js"), serverJs);
    for (const a of clientAssets) writeFileSync(join(root, "client", "assets", a), "");
    return root;
  }

  it("accepts a consistent build", () => {
    expect(checkBuild(dist(`"/assets/styles-ok.css"`, ["styles-ok.css"]))).toEqual([]);
  });

  it("flags a server stylesheet missing from the client assets", () => {
    const problems = checkBuild(dist(`"/assets/styles-ssr.css"`, ["styles-client.css"]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/assets/styles-ssr.css");
  });

  it("flags a server bundle that links no stylesheet at all", () => {
    expect(checkBuild(dist(`export {}`, ["styles-ok.css"]))[0]).toContain("links no");
  });

  it("flags missing build output", () => {
    expect(checkBuild(join(tmpdir(), "check-build-does-not-exist"))[0]).toContain("no build output");
  });
});
