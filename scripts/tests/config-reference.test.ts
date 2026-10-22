// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import { ALL_ENV_SCHEMAS } from "../../packages/config/src/env.ts";
import {
  BEGIN_MARKER,
  DOC_PATH,
  END_MARKER,
  REPO_ROOT,
  collect,
  documentedNames,
  exampleEntries,
  formatDefault,
  generatedBlock,
  installKeys,
  isUpToDate,
  jsDocs,
  normalize,
  readSources,
  renderReference,
  replaceBlock,
  table,
  unitKeys,
} from "../config-reference.ts";

const committed = () => readFileSync(join(REPO_ROOT, DOC_PATH), "utf8");

describe("committed configuration reference", () => {
  test("is up to date (run `bun scripts/config-reference.ts`)", () => {
    expect(isUpToDate(committed(), renderReference(collect(readSources())))).toBe(true);
  });

  test("lists every variable of every schema", () => {
    const listed = new Set(documentedNames(committed()));
    const schemaKeys = Object.values(ALL_ENV_SCHEMAS).flatMap((s) => Object.keys(s.shape));
    expect(schemaKeys.filter((k) => !listed.has(k))).toEqual([]);
  });

  test("lists every variable of .env.example", () => {
    const listed = new Set(documentedNames(committed()));
    const example = [...exampleEntries(readSources().envExample).keys()];
    expect(example.filter((k) => !listed.has(k))).toEqual([]);
  });

  test("lists nothing that does not exist", () => {
    const known = new Set([
      ...Object.values(ALL_ENV_SCHEMAS).flatMap((s) => Object.keys(s.shape)),
      ...exampleEntries(readSources().envExample).keys(),
    ]);
    expect(documentedNames(committed()).filter((k) => !known.has(k))).toEqual([]);
  });

  test("lists each variable once", () => {
    const names = documentedNames(committed());
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});

describe("staleness detection", () => {
  const block = renderReference(collect(readSources()));
  const doc = `# Title\n\nintro\n\n${block}\n\nafter\n`;

  test("a freshly generated document is up to date", () => {
    expect(isUpToDate(doc, block)).toBe(true);
  });

  test("a changed description is stale", () => {
    const stale = doc.replace("Public chat WebSocket URL.", "Chat URL.");
    expect(stale).not.toBe(doc);
    expect(isUpToDate(stale, block)).toBe(false);
  });

  test("a missing row is stale", () => {
    const stale = doc
      .split("\n")
      .filter((l) => !l.startsWith("| `LOG_LEVEL`"))
      .join("\n");
    expect(isUpToDate(stale, block)).toBe(false);
  });

  test("an extra row is stale", () => {
    const stale = doc.replace("| `LOG_LEVEL`", "| `NOT_A_VARIABLE` | no | — | — | — |\n| `LOG_LEVEL`");
    expect(isUpToDate(stale, block)).toBe(false);
    expect(documentedNames(stale)).toContain("NOT_A_VARIABLE");
  });

  test("re-padding a table is not a change", () => {
    const repadded = doc.replace(/\| `LOG_LEVEL` +\|/, "| `LOG_LEVEL` |");
    expect(isUpToDate(repadded, block)).toBe(true);
  });

  test("replaceBlock swaps only the generated part", () => {
    const empty = `before\n${BEGIN_MARKER}\n${END_MARKER}\nafter\n`;
    const out = replaceBlock(empty, block);
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("\nafter\n")).toBe(true);
    expect(generatedBlock(out)).toBe(block);
  });

  test("a document without markers is refused", () => {
    expect(() => generatedBlock("# no markers")).toThrow("markers");
  });
});

describe("sources", () => {
  test("jsDocs joins multi-line comments and binds them to the next key", () => {
    const src = `const a = z.object({
  /** One line. */
  ONE: z.string(),
  /**
   * Two
   * lines.
   */
  TWO: z.string(),
  THREE: z.string(),
});`;
    const docs = jsDocs(src);
    expect(docs.get("ONE")).toBe("One line.");
    expect(docs.get("TWO")).toBe("Two lines.");
    expect(docs.has("THREE")).toBe(false);
  });

  test("exampleEntries keeps the comment right above a key, not section rulers", () => {
    const entries = exampleEntries("# --- core ---\nA=1\n# about b\n# more\nB=__generate__\n\n# orphan\n\nC=\n");
    expect(entries.get("A")).toEqual({ value: "1", comment: "" });
    expect(entries.get("B")).toEqual({ value: "__generate__", comment: "about b more" });
    expect(entries.get("C")).toEqual({ value: "", comment: "" });
  });

  test("installKeys reads env_set, env_default and the contact loop", () => {
    const sh = `  env_set PUBLIC_URL "https://$_host"
  env_default FOO bar
    for _k in CONTACT_EMAIL SECURITY_EMAIL; do env_default "$_k" "$EMAIL"; done
  env_set "$1" "$2"`;
    expect([...installKeys(sh)].sort()).toEqual(["CONTACT_EMAIL", "FOO", "PUBLIC_URL", "SECURITY_EMAIL"]);
  });

  test("installKeys finds what the real selfhost.sh sets", () => {
    const keys = installKeys(readSources().selfhostSh);
    for (const k of ["PUBLIC_HOSTNAME", "TLS_MODE", "DATABASE_URL", "ABUSE_EMAIL", "MTX_WEBRTCADDITIONALHOSTS"])
      expect(keys.has(k)).toBe(true);
  });

  test("unitKeys reads Environment= and Secret= targets", () => {
    const unit = "[Container]\nEnvironment=VALKEY_URL=redis://valkey:6379\nSecret=db,type=env,target=DATABASE_URL\n";
    expect([...unitKeys([unit])].sort()).toEqual(["DATABASE_URL", "VALKEY_URL"]);
  });

  test("formatDefault", () => {
    expect(formatDefault(undefined)).toBeNull();
    expect(formatDefault("")).toBe("(empty)");
    expect(formatDefault([])).toBe("(empty)");
    expect(formatDefault(["a", "b"])).toBe("`a,b`");
    expect(formatDefault(false)).toBe("`false`");
    expect(formatDefault(10)).toBe("`10`");
    expect(formatDefault("x".repeat(100))).toBe(`\`${"x".repeat(39)}…\``);
  });
});

describe("collect", () => {
  const sources = {
    envTs: "/** The answer. */\n  ANSWER: z.coerce.number().default(42),",
    envExample: "# needed\nNEEDED=\nSECRET=__generate__\nANSWER=42\n",
    selfhostSh: "  env_set NEEDED x\n",
    units: ["Environment=ANSWER=7\n"],
  };
  const schemas = {
    one: z.object({ NEEDED: z.string(), ANSWER: z.coerce.number().default(42) }),
    two: z.object({ SECRET: z.string().optional(), NEEDED: z.string() }),
  };
  const vars = collect(sources, schemas);

  test("required, default, description and self-host facts", () => {
    expect(vars).toEqual([
      {
        name: "NEEDED",
        group: "one",
        required: true,
        defaultText: null,
        description: "needed",
        selfHost: ["set by install"],
      },
      {
        name: "ANSWER",
        group: "one",
        required: false,
        defaultText: "`42`",
        description: "The answer.",
        selfHost: ["set in the units"],
      },
      { name: "SECRET", group: "two", required: false, defaultText: null, description: "", selfHost: ["generated"] },
    ]);
  });

  test("renders one table per group, escaping pipes and angle brackets", () => {
    const out = renderReference([
      { name: "X", group: "g", required: false, defaultText: null, description: "a | b <c>", selfHost: [] },
    ]);
    expect(out).toContain("### `g`");
    expect(out).toContain("a \\| b \\<c>");
    expect(documentedNames(out)).toEqual(["X"]);
  });
});

describe("table", () => {
  test("pads every column to its widest cell, separators at least three wide", () => {
    expect(table(["A", "Bee"], [["long cell", "x"]])).toEqual([
      "| A         | Bee |",
      "| --------- | --- |",
      "| long cell | x   |",
    ]);
  });

  test("normalize ignores padding only", () => {
    expect(normalize("| a   | b |\n| --- | ----- |")).toBe(normalize("| a | b |\n| --- | --- |"));
    expect(normalize("| a | b |")).not.toBe(normalize("| a | c |"));
  });
});

// --- links in the operator and maintainer docs -------------------------------------------------

const DOC_FILES = (): string[] => {
  const dir = join(REPO_ROOT, "docs/self-hosting");
  return [
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/self-hosting/${f}`),
    "docs/maintainers/releasing.md",
    "docs/deploy/hetzner.md",
    "infra/README.md",
    "README.md",
  ];
};

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, duplicates numbered. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of stripFences(markdown).split("\n")) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m?.[1]) continue;
    const text = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "");
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const stripFences = (markdown: string) => markdown.replace(/^```[\s\S]*?^```/gm, "");
const stripCode = (markdown: string) => stripFences(markdown).replace(/`[^`\n]*`/g, "");

/** Relative link targets in a Markdown file (code blocks and inline code excluded). */
function relativeLinks(markdown: string): string[] {
  return [...stripCode(markdown).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1] ?? "")
    .filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t));
}

