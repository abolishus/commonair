// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web ↔ harness contract (docs/testing/e1-, e2-, e3-, e4b-, e4c-, e5- and e7-selectors.md): every test id in the
 * docs' "Test ids" tables must be rendered somewhere in the app (or, for ids the house primitives
 * own, in packages/ui), so renaming one without updating the docs and scenarios fails here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { COMPOSITION_ATTRS, COMPOSITION_TEST_IDS, E5_COMPOSITION_TEST_IDS, E5_TEMPLATES } from "./composition-ids.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SRC = join(ROOT, "apps/web/src");
const UI = join(ROOT, "packages/ui/src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") && !name.includes(".stories.") ? [full] : [];
  });
}

const appText = sources(SRC)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const uiText = sources(UI)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/** Backticked ids in the first column of the doc's "## Test ids" table. */
function testIds(doc: string): string[] {
  const text = readFileSync(join(ROOT, "docs/testing", doc), "utf8");
  const section = text.split(/^## Test ids$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
}

const onElement = (id: string, text: string) => text.includes(`data-testid="${id}"`);

/**
 * E4a: a few ids reach the DOM only through a composition prop. Only those (COMPOSITION_TEST_IDS,
 * each checked in the DOM by tests/selectors-render.test.tsx) may appear in prop form.
 */
const viaComposition = (id: string, text: string) =>
  (COMPOSITION_TEST_IDS as readonly string[]).includes(id) &&
  (text.includes(`"data-testid": "${id}"`) || text.includes(`data-copy-testid="${id}"`));

const rendered = (id: string, text: string) => onElement(id, text) || viaComposition(id, text);

/** `data-x={expr}`, or for COMPOSITION_ATTRS only, `"data-x": expr` inside a composition prop callback. */
const setsAttr = (attr: string, text: string) => {
  if (text.includes(attr)) return true;
  if (!(COMPOSITION_ATTRS as readonly string[]).includes(attr)) return false;
  const m = /^(data-[a-z-]+)=\{(.+)\}$/.exec(attr);
  return m !== null && text.includes(`"${m[1]}": ${m[2]}`);
};

describe.each(["e1-selectors.md", "e2-selectors.md", "e3-selectors.md"])("%s", (doc) => {
  const ids = testIds(doc);

  it("lists test ids", () => {
    expect(ids.length).toBeGreaterThan(5);
  });

  it.each(ids)("renders %s", (id) => {
    expect(rendered(id, appText) || rendered(id, uiText)).toBe(true);
  });
});

/**
 * E4b: the doc's tables list several ids per cell (`a`, `b`) and per-tier templates (`x-<n>`,
 * tiers 1–3), so every backticked id in the first column counts.
 */
function e4bTestIds(): string[] {
  const text = readFileSync(join(ROOT, "docs/testing/e4b-selectors.md"), "utf8");
  const section = text.split(/^## Test ids$/m)[1]?.split(/^## /m)[0] ?? "";
  const cells = [...section.matchAll(/^\|([^|]*)\|/gm)].map((m) => m[1] ?? "");
  return cells.flatMap((cell) =>
    [...cell.matchAll(/`([a-z0-9-]+(?:-<n>)?)`/g)].flatMap((m) => {
      const id = m[1] ?? "";
      return id.endsWith("-<n>") ? [1, 2, 3].map((n) => id.replace("<n>", String(n))) : [id];
    }),
  );
}

/** A per-tier id built from a template literal (`x-${n}`) and set as `data-testid={…}`. */
const viaTierTemplate = (id: string, text: string) => {
  const m = /^(.+-)[123]$/.exec(id);
  return m !== null && text.includes(`\`${m[1]}\${n}\``) && text.includes("data-testid={");
};

describe("e4b-selectors.md", () => {
  const ids = e4bTestIds();

  it("lists test ids, including the expanded tier templates", () => {
    expect(ids.length).toBeGreaterThan(50);
    expect(ids).toContain("support-tab-gift");
    expect(ids).toContain("revenue-tier-benefits-3");
    expect(ids).not.toContain("revenue-tier-name-<n>");
  });

  it.each(ids)("renders %s", (id) => {
    expect(rendered(id, appText) || rendered(id, uiText) || viaTierTemplate(id, appText)).toBe(true);
  });
});

/** E4c cells can name several ids in the same first-column cell. */
function e4cTestIds(): string[] {
  const text = readFileSync(join(ROOT, "docs/testing/e4c-selectors.md"), "utf8");
  const section = text.split(/^### Viewer side /m)[1]?.split(/^## Scenario /m)[0] ?? "";
  const prefixes =
    /^(?:report|mature-gate|stream-restricted|ncii|footer-takedown|appeals|appeal-row|moderation-label|label-|account-|modq-|appealq-|legal-)/;
  const ids = [...section.matchAll(/\b([a-z][a-z0-9_]+(?:-[a-z0-9_]+)+)\b/g)]
    .map((match) => match[1] ?? "")
    .filter((id) => prefixes.test(id) && !id.startsWith("data-"));
  ids.push("report-reason");
  return [...new Set(ids)];
}

describe("e4c-selectors.md", () => {
  const ids = e4cTestIds();

  it("lists the trust and safety selectors", () => {
    expect(ids.length).toBeGreaterThan(55);
    expect(ids).toContain("legal-evidence-reveal");
    expect(ids).toContain("ncii-submit");
  });

  it.each(ids)("renders %s", (id) => {
    expect(rendered(id, appText) || rendered(id, uiText) || viaE4cTemplate(id, appText)).toBe(true);
  });

  it("builds report reason items from REPORT_REASONS", () => {
    expect(appText).toContain("`report-reason-${r}`");
  });
});

function viaE4cTemplate(id: string, text: string): boolean {
  const templates = [
    [/^modq-tab-(cases|labels|reports|ncii)$/, '"data-testid": "modq-tab-reports"'],
    [/^modq-decision-(clear|warn|end_stream|suspend|escalate_legal)$/, "`modq-decision-${d}`"],
    [/^ncii-decision-(removed|rejected)$/, "`ncii-decision-${decision}`"],
  ] as const;
  return (
    (COMPOSITION_TEST_IDS as readonly string[]).includes(id) &&
    templates.some(([pattern, marker]) => pattern.test(id) && text.includes(marker))
  );
}

/**
 * E5: ids sit in the first column (`coop`, `tally`, …) and inside the meaning column (`proposals-filter`,
 * `proposal-title`, `vote-choice-yes`, …). Every backticked kebab-case token that is not a `data-*`
 * attribute counts; `<x>` templates are kept as templates.
 */
function e5TestIds(): string[] {
  const text = readFileSync(join(ROOT, "docs/testing/e5-selectors.md"), "utf8");
  const section = text.split(/^## Test ids$/m)[1]?.split(/^## /m)[0] ?? "";
  const ids = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const first = line.split("|")[1] ?? "";
    for (const m of first.matchAll(/`([a-z][a-z0-9-]*)`/g)) if (m[1] && !m[1].startsWith("data-")) ids.add(m[1]);
    for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9_<>]+)+)`/g))
      if (m[1] && !m[1].startsWith("data-")) ids.add(m[1]);
  }
  return [...ids];
}

const e5ViaComposition = (id: string, text: string) =>
  (E5_COMPOSITION_TEST_IDS as readonly string[]).includes(id) &&
  (text.includes(`"data-testid": "${id}"`) ||
    text.includes(`data-textarea-testid="${id}"`) ||
    text.includes(`data-submit-testid="${id}"`) ||
    // A concrete instance of a template (`vote-choice-yes` from `vote-choice-${value}`).
    [...text.matchAll(/`([a-z-]+-)\$\{/g)].some((m) => m[1] !== undefined && id.startsWith(m[1])));

