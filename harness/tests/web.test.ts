// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The web ↔ harness contract (docs/testing/e1-selectors.md) and the pure helpers e2e-basic uses. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODERATION_REVIEW_DECISIONS, RELAY_STATUSES, REPORT_REASONS } from "@commonair/contracts";
import { describe, expect, test } from "vite-plus/test";
import { extractLinks, findTokenLink } from "../src/mailpit.ts";
import { verificationHop } from "../src/users.ts";
import {
  DIRECTORY_SECTIONS,
  E1_TEST_IDS,
  E2_CHANGED_E1_IDS,
  E2_ROUTE_PATTERNS,
  E2_TEST_IDS,
  E3_CHANGED_E1_IDS,
  E3_ROUTE_PATTERNS,
  E3_TEST_IDS,
  E4B_CHANGED_E1_IDS,
  E4B_NESTED_TEST_IDS,
  E4B_ROUTE_PATTERNS,
  E4B_TEST_IDS,
  E4C_NESTED_TEST_IDS,
  E4C_ROUTE_PATTERNS,
  E4C_TEST_IDS,
  MODQ_DECISIONS,
  PLAYER_SOURCES,
  REVENUE_TIER_FIELDS,
  ROUTES,
  ROUTE_PATTERNS,
  TEST_IDS,
  modqDecision,
  reportReason,
  revenueTierInput,
  tid,
  webEmbedUrl,
} from "../src/web/selectors.ts";
import { browserVerificationUrl, obsPublishUrl, rebaseOrigin } from "../src/web/urls.ts";

const DOC = fileURLToPath(new URL("../../docs/testing/e1-selectors.md", import.meta.url));
const DOC_E2 = fileURLToPath(new URL("../../docs/testing/e2-selectors.md", import.meta.url));
const DOC_E3 = fileURLToPath(new URL("../../docs/testing/e3-selectors.md", import.meta.url));
const DOC_E4B = fileURLToPath(new URL("../../docs/testing/e4b-selectors.md", import.meta.url));
const DOC_E4C = fileURLToPath(new URL("../../docs/testing/e4c-selectors.md", import.meta.url));

/** The lines of the `## <heading>` section (up to the next `## `; `###` subsections included). */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** Every code span in the first column of the tables under `## <heading>` (cells may list several ids). */
function firstColumnSpans(markdown: string, heading: string): string[] {
  return section(markdown, heading).flatMap((line) => {
    if (!line.startsWith("|")) return [];
    const cell = line.split("|")[1] ?? "";
    return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  });
}

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
    const ours = Object.values(E1_TEST_IDS);
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

describe("selectors match docs/testing/e2-selectors.md", () => {
  const doc = readFileSync(DOC_E2, "utf8");

  test("data-testid values: E2 ids plus the E1 ids E2 changes, no duplicates", () => {
    const documented = tableKeys(doc, "Test ids");
    const ours = [...Object.values(E2_TEST_IDS), ...E2_CHANGED_E1_IDS];
    expect(documented.length).toBeGreaterThan(10);
    expect(new Set(documented).size).toBe(documented.length);
    expect([...ours].sort()).toEqual([...documented].sort());
  });

  test("E2 ids do not collide with E1 ids", () => {
    const e1 = new Set<string>(Object.values(E1_TEST_IDS));
    for (const id of Object.values(E2_TEST_IDS)) expect(e1.has(id)).toBe(false);
    for (const id of E2_CHANGED_E1_IDS) expect(e1.has(id)).toBe(true);
  });

  test("routes: same set, all already E1 routes", () => {
    expect([...E2_ROUTE_PATTERNS].sort()).toEqual(tableKeys(doc, "Routes").sort());
    for (const r of E2_ROUTE_PATTERNS) expect(ROUTE_PATTERNS).toContain(r);
    expect(ROUTES.directory).toBe("/");
  });

  test("directory sections are the documented data-section values", () => {
    const row = doc.split("\n").find((l) => l.startsWith("| `directory-section`")) ?? "";
    // Only the values after "`data-section` =", which may be hyphenated (`following-offline`).
    const values = row.split("`data-section` =")[1]?.split(".")[0] ?? "";
    const documented = new Set([...values.matchAll(/`([a-z-]+)`/g)].map((m) => m[1] ?? ""));
    expect([...documented].sort()).toEqual([...DIRECTORY_SECTIONS].sort());
  });
});

