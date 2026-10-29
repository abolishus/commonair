// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Right-to-left from the start (ADR 0029 decision 5): no physical-direction Tailwind utilities
 * (`ml-`, `pr-`, `left-`, `border-l`, `rounded-tl`, `text-left`, …, with any variant prefix and
 * `-`/`!` modifiers) in `.ts`/`.tsx`/`.css`, nor physical CSS properties in `.css`, unless the
 * line says why with a `rtl-physical: <reason>` comment (a progress or goal-bar fill, a media
 * timeline, centring with `left-1/2 -translate-x-1/2`).
 *
 * `apps/web/src` has none. `packages/ui/src` is held by `logical-css.baseline.json` (count per
 * file): a count may only go down and a file not in the baseline must have none, until N2-ui
 * converts the shadcn components.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import baseline from "./logical-css.baseline.json" with { type: "json" };

interface PhysicalMatch {
  line: number;
  found: string;
  logical: string;
}

const UTILITY_LOGICAL: Record<string, string> = {
  ml: "ms",
  mr: "me",
  pl: "ps",
  pr: "pe",
  "scroll-ml": "scroll-ms",
  "scroll-mr": "scroll-me",
  "scroll-pl": "scroll-ps",
  "scroll-pr": "scroll-pe",
  left: "start",
  right: "end",
  "border-l": "border-s",
  "border-r": "border-e",
  "rounded-l": "rounded-s",
  "rounded-r": "rounded-e",
  "rounded-tl": "rounded-ss",
  "rounded-tr": "rounded-se",
  "rounded-bl": "rounded-es",
  "rounded-br": "rounded-ee",
  "text-left": "text-start",
  "text-right": "text-end",
  "float-left": "float-start",
  "float-right": "float-end",
  "clear-left": "clear-start",
  "clear-right": "clear-end",
};
// These need a value (`ml-2`, `-left-1`): bare `left` or `pr` is a word, not a class.
const NEEDS_VALUE = ["scroll-ml", "scroll-mr", "scroll-pl", "scroll-pr", "ml", "mr", "pl", "pr", "left", "right"];
const STANDS_ALONE = Object.keys(UTILITY_LOGICAL).filter((k) => !NEEDS_VALUE.includes(k));
const VALUE = String.raw`[A-Za-z0-9_.%/\[\]()#,'-]+`;
// A variant prefix (`md:`, `group-hover:`, `[&>svg]:`) ends in `:`, which the lookbehind
// accepts; `!` may lead or trail, `-` makes a negative value.
const UTILITY = new RegExp(
  String.raw`(?<![\w-])!?-?(?:${NEEDS_VALUE.join("|")})-${VALUE}!?(?![\w-])` +
    String.raw`|(?<![\w-])!?-?(?:${STANDS_ALONE.join("|")})(?:-${VALUE})?!?(?![\w-])`,
  "g",
);
const side = (s: string | undefined) => (s === "left" ? "start" : "end");
const CSS_RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/(?<![\w-])(margin|padding)-(left|right)(?![\w-])/g, (m) => `${m[1]}-inline-${side(m[2])}`],
  [/(?<![\w-])border-(left|right)(-[a-z]+)?(?![\w-])/g, (m) => `border-inline-${side(m[1])}${m[2] ?? ""}`],
  [/(?<![\w-])(left|right)\s*:/g, (m) => `inset-inline-${side(m[1])}:`],
  [/text-align\s*:\s*(left|right)\b/g, (m) => `text-align: ${side(m[1])}`],
  [/(?<![\w-])float\s*:\s*(left|right)\b/g, (m) => `float: inline-${side(m[1])}`],
];
const ALLOW = /rtl-physical:\s*\S/;

function logicalUtility(found: string): string {
  const prefix = /^!?-?/.exec(found)?.[0] ?? "";
  const body = found.slice(prefix.length);
  // The longest physical name that prefixes the utility (`rounded-tl` over `rounded-l`… `left`).
  const name = Object.keys(UTILITY_LOGICAL)
    .filter((k) => body === k || body.startsWith(`${k}-`) || body === `${k}!`)
    .sort((a, b) => b.length - a.length)[0];
  return name ? `${prefix}${UTILITY_LOGICAL[name]}${body.slice(name.length)}` : found;
}

/** Physical-direction matches in one file without a same-line `rtl-physical:` comment. */
function scanPhysical(text: string, kind: "ts" | "css"): PhysicalMatch[] {
  const out: PhysicalMatch[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (ALLOW.test(line)) continue;
    for (const m of line.matchAll(UTILITY)) out.push({ line: i + 1, found: m[0], logical: logicalUtility(m[0]) });
    if (kind !== "css") continue;
    for (const [pattern, logical] of CSS_RULES)
      for (const m of line.matchAll(pattern)) out.push({ line: i + 1, found: m[0], logical: logical(m) });
  }
  return out;
}

