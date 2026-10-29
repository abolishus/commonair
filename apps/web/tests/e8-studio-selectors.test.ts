// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every test id of docs/testing/e8-selectors.md's studio sections (Polls, Predictions, Raids,
 * Goals, Channel bot) is rendered by the E8-studio sources: as a JSX attribute, as a `data-testid`
 * prop handed to a composition, or built from its `<template>` as listed here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const ROOT = new URL("../../../", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const STUDIO = [
  join(ROOT, "apps/web/src/components/interact-studio"),
  join(ROOT, "apps/web/src/components/bot-studio"),
  join(ROOT, "apps/web/src/routes/_studio/interact.tsx"),
  join(ROOT, "apps/web/src/routes/_studio/bot.tsx"),
];
const text = STUDIO.flatMap((p) => (statSync(p).isDirectory() ? sources(p) : [p]))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

const SECTIONS = [
  "Polls (`/interact`)",
  "Predictions (`/interact`)",
  "Raids (`/interact`)",
  "Goals (`/interact`)",
  "Channel bot (`/bot`)",
];

/** Backticked ids in those sections' tables (first column and meaning column), `data-*` names left out. */
function studioIds(): string[] {
  const doc = readFileSync(join(ROOT, "docs/testing/e8-selectors.md"), "utf8");
  const ids = new Set<string>();
  for (const title of SECTIONS) {
    const section = doc.split(`### ${title}`)[1]?.split(/^#{2,3} /m)[0] ?? "";
    for (const line of section.split("\n")) {
      if (!line.startsWith("|") || line.startsWith("| Test id") || line.startsWith("| ---")) continue;
      for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9<>]+)*)`/g)) {
        const id = m[1];
        if (id && !id.startsWith("data-") && id.includes("-")) ids.add(id);
      }
      const first = /^\|\s*`([a-z]+)`/.exec(line)?.[1];
      if (first) ids.add(first);
    }
  }
  // Values in the meaning column that are not ids.
  for (const notId of ["raid_pending"]) ids.delete(notId);
  return [...ids];
}

/** Where each template id is built. */
const TEMPLATES: Readonly<Record<string, string>> = {
  "poll-choice-<n>": "`poll-choice-${n}`",
  "prediction-outcome-<n>": "`prediction-outcome-${n}`",
  "prediction-resolve-<outcomeId>": "`prediction-resolve-${o.id}`",
  "command-level-<level>": "`command-level-${level}`",
  "points-adjust-reason-<reason>": "`points-adjust-reason-${reason}`",
};

const rendered = (id: string): boolean =>
  text.includes(`data-testid="${id}"`) || text.includes(`"data-testid": "${id}"`);

describe("e8-selectors.md studio ids", () => {
  const ids = studioIds();

  it("reads the studio sections", () => {
    expect(ids.length).toBeGreaterThan(90);
    for (const id of [
      "interact",
      "poll-live-choice",
      "raid-policy-off",
      "goal-type-tips",
      "bot-sr-max",
      "points-adjust",
    ])
      expect(ids).toContain(id);
  });

  it.each(ids.filter((id) => !id.includes("<")))("renders %s", (id) => {
    expect(rendered(id)).toBe(true);
  });

  it.each(ids.filter((id) => id.includes("<")))("builds %s from its template", (id) => {
    const marker = TEMPLATES[id];
    expect(marker, id).toBeDefined();
    expect(text).toContain(marker);
  });
});
