// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { t } from "../src/i18n/index.ts";

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
    ];
    const dynamic = files
      .filter(([f, text]) => !allowed.includes(f) && /\bt\(\s*[`'a-zA-Z_]/.test(text))
      .map(([f]) => f);
    expect(dynamic).toEqual([]);
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