describe("doc links", () => {
  test("anchors follow GitHub's rules", () => {
    expect([...anchors("# Hello, World!\n## `code` and [link](x.md)\n## Hello, World\n```\n# not\n```")]).toEqual([
      "hello-world",
      "code-and-link",
      "hello-world-1",
    ]);
  });

  test("relativeLinks skips URLs and code", () => {
    expect(relativeLinks("[a](b.md#c) [d](https://e) `[f](g.md)` [h](#i)\n```\n[j](k.md)\n```")).toEqual([
      "b.md#c",
      "#i",
    ]);
  });

  test.each(DOC_FILES())("every relative link in %s resolves", (file) => {
    const path = join(REPO_ROOT, file);
    const text = readFileSync(path, "utf8");
    const broken: string[] = [];
    for (const link of relativeLinks(text)) {
      const [target = "", anchor] = link.split("#", 2);
      const resolved = target === "" ? path : join(dirname(path), decodeURIComponent(target));
      if (!existsSync(resolved)) {
        broken.push(`${link} (no ${relative(REPO_ROOT, resolved)})`);
        continue;
      }
      if (anchor && resolved.endsWith(".md") && statSync(resolved).isFile()) {
        if (!anchors(readFileSync(resolved, "utf8")).has(anchor)) broken.push(`${link} (no heading #${anchor})`);
      }
    }
    expect(broken).toEqual([]);
  });
});