describe("selectors match docs/testing/e3-selectors.md", () => {
  const doc = readFileSync(DOC_E3, "utf8");

  test("data-testid values: E3 ids plus the E1 ids E3 changes, no duplicates", () => {
    const documented = tableKeys(doc, "Test ids");
    const ours = [...Object.values(E3_TEST_IDS), ...E3_CHANGED_E1_IDS];
    expect(documented.length).toBeGreaterThan(10);
    expect(new Set(documented).size).toBe(documented.length);
    expect([...ours].sort()).toEqual([...documented].sort());
  });

  test("E3 ids collide with neither E1 nor E2", () => {
    const earlier = new Set<string>([...Object.values(E1_TEST_IDS), ...Object.values(E2_TEST_IDS)]);
    for (const id of Object.values(E3_TEST_IDS)) expect(earlier.has(id)).toBe(false);
    for (const id of E3_CHANGED_E1_IDS) expect(Object.values(E1_TEST_IDS)).toContain(id);
  });

  test("routes: same set; /relays is new, the others are E1 routes", () => {
    expect([...E3_ROUTE_PATTERNS].sort()).toEqual(tableKeys(doc, "Routes").sort());
    expect(ROUTES.relays).toBe("/relays");
    for (const r of E3_ROUTE_PATTERNS.filter((r) => r !== ROUTES.relays)) expect(ROUTE_PATTERNS).toContain(r);
  });

  test("player data-source values are the documented ones (never p2p)", () => {
    const row = doc.split("\n").find((l) => l.startsWith("| `player`")) ?? "";
    // Lower-case code spans in the row: the test id itself, the sources and the excluded `p2p`.
    const documented = new Set([...row.matchAll(/`([a-z0-9]+)`/g)].map((m) => m[1] ?? ""));
    documented.delete("player");
    documented.delete("p2p");
    expect([...documented].sort()).toEqual([...PLAYER_SOURCES].sort());
    expect(row).toContain("never `p2p`");
  });

  test("relay-row data-status values are RELAY_STATUSES", () => {
    expect(doc).toContain("`data-status` is a `RELAY_STATUSES` value");
    expect([...RELAY_STATUSES]).toEqual(["pending", "active", "degraded", "suspended", "offline"]);
  });

  test("tid builds the row and player selectors the scenario uses", () => {
    expect(tid(E3_TEST_IDS.relayRow, { "relay-id": "r1" })).toBe('[data-testid="relay-row"][data-relay-id="r1"]');
    expect(tid(TEST_IDS.player, { source: "origin", state: "playing" })).toBe(
      '[data-testid="player"][data-source="origin"][data-state="playing"]',
    );
  });
});

describe("selectors match docs/testing/e4b-selectors.md", () => {
  const doc = readFileSync(DOC_E4B, "utf8");
  const tierTemplates = REVENUE_TIER_FIELDS.map((f) => `revenue-tier-${f}-<n>`);

  test("data-testid values: the first-column ids, the E1 ids E4b changes and the per-tier inputs", () => {
    const documented = firstColumnSpans(doc, "Test ids");
    expect(documented.length).toBeGreaterThan(60);
    expect(new Set(documented).size).toBe(documented.length);
    const ours = [...Object.values(E4B_TEST_IDS), ...E4B_CHANGED_E1_IDS, ...tierTemplates];
    expect(new Set(ours).size).toBe(ours.length);
    expect([...ours].sort()).toEqual([...documented].sort());
  });

  test("the changed ids are E1 ids, and chat-message documents data-badges", () => {
    for (const id of E4B_CHANGED_E1_IDS) expect(Object.values(E1_TEST_IDS)).toContain(id);
    const row = doc.split("\n").find((l) => l.startsWith("| `chat-message`")) ?? "";
    expect(row).toContain("`data-badges`");
    expect(row).toContain("`subscriber`");
  });

  test("ids named inside descriptions are documented there", () => {
    const spans = new Set(
      section(doc, "Test ids").flatMap((l) => [...l.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1] ?? "")),
    );
    for (const id of Object.values(E4B_NESTED_TEST_IDS)) expect(spans.has(id)).toBe(true);
    // The destructive confirmations reuse E1's dialog.
    expect(spans.has(E1_TEST_IDS.confirmDialogConfirm)).toBe(true);
  });

  test("tier inputs build the documented ids", () => {
    expect(revenueTierInput("price", 2)).toBe("revenue-tier-price-2");
    expect(revenueTierInput("benefits", 3)).toBe("revenue-tier-benefits-3");
    for (const f of REVENUE_TIER_FIELDS) expect(doc).toContain(`\`revenue-tier-${f}-<n>\``);
  });

  test("E4b ids collide with no earlier id; TEST_IDS is the union of every milestone (E4c checked below)", () => {
    const earlier = new Set<string>([
      ...Object.values(E1_TEST_IDS),
      ...Object.values(E2_TEST_IDS),
      ...Object.values(E3_TEST_IDS),
    ]);
    const e4b = [...Object.values(E4B_TEST_IDS), ...Object.values(E4B_NESTED_TEST_IDS)];
    expect(new Set(e4b).size).toBe(e4b.length);
    for (const id of e4b) expect(earlier.has(id)).toBe(false);
    const later = Object.values(E4C_TEST_IDS).length + Object.values(E4C_NESTED_TEST_IDS).length;
    expect(Object.values(TEST_IDS)).toHaveLength(earlier.size + e4b.length + later);
  });

  test("routes: same set; the new ones are built by ROUTES", () => {
    expect([...E4B_ROUTE_PATTERNS].sort()).toEqual(tableKeys(doc, "Routes").sort());
    const added = [ROUTES.subscriptions, ROUTES.revenue, ROUTES.treasury, ROUTES.transparency];
    expect(added).toEqual(["/settings/subscriptions", "/revenue", "/treasury", "/transparency"]);
    for (const r of added) expect(E4B_ROUTE_PATTERNS).toContain(r);
    for (const r of E4B_ROUTE_PATTERNS.filter((r) => !(added as string[]).includes(r)))
      expect(ROUTE_PATTERNS).toContain(r);
  });

  test("the scenario section lists nine steps", () => {
    const steps = section(doc, "The `e4b-money` scenario").filter((l) => /^\d+\. \*\*/.test(l));
    expect(steps).toHaveLength(9);
  });

  test("firstColumnSpans reads every span of the first cell only", () => {
    const md = "## A\n\n| Id | Meaning |\n| - | - |\n| `a`, `b` | has `c` |\n### Sub\n| `d` | x |\n## B\n| `e` | y |\n";
    expect(firstColumnSpans(md, "A")).toEqual(["a", "b", "d"]);
  });
});