describe("e5-selectors.md", () => {
  const ids = e5TestIds();

  it("lists the co-op selectors, templates included", () => {
    expect(ids.length).toBeGreaterThan(90);
    for (const id of ["coop", "tally", "vote-choice-yes", "proposal-comment-body", "membership-exit-<class>"])
      expect(ids).toContain(id);
    expect(ids.some((id) => id.startsWith("data-"))).toBe(false);
  });

  it.each(ids.filter((id) => !id.includes("<")))("renders %s", (id) => {
    expect(onElement(id, appText) || e5ViaComposition(id, appText)).toBe(true);
  });

  it.each(ids.filter((id) => id.includes("<")))("builds %s from its template", (id) => {
    const marker = E5_TEMPLATES[id];
    expect(marker, id).toBeDefined();
    expect(appText).toContain(marker);
  });

  it("every earlier id is still rendered (e1–e4c stay intact)", () => {
    for (const id of ["nav-directory", "treasury-tab-payments", "transparency-month-row", "account-treasury-link"])
      expect(rendered(id, appText)).toBe(true);
  });
});

/**
 * E7: the same table layout as E5 (ids in the first column and inside the meaning column, `<x>`
 * templates kept as templates).
 */
function e7TestIds(): string[] {
  const text = readFileSync(join(ROOT, "docs/testing/e7-selectors.md"), "utf8");
  const section = text.split(/^## Test ids$/m)[1]?.split(/^## /m)[0] ?? "";
  const ids = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const first = line.split("|")[1] ?? "";
    for (const m of first.matchAll(/`([a-z][a-z0-9-]*)`/g)) if (m[1] && !m[1].startsWith("data-")) ids.add(m[1]);
    for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9_<>]+)+)`/g))
      if (m[1] && !m[1].startsWith("data-")) ids.add(m[1]);
  }
  return [...ids];
}

/** Where each E7 template id is built (`dmcaq-status-${s}` and so on). */
const E7_TEMPLATES: Readonly<Record<string, string>> = {
  "dmcaq-status-<status>": "`dmcaq-status-${s}`",
  "counter-item-<itemId>": "`counter-item-${i.id}`",
  "integrityq-subject-<type>": "`integrityq-subject-${s}`",
  "integrityq-decision-<decision>": "`integrityq-decision-${d}`",
  "incident-status-<status>": "`incident-status-${s}`",
  "election-ballot-<candidateId>": "`election-ballot-${c.user.id}`",
};

/**
 * E7 forms pass a field's id to a local helper that sets `data-testid={testId}`
 * (`text("name", "dmca-name", …)`), and toggles and tables take it as a composition prop.
 */
const e7Rendered = (id: string, text: string) =>
  onElement(id, text) ||
  text.includes(`"data-testid": "${id}"`) ||
  new RegExp(`\\b[a-z]+\\(\\s*"[A-Za-z]+",\\s*"${id}"`).test(text);

describe("e7-selectors.md", () => {
  const ids = e7TestIds();

  it("lists the platform-debt selectors, templates included", () => {
    expect(ids.length).toBeGreaterThan(80);
    for (const id of [
      "dmca-form",
      "held-queue",
      "integrityq-decide-allowed",
      "incident-status-<status>",
      "legal-pending",
    ])
      expect(ids).toContain(id);
    expect(ids.some((id) => id.startsWith("data-"))).toBe(false);
  });

  it.each(ids.filter((id) => !id.includes("<")))("renders %s", (id) => {
    expect(e7Rendered(id, appText) || onElement(id, uiText)).toBe(true);
  });

  it.each(ids.filter((id) => id.includes("<")))("builds %s from its template", (id) => {
    const marker = E7_TEMPLATES[id];
    expect(marker, id).toBeDefined();
    expect(appText).toContain(marker);
  });
});

describe("E2 data attributes", () => {
  it.each([
    "data-section={section.id}",
    "data-channel={card.channel.slug}",
    'data-following={following ? "true" : "false"}',
    "data-count={count}",
    "data-id={row.id}",
    'data-deleted={row.deleted ? "true" : undefined}',
    "data-code={row.code}",
  ])("app sets %s", (attr) => {
    expect(setsAttr(attr, appText)).toBe(true);
  });

  it("directory sections use the contract's names", () => {
    const text = readFileSync(join(SRC, "lib/directory-sections.ts"), "utf8");
    for (const id of ["spotlight", "new", "live", "following"]) expect(text).toContain(`id: "${id}"`);
  });
});

describe("E3 data attributes", () => {
  it.each([
    "data-source={source}",
    "data-relay-id={relay.id}",
    "data-status={relay.status}",
    "data-bytes={relay.bytesVerified30d}",
    "data-pending={pending}",
    "data-verified={verified}",
    "data-rejected={rejected}",
    'to="/relays"',
  ])("app sets %s", (attr) => {
    expect(setsAttr(attr, appText)).toBe(true);
  });
});

/** P1 (docs/testing/p1-selectors.md): the P2P indicator, notice, dialog and switches. */
describe("p1-selectors.md", () => {
  const ids = testIds("p1-selectors.md");

  it("lists the P1 test ids", () => {
    expect(ids).toEqual([
      "player-p2p",
      "player-p2p-notice",
      "player-p2p-dialog",
      "player-p2p-toggle",
      "privacy-p2p-toggle",
    ]);
  });

  it.each(ids)("renders %s", (id) => {
    expect(onElement(id, appText)).toBe(true);
  });

  it("sets data-p2p on the player and uses the storage keys the harness writes", () => {
    expect(setsAttr("data-p2p={p2p.state}", appText)).toBe(true);
    expect(appText).toContain('"commonair:p2p"');
    expect(appText).toContain('"commonair:p2p-notice"');
  });
});
