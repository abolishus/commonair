// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { checkCatalog, parseFlatJson, readNamespaces, renderKeyModules } from "../src/catalog.ts";
import { runGen } from "../src/cli.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A catalogs directory from `{ "en/core.json": "…" }`. */
function fixture(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "i18n-catalog-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

describe("parseFlatJson", () => {
  it("keeps order and duplicates and unescapes", () => {
    expect(parseFlatJson(`{ "b.x": "1", "a.y": "q\\"uote\\n", "b.x": "2" }`)).toEqual([
      ["b.x", "1"],
      ["a.y", 'q"uote\n'],
      ["b.x", "2"],
    ]);
    expect(parseFlatJson("{}\n")).toEqual([]);
  });

  it("rejects anything but a flat object of strings", () => {
    for (const bad of [`[]`, `{"a": 1}`, `{"a": {"b": "c"}}`, `{"a": "b",}`, `{"a" "b"}`, `{"a": "b"} x`, `{"a": "b`])
      expect(() => parseFlatJson(bad), bad).toThrow(/at offset \d+/);
  });
});

describe("checkCatalog", () => {
  it("passes a good catalog, with an empty namespace and a partial translation", () => {
    const dir = fixture({
      "en/core.json": { "app.title": "Title", "follow.count": "{n, plural, one {# f} other {# fs}}" },
      "en/e8-studio.json": {},
      "en/safety.json": { "safety.reason.self_harm": "Self-harm" },
      "es/core.json": { "app.title": "Título" },
    });
    expect(checkCatalog(readNamespaces(dir))).toEqual([]);
  });

  it("reports a key in two namespaces", () => {
    const dir = fixture({ "en/a.json": { "x.one": "1" }, "en/b.json": { "x.one": "1" } });
    expect(checkCatalog(readNamespaces(dir))).toEqual(["en/b.json: key x.one is also in a.json"]);
  });

  it("reports a duplicate key in one file", () => {
    const dir = fixture({ "en/a.json": `{ "x.one": "1", "x.one": "2" }` });
    expect(checkCatalog(readNamespaces(dir))).toEqual(["en/a.json: duplicate key x.one"]);
  });

  it("reports bad namespace and key names", () => {
    const dir = fixture({
      "en/Bad_Name.json": { "ok.key": "x" },
      "en/ok.json": { nodots: "x", "Upper.key": "x", "a.b-c": "x", "a.": "x", "a.b_c": "x" },
    });
    const problems = checkCatalog(readNamespaces(dir));
    expect(problems.filter((p) => p.includes("namespace name"))).toHaveLength(1);
    expect(problems.filter((p) => p.includes(": key "))).toHaveLength(4);
    expect(problems.join("\n")).not.toContain('"a.b_c"');
  });

  it("reports a message that does not parse, with the offset", () => {
    const dir = fixture({ "en/a.json": { "a.b": "{n, number}" }, "es/a.json": { "a.b": "{n, plural, one {x}}" } });
    const problems = checkCatalog(readNamespaces(dir));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /^en\/a\.json: a\.b does not parse \(Unsupported argument type 'number' at offset 4\)$/,
    );
    expect(problems[1]).toContain("es/a.json: a.b does not parse (Missing 'other'");
  });

  it("reports a translation key or namespace missing from English", () => {
    const dir = fixture({
      "en/a.json": { "a.b": "x" },
      "es/a.json": { "a.b": "x", "a.c": "y" },
      "es/z.json": { "z.z": "y" },
    });
    expect(checkCatalog(readNamespaces(dir))).toEqual([
      "es/a.json: key a.c is not in en/a.json",
      "es/z.json: no en/z.json",
    ]);
  });

  it("reports a missing English directory and an invalid file", () => {
    const dir = fixture({ "es/a.json": "{ not json" });
    const problems = checkCatalog(readNamespaces(dir));
    expect(problems[0]).toContain("no en/ catalog");
    expect(problems[1]).toMatch(/^es\/a\.json: not a flat object of strings/);
  });
});