const ROOT = new URL("../../../", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full);
    return /\.(ts|tsx|css)$/.test(name) && !name.endsWith(".gen.ts") ? [full] : [];
  });
}

function scanTree(dir: string): Map<string, PhysicalMatch[]> {
  const out = new Map<string, PhysicalMatch[]>();
  for (const file of walk(join(ROOT, dir))) {
    const hits = scanPhysical(readFileSync(file, "utf8"), file.endsWith(".css") ? "css" : "ts");
    if (hits.length) out.set(relative(ROOT, file), hits);
  }
  return out;
}

const describeHits = (file: string, hits: PhysicalMatch[]) =>
  hits.map((h) => `${file}:${h.line}: ${h.found} → use ${h.logical} (or add a "rtl-physical: <reason>" comment)`);

describe("logical CSS (ADR 0029 decision 5)", () => {
  it("catches physical utilities and properties, and honours rtl-physical comments", () => {
    const found = (text: string, kind: "ts" | "css" = "ts") => scanPhysical(text, kind).map((h) => h.found);
    // The match is the utility; its variant prefix (`md:`) stays in the source.
    expect(found(`<div className="md:ml-2 p-2" />`)).toEqual(["ml-2"]);
    expect(found(`cn("-left-1 top-0", "!pr-3", "pr-3!")`)).toEqual(["-left-1", "!pr-3", "pr-3!"]);
    expect(found(`"border-l-2 border-l rounded-tl-md rounded-r text-left float-right clear-left"`)).toEqual([
      "border-l-2",
      "border-l",
      "rounded-tl-md",
      "rounded-r",
      "text-left",
      "float-right",
      "clear-left",
    ]);
    expect(found(`"scroll-ml-4 scroll-pr-2 left-1/2 right-[3px] group-hover:mr-auto [&>svg]:pl-1"`)).toEqual([
      "scroll-ml-4",
      "scroll-pr-2",
      "left-1/2",
      "right-[3px]",
      "mr-auto",
      "pl-1",
    ]);
    // Logical forms, words and other utilities are not matches.
    expect(found(`"ms-2 pe-3 start-0 end-1 border-s rounded-ss text-start top-left left right px-2"`)).toEqual([]);
    expect(found(`{ margin: { left: 0 } } // the left side`)).toEqual([]);
    expect(found(`.a { margin-left: 1px; padding-right: 0; border-left: 1px solid; left: 0; }`, "css")).toEqual([
      "margin-left",
      "padding-right",
      "border-left",
      "left:",
    ]);
    expect(found(`.a { text-align: left; float: right; }`, "css")).toEqual(["text-align: left", "float: right"]);
    expect(found(`.a { margin-left: 1px; } /* rtl-physical: media timeline */`, "css")).toEqual([]);
    expect(found(`<div className="left-1/2 -translate-x-1/2" /> {/* rtl-physical: centring */}`)).toEqual([]);
    expect(found(`<div className="left-0" /> // rtl-physical:`)).toEqual(["left-0"]);
  });

  it("names the logical form", () => {
    const logical = (text: string) => scanPhysical(text, "ts").map((h) => h.logical);
    expect(logical(`"md:ml-2 -left-1 !pr-3 border-l-2 rounded-tl-md text-left"`)).toEqual([
      "ms-2",
      "-start-1",
      "!pe-3",
      "border-s-2",
      "rounded-ss-md",
      "text-start",
    ]);
    expect(scanPhysical(".a { margin-left: 0 }", "css").map((h) => h.logical)).toEqual(["margin-inline-start"]);
  });

  it("finds none in apps/web/src", () => {
    const problems = [...scanTree("apps/web/src")].flatMap(([file, hits]) => describeHits(file, hits));
    expect(problems).toEqual([]);
  });

  it("only goes down in packages/ui/src (logical-css.baseline.json)", () => {
    const counts = baseline as Record<string, number>;
    const problems: string[] = [];
    const scanned = scanTree("packages/ui/src");
    for (const [file, hits] of scanned) {
      const allowed = counts[file] ?? 0;
      if (hits.length > allowed)
        problems.push(
          `${file}: ${hits.length} physical-direction classes, baseline ${allowed}` +
            (allowed === 0 ? " (a new file must have none)" : ""),
          ...describeHits(file, hits),
        );
    }
    // A ratchet, not a ceiling: a count that went down is written down, so it cannot creep back.
    for (const [file, allowed] of Object.entries(counts)) {
      const now = scanned.get(file)?.length ?? 0;
      if (!existsSync(join(ROOT, file))) problems.push(`${file}: no longer exists, remove it from the baseline`);
      else if (now < allowed)
        problems.push(
          now === 0 ? `${file}: has none now, remove it from the baseline` : `${file}: lower the baseline to ${now}`,
        );
    }
    expect(problems).toEqual([]);
  });
});