describe("selectors match docs/testing/e4c-selectors.md", () => {
  const doc = readFileSync(DOC_E4C, "utf8");
  const spans = () =>
    new Set(section(doc, "Test ids").flatMap((l) => [...l.matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1] ?? "")));

  test("data-testid values: the first-column ids of every table", () => {
    const documented = firstColumnSpans(doc, "Test ids");
    expect(documented.length).toBeGreaterThan(30);
    expect(new Set(documented).size).toBe(documented.length);
    const ours = Object.values(E4C_TEST_IDS);
    expect([...ours].sort()).toEqual([...documented].sort());
  });

  test("ids named inside descriptions are documented there", () => {
    const named = spans();
    for (const id of Object.values(E4C_NESTED_TEST_IDS)) expect(named.has(id)).toBe(true);
  });

  test("modq-decision items: the first written in full, the rest as -<decision>", () => {
    const row = doc.split("\n").find((l) => l.startsWith("| `modq-decision`")) ?? "";
    expect(row).toContain("`modq-decision-clear`");
    for (const d of MODQ_DECISIONS.slice(1)) expect(row).toContain(`\`-${d}\``);
    expect([...MODQ_DECISIONS]).toEqual([...MODERATION_REVIEW_DECISIONS]);
    expect(modqDecision("escalate_legal")).toBe("modq-decision-escalate_legal");
  });

  test("report-reason items follow REPORT_REASONS", () => {
    const row = doc.split("\n").find((l) => l.startsWith("| `report-reason`")) ?? "";
    expect(row).toContain("`REPORT_REASONS`");
    expect(row).toContain("`report-reason-<reason>`");
    expect(reportReason(REPORT_REASONS[0])).toBe(`report-reason-${REPORT_REASONS[0]}`);
  });

  test("E4c ids collide with no earlier id; TEST_IDS is the union of every milestone", () => {
    const earlier = new Set<string>([
      ...Object.values(E1_TEST_IDS),
      ...Object.values(E2_TEST_IDS),
      ...Object.values(E3_TEST_IDS),
      ...Object.values(E4B_TEST_IDS),
      ...Object.values(E4B_NESTED_TEST_IDS),
    ]);
    const e4c = [...Object.values(E4C_TEST_IDS), ...Object.values(E4C_NESTED_TEST_IDS)];
    expect(new Set(e4c).size).toBe(e4c.length);
    for (const id of e4c) expect(earlier.has(id)).toBe(false);
    expect(Object.values(TEST_IDS)).toHaveLength(earlier.size + e4c.length);
  });

  test("routes: same set; the new ones are built by ROUTES", () => {
    expect([...E4C_ROUTE_PATTERNS].sort()).toEqual(tableKeys(doc, "Routes").sort());
    const added = [ROUTES.takedown, ROUTES.appeals, ROUTES.adminModeration, ROUTES.adminAppeals, ROUTES.adminLegal];
    expect(added).toEqual(["/takedown", "/settings/appeals", "/admin/moderation", "/admin/appeals", "/admin/legal"]);
    for (const r of added) expect(E4C_ROUTE_PATTERNS).toContain(r);
    for (const r of E4C_ROUTE_PATTERNS.filter((r) => !(added as string[]).includes(r)))
      expect(ROUTE_PATTERNS).toContain(r);
  });

  test("the scenario section lists seven steps, matching SAFETY_STEPS", async () => {
    const { SAFETY_STEPS } = await import("../src/safety.ts");
    const steps = section(doc, "Scenario `trust-safety`").filter((l) => /^\d+\. \*\*/.test(l));
    expect(steps).toHaveLength(7);
    expect(Object.keys(SAFETY_STEPS)).toHaveLength(7);
  });

  test("the documented hook routes and env are what the harness uses", async () => {
    const { INTERNAL_ROUTES } = await import("@commonair/contracts/internal");
    const s = section(doc, "Scenario `trust-safety`").join("\n");
    expect(s).toContain(`\`PUT ${INTERNAL_ROUTES.moderationScript}\``);
    expect(s).toContain(`\`POST ${INTERNAL_ROUTES.nciiTick}\``);
    for (const v of ["MODERATION_CLASSIFIER=scripted", "MODERATION_SAMPLE_SECONDS=2", "MODERATION_TEST_HOOKS=true"])
      expect(s).toContain(v);
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

  test("an absolute callbackURL on the public origin follows the rebase", () => {
    const out = new URL(
      browserVerificationUrl(
        "https://commonair.example/api/auth/verify-email?token=t&callbackURL=https%3A%2F%2Fcommonair.example%2Fdashboard%3Fx%3D1",
        "http://localhost:3000",
      ),
    );
    expect(out.origin).toBe("http://localhost:3000");
    expect(out.searchParams.get("token")).toBe("t");
    expect(out.searchParams.get("callbackURL")).toBe("http://localhost:3000/dashboard?x=1");
  });

  test("relative or foreign callbackURLs are untouched", () => {
    const rel = new URL(
      browserVerificationUrl(
        "https://commonair.example/api/auth/verify-email?token=t&callbackURL=%2Fdashboard",
        "http://localhost:3000",
      ),
    );
    expect(rel.searchParams.get("callbackURL")).toBe("/dashboard");
    const foreign = new URL(
      browserVerificationUrl(
        "https://commonair.example/api/auth/verify-email?token=t&callbackURL=https%3A%2F%2Fother.example%2F",
        "http://localhost:3000",
      ),
    );
    expect(foreign.searchParams.get("callbackURL")).toBe("https://other.example/");
  });
});

describe("verificationHop (API-path sign-ups)", () => {
  const origins = { api: "http://localhost:3001", web: "http://localhost:3000", client: "http://127.0.0.1:45678" };
  const hop = (u: string) => verificationHop(new URL(u), origins)?.toString() ?? null;

  test("/api/ links on the web origin (PUBLIC_URL) go to the API through the client", () => {
    expect(hop("http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2Fdashboard")).toBe(
      "http://127.0.0.1:45678/api/auth/verify-email?token=abc&callbackURL=%2Fdashboard",
    );
  });

  test("/api/ links on the API or client origin too", () => {
    expect(hop("http://localhost:3001/api/auth/verify-email?token=abc")).toBe(
      "http://127.0.0.1:45678/api/auth/verify-email?token=abc",
    );
    expect(hop("http://127.0.0.1:45678/api/x")).toBe("http://127.0.0.1:45678/api/x");
  });

  test("leaving /api/ or a foreign origin ends the API part", () => {
    expect(hop("http://localhost:3000/dashboard")).toBeNull();
    expect(hop("http://localhost:3001/")).toBeNull();
    expect(hop("https://evil.example/api/auth/verify-email?token=abc")).toBeNull();
    expect(hop("http://localhost:3000/apix/y")).toBeNull();
  });
});

describe("hydration wait", () => {
  test("waits for html[data-hydrated] and tolerates a web build without it", async () => {
    const { HYDRATED_SELECTOR, waitForHydration } = await import("../src/web/session.ts");
    const seen: string[] = [];
    const ok = { waitForSelector: async (s: string) => void seen.push(s) };
    const never = {
      waitForSelector: async () => {
        throw new Error("Timeout 15000ms exceeded");
      },
    };
    expect(await waitForHydration(ok as never)).toBe(true);
    expect(seen).toEqual([HYDRATED_SELECTOR]);
    expect(await waitForHydration(never as never)).toBe(false);
    // The web root sets the marker the harness waits for.
    const root = readFileSync(fileURLToPath(new URL("../../apps/web/src/routes/__root.tsx", import.meta.url)), "utf8");
    expect(root).toContain('document.documentElement.dataset.hydrated = "true"');
  });
});
