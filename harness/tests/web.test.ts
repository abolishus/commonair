// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The web ↔ harness contract (docs/testing/e1-selectors.md) and the pure helpers e2e-basic uses. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { extractLinks, findTokenLink } from "../src/mailpit.ts";
import { ROUTES, ROUTE_PATTERNS, TEST_IDS, tid, webEmbedUrl } from "../src/web/selectors.ts";
import { browserVerificationUrl, obsPublishUrl, rebaseOrigin } from "../src/web/urls.ts";

const DOC = fileURLToPath(new URL("../../docs/testing/e1-selectors.md", import.meta.url));

/** First-column code spans of the markdown table under `## <heading>`. */
function tableKeys(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

describe("selectors match docs/testing/e1-selectors.md", () => {
  const doc = readFileSync(DOC, "utf8");

  test("data-testid values: same set, no duplicates", () => {
    const documented = tableKeys(doc, "Test ids");
    const ours = Object.values(TEST_IDS);
    expect(documented.length).toBeGreaterThan(20);
    expect(new Set(documented).size).toBe(documented.length);
    expect(new Set(ours).size).toBe(ours.length);
    expect([...ours].sort()).toEqual([...documented].sort());
  });

  test("routes: same set", () => {
    expect([...ROUTE_PATTERNS].sort()).toEqual(tableKeys(doc, "Routes").sort());
  });

  test("route builders follow the patterns", () => {
    expect(ROUTES.channel("alice_1")).toBe("/alice_1");
    expect(ROUTES.embed("alice_1")).toBe("/embed/alice_1");
    expect(ROUTE_PATTERNS).toContain(ROUTES.signup);
    expect(ROUTE_PATTERNS).toContain(ROUTES.dashboard);
  });

  test("tableKeys parses only the named section", () => {
    const md = "## A\n\n| x | y |\n| - | - |\n| `a1` | z |\n\n## B\n\n| `b1` | z |\n";
    expect(tableKeys(md, "A")).toEqual(["a1"]);
    expect(tableKeys(md, "B")).toEqual(["b1"]);
    expect(() => tableKeys(md, "C")).toThrow(/no "## C"/);
  });
});

describe("tid", () => {
  test("plain and with data attributes", () => {
    expect(tid("player")).toBe('[data-testid="player"]');
    expect(tid("player", { state: "playing" })).toBe('[data-testid="player"][data-state="playing"]');
    expect(tid("chat-message", { author: 'a"b\\c' })).toBe('[data-testid="chat-message"][data-author="a\\"b\\\\c"]');
  });
});

describe("--player web opens the embed route", () => {
  test("webEmbedUrl", () => {
    expect(webEmbedUrl("http://localhost:3000", "bob")).toBe("http://localhost:3000/embed/bob");
    expect(webEmbedUrl("http://localhost:3000/", "bob")).toBe("http://localhost:3000/embed/bob");
    expect(webEmbedUrl("https://example.test/base/", "b ob")).toBe("https://example.test/embed/b%20ob");
  });
});

describe("obsPublishUrl", () => {
  test("joins server and key with one slash", () => {
    expect(obsPublishUrl("rtmp://localhost:1935/live", "alice?key=s3cr3t")).toBe(
      "rtmp://localhost:1935/live/alice?key=s3cr3t",
    );
    expect(obsPublishUrl("rtmp://localhost:1935/live/", "/alice?key=x")).toBe("rtmp://localhost:1935/live/alice?key=x");
    expect(obsPublishUrl("  rtmps://ingest.test/live// ", " k ")).toBe("rtmps://ingest.test/live/k");
  });

  test("rejects non-RTMP servers and empty keys", () => {
    expect(() => obsPublishUrl("http://localhost/live", "k")).toThrow(/rtmp/);
    expect(() => obsPublishUrl("", "k")).toThrow(/rtmp/);
    expect(() => obsPublishUrl("rtmp://h/live", "  ")).toThrow(/empty/);
  });
});

describe("rebaseOrigin", () => {
  test("swaps scheme, host and port, keeps path and query", () => {
    expect(rebaseOrigin("rtmp://ingest.example.test/live/a?key=1", "rtmp://localhost:1935")).toBe(
      "rtmp://localhost:1935/live/a?key=1",
    );
    expect(rebaseOrigin("rtmp://h:1935", "rtmp://localhost:19350/")).toBe("rtmp://localhost:19350");
  });
  test("rejects non-URLs", () => {
    expect(() => rebaseOrigin("not a url", "rtmp://localhost")).toThrow(/cannot rebase/);
  });
});

describe("verification link from the web-proxied URL", () => {
  const mail = {
    text: "Confirm your address: http://localhost:3000/api/auth/verify-email?token=abc.def&callbackURL=%2Fdashboard\n",
    html: '<a href="http://localhost:3000/api/auth/verify-email?token=abc.def&amp;callbackURL=%2Fdashboard">Verify</a> <a href="http://localhost:3000/legal">Legal</a>',
  };

  test("findTokenLink picks the verification link with entities decoded", () => {
    expect(extractLinks(mail)).toContain("http://localhost:3000/legal");
    expect(findTokenLink(mail)).toBe(
      "http://localhost:3000/api/auth/verify-email?token=abc.def&callbackURL=%2Fdashboard",
    );
  });

  test("same origin is kept verbatim", () => {
    const link = findTokenLink(mail) ?? "";
    expect(browserVerificationUrl(link, "http://localhost:3000")).toBe(link);
  });

  test("API paths are rebased onto the web URL the browser uses", () => {
    expect(
      browserVerificationUrl("https://commonair.example/api/auth/verify-email?token=t#x", "http://localhost:3000"),
    ).toBe("http://localhost:3000/api/auth/verify-email?token=t#x");
    expect(browserVerificationUrl("https://commonair.example/rpc/x", "http://127.0.0.1:3000/")).toBe(
      "http://127.0.0.1:3000/rpc/x",
    );
  });

  test("non-API links on other origins are left alone", () => {
    expect(browserVerificationUrl("https://elsewhere.example/verify?token=t", "http://localhost:3000")).toBe(
      "https://elsewhere.example/verify?token=t",
    );
  });
});
