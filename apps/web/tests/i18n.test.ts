// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { t } from "../src/i18n/index.ts";
import { coopMessages } from "../src/i18n/coop.ts";
import { moneyMessages } from "../src/i18n/money.ts";
import { safetyMessages } from "../src/i18n/safety.ts";
import { supportMessages } from "../src/i18n/support.ts";

const SRC = new URL("../src/", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [full] : [];
  });
}

const files = sources(SRC).map((f) => [f, readFileSync(f, "utf8")] as const);

describe("message catalog", () => {
  it("has every key the app uses", () => {
    const used = new Set<string>();
    for (const [, text] of files) for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) if (m[1]) used.add(m[1]);
    expect(used.size).toBeGreaterThan(20);
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it("never builds keys dynamically (the check above would miss them)", () => {
    // The exceptions: the definition of `t`, and the code-to-key maps (typed as MessageKey).
    const allowed = [
      join(SRC, "i18n/index.ts"),
      join(SRC, "lib/form-errors.ts"),
      join(SRC, "chat/messages.ts"),
      join(SRC, "lib/stream-health.ts"),
      join(SRC, "lib/relays.ts"),
      join(SRC, "lib/support.ts"),
      join(SRC, "lib/money.ts"),
      join(SRC, "lib/coop.ts"),
      join(SRC, "components/safety/labels.ts"),
    ];
    const dynamic = files
      .filter(([f, text]) => !allowed.includes(f) && /\bt\(\s*[`'a-zA-Z_]/.test(text))
      .map(([f]) => f);
    expect(dynamic).toEqual([]);
  });

  it("keeps the E4b and E4c unit catalogs disjoint from each other and from the inline keys", () => {
    // `en` spreads the unit catalogs, so a repeated key would silently override another's text.
    const inline = [...readFileSync(join(SRC, "i18n/en.ts"), "utf8").matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]);
    const support = Object.keys(supportMessages);
    const money = Object.keys(moneyMessages);
    const safety = Object.keys(safetyMessages);
    expect(support.filter((k) => k in moneyMessages)).toEqual([]);
    expect(safety.filter((k) => k in moneyMessages || k in supportMessages)).toEqual([]);
    expect(inline.filter((k) => k !== undefined && (k in supportMessages || k in moneyMessages))).toEqual([]);
    expect(inline.filter((k) => k !== undefined && k in safetyMessages)).toEqual([]);
    expect(support.length + money.length + safety.length).toBeGreaterThan(150);
    expect(readFileSync(join(SRC, "i18n/en.ts"), "utf8")).toContain("...safetyMessages");
  });

  it("keeps the E5 co-op catalog disjoint from every other catalog and the inline keys", () => {
    const inline = [...readFileSync(join(SRC, "i18n/en.ts"), "utf8").matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]);
    const coop = Object.keys(coopMessages);
    expect(coop.filter((k) => k in moneyMessages || k in supportMessages || k in safetyMessages)).toEqual([]);
    expect(inline.filter((k) => k !== undefined && k in coopMessages)).toEqual([]);
    expect(coop.length).toBeGreaterThan(300);
    expect(readFileSync(join(SRC, "i18n/en.ts"), "utf8")).toContain("...coopMessages");
    // Every co-op key the catalog defines is used somewhere (no dead strings).
    const used = files
      .filter(([f]) => !f.startsWith(join(SRC, "i18n/")))
      .map(([, text]) => text)
      .join("\n");
    expect(coop.filter((k) => !used.includes(`"${k}"`))).toEqual([]);
  });

  it("maps every auth error code to a catalog key", () => {
    const text = readFileSync(join(SRC, "lib/form-errors.ts"), "utf8");
    for (const m of text.matchAll(/:\s*"(error\.[a-zA-Z]+)"/g)) expect(m[1] && m[1] in en).toBe(true);
  });

  it("fills placeholders and keeps unknown ones", () => {
    expect(t("home.title", { name: "Test Air" })).toBe("Welcome to Test Air");
    expect(t("legal.version", {})).toBe("Version {version}");
    expect(t("nav.signIn")).toBe("Sign in");
  });
});