describe("renderKeyModules", () => {
  it("writes a union per namespace in file order, never for an empty one, and the index", () => {
    const dir = fixture({
      "en/core.json": { "z.last": "1", "a.first": "2" },
      "en/e8-studio.json": {},
      "es/core.json": { "z.last": "uno" },
    });
    const files = renderKeyModules(readNamespaces(dir));
    expect(Object.keys(files)).toEqual(["core.gen.ts", "e8-studio.gen.ts", "index.gen.ts"]);
    expect(files["core.gen.ts"]).toContain('export type Key =\n  | "z.last"\n  | "a.first";\n');
    expect(files["e8-studio.gen.ts"]).toContain("export type Key = never;\n");
    for (const content of Object.values(files)) {
      expect(content.startsWith("// SPDX-FileCopyrightText: 2026 CommonAir contributors\n")).toBe(true);
      expect(content).toContain("AGPL-3.0-or-later");
      expect(content).toContain("Generated by `bun run i18n:gen`; do not edit.");
    }
    const index = files["index.gen.ts"] ?? "";
    expect(index).toContain('import type { Key as E8Studio } from "./e8-studio.gen.ts";');
    expect(index).toContain("export type MessageKey =\n  | Core\n  | E8Studio;");
    expect(index).toContain('export const NAMESPACES = [\n  "core",\n  "e8-studio",\n] as const;');
  });

  it("is deterministic", () => {
    const dir = fixture({ "en/b.json": { "b.x": "1" }, "en/a.json": { "a.x": "1" } });
    expect(renderKeyModules(readNamespaces(dir))).toEqual(renderKeyModules(readNamespaces(dir)));
  });
});

describe("cli gen", () => {
  it("writes the modules, then --check passes; a stale or extra file fails --check", () => {
    const dir = fixture({ "locales/en/core.json": { "a.b": "x" } });
    const catalogs = join(dir, "locales");
    const out = join(dir, "keys");
    expect(runGen({ catalogs, out, check: true }).ok).toBe(false);
    expect(runGen({ catalogs, out, check: false })).toMatchObject({ ok: true });
    expect(readdirSync(out).sort()).toEqual(["core.gen.ts", "index.gen.ts"]);
    expect(runGen({ catalogs, out, check: true })).toEqual({ ok: true, lines: [] });

    writeFileSync(join(catalogs, "en/core.json"), JSON.stringify({ "a.b": "x", "a.c": "y" }));
    const stale = runGen({ catalogs, out, check: true });
    expect(stale.ok).toBe(false);
    expect(stale.lines[0]).toContain("core.gen.ts is stale");
    expect(readFileSync(join(out, "core.gen.ts"), "utf8")).not.toContain("a.c");

    writeFileSync(join(out, "gone.gen.ts"), "");
    runGen({ catalogs, out, check: false });
    expect(readdirSync(out).sort()).toEqual(["core.gen.ts", "index.gen.ts"]);
    expect(readFileSync(join(out, "core.gen.ts"), "utf8")).toContain('"a.c"');
  });

  it("fails on an invalid catalog without writing", () => {
    const dir = fixture({ "locales/en/core.json": { "a.b": "{oops" } });
    const result = runGen({ catalogs: join(dir, "locales"), out: join(dir, "keys"), check: false });
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("does not parse");
  });

  it("exits 1 for --check on a stale tree and 0 when fresh (the process)", () => {
    const dir = fixture({ "locales/en/core.json": { "a.b": "x" } });
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const args = ["gen", "--catalogs", join(dir, "locales"), "--out", join(dir, "keys")];
    const run = (extra: string[]) => Bun.spawnSync(["bun", cli, ...args, ...extra], { stdout: "pipe", stderr: "pipe" });
    const stale = run(["--check"]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.toString()).toContain("is stale");
    expect(run([]).exitCode).toBe(0);
    expect(run(["--check"]).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", cli, "nope"], { stderr: "pipe" }).exitCode).toBe(2);
  });
});
