// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web ↔ harness contract (docs/testing/e1-, e2- and e3-selectors.md): every test id in the
 * docs' "Test ids" tables must be rendered somewhere in the app (or, for ids the house primitives
 * own, in packages/ui), so renaming one without updating the docs and scenarios fails here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { COMPOSITION_ATTRS, COMPOSITION_TEST_IDS } from "./composition-ids.ts";

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
