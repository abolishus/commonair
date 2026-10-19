// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Repository-policy guards for the design system (AGENTS.md "Design rules"). */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import * as ui from "../src/index.ts";
import { toast } from "../src/toast.tsx";

const pkgRoot = join(import.meta.dirname, "..");
const repoRoot = join(pkgRoot, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "storybook-static") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const sources = [
  ...walk(join(pkgRoot, "src")),
  ...walk(join(pkgRoot, "stories")),
  ...walk(join(pkgRoot, ".storybook")),
].map((file) => ({
  file: relative(pkgRoot, file),
  text: readFileSync(file, "utf8"),
}));

describe("no Radix", () => {
  test("package.json declares no @radix-ui/* or radix-based packages", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) =>
      Object.keys(pkg[k] ?? {}),
    );
    expect(names.filter((n) => n.startsWith("@radix-ui/") || n === "cmdk" || n === "vaul")).toEqual([]);
  });

  test("the lockfile resolves no @radix-ui/* package anywhere in the tree", () => {
    const lock = readFileSync(join(repoRoot, "bun.lock"), "utf8");
    expect(lock.match(/"@radix-ui\/[^"]+"/g) ?? []).toEqual([]);
  });

  test("no source file imports Radix", () => {
    expect(sources.filter((s) => /from\s+["']@radix-ui\//.test(s.text)).map((s) => s.file)).toEqual([]);
  });
});

/**
 * Finds `title=` attributes on intrinsic (lower-case) JSX elements. Our own
 * components may have a `title` prop (EmptyState, ConfirmDialog, ...).
 */
export function nativeTitleAttributes(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/\btitle=/g)) {
    const before = text.slice(0, m.index);
    // The innermost unclosed JSX opening tag before this attribute ("=>" is not a tag end).
    const lastOpen = before.search(/<([A-Za-z][\w.]*)(?![\s\S]*<[A-Za-z])/);
    if (lastOpen < 0) continue;
    const between = before.slice(lastOpen).replace(/=>/g, "");
    if (between.includes(">")) continue;
    const tag = /^<([A-Za-z][\w.]*)/.exec(before.slice(lastOpen))?.[1] ?? "";
    if (/^[a-z]/.test(tag)) hits.push(tag);
  }
  return hits;
}

describe("no native title tooltips or dialogs", () => {
  test("the detector finds native titles and ignores component props", () => {
    expect(nativeTitleAttributes(`<span className="x" title="nope">`)).toEqual(["span"]);
    expect(nativeTitleAttributes(`<button onClick={() => go()} title={t("a")}>`)).toEqual(["button"]);
    expect(nativeTitleAttributes(`<EmptyState icon={X} title="ok" />`)).toEqual([]);
    expect(nativeTitleAttributes(`<CommandDialog title={title ?? strings.title}>`)).toEqual([]);
  });

  test.each(sources.map((s) => [s.file, s.text] as const))("%s has no title= on DOM elements", (_file, text) => {
    expect(nativeTitleAttributes(text)).toEqual([]);
  });

  test.each(sources.map((s) => [s.file, s.text] as const))("%s never calls alert/confirm/prompt", (_file, text) => {
    expect(text).not.toMatch(/(?<![\w.])(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\s*\(/);
  });
});

describe("house conventions", () => {
  test("only the toast module and the Toaster component import sonner", () => {
    const importers = sources.filter((s) => /from\s+["']sonner["']/.test(s.text)).map((s) => s.file);
    expect(importers.sort()).toEqual(["src/components/sonner.tsx", "src/toast.tsx"]);
  });

  test("no hex colors in components or primitives (tokens live in globals.css)", () => {
    const offenders = sources
      .filter((s) => s.file.startsWith("src/"))
      // `chart.tsx` targets recharts' default strokes with attribute selectors (`[stroke='#ccc']`); those match, never paint.
      .map((s) => ({ ...s, text: s.text.replace(/\[(?:stroke|fill)='#[0-9a-fA-F]{3,8}'\]/g, "") }))
      .filter((s) => /["'\s(]#[0-9a-fA-F]{3,8}\b/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  test("house primitives are square (base-lyra): only rounded-none, and rounded-full for avatars and dots", () => {
    const houseCode = sources.filter(
      (s) => /^src\/(primitives|layouts|blocks)\//.test(s.file) || s.file === "src/toast.tsx",
    );
    const offenders = houseCode.flatMap((s) =>
      [...s.text.matchAll(/(?<![\w-])rounded(?:-[a-z]{1,2})?(?:-(?:xs|sm|md|lg|xl|2xl|3xl|4xl|\[[^\]]*\]))?(?![\w-])/g)]
        .map((m) => m[0])
        .filter((cls) => !/-(none|full)$/.test(cls))
        .map((cls) => `${s.file}: ${cls}`),
    );
    expect(offenders).toEqual([]);
  });

  test("the radius guard catches rounded corners", () => {
    const re = /(?<![\w-])rounded(?:-[a-z]{1,2})?(?:-(?:xs|sm|md|lg|xl|2xl|3xl|4xl|\[[^\]]*\]))?(?![\w-])/g;
    const hits = (text: string): string[] =>
      [...text.matchAll(re)].map((m) => m[0]).filter((cls) => !/-(none|full)$/.test(cls));
    expect(hits(`className="rounded-md p-2"`)).toEqual(["rounded-md"]);
    expect(hits(`className="rounded rounded-t-lg rounded-[4px]"`)).toEqual([
      "rounded",
      "rounded-t-lg",
      "rounded-[4px]",
    ]);
    expect(hits(`className="rounded-none rounded-full rounded-t-none"`)).toEqual([]);
  });

  test("every file carries an SPDX header", () => {
    expect(sources.filter((s) => !s.text.includes("SPDX-License-Identifier")).map((s) => s.file)).toEqual([]);
  });

  test("every primitive named in AGENTS.md is exported", () => {
    for (const name of [
      "StreamCard",
      "ChannelAvatar",
      "LiveBadge",
      "ViewerCount",
      "RelativeTime",
      "MoneyAmount",
      "formatMoney",
      "EmptyState",
      "Skeleton",
      "SkeletonText",
      "SkeletonAvatar",
      "SkeletonThumbnail",
      "StreamCardSkeleton",
      "IconButton",
      "ConfirmDialog",
      "Kbd",
      "Shortcut",
      "CommandPalette",
      "ThemeToggle",
      "LocaleProvider",
    ]) {
      expect(ui, name).toHaveProperty(name);
    }
    for (const fn of ["success", "error", "info", "warning", "promise", "dismiss"] as const) {
      expect(typeof toast[fn]).toBe("function");
    }
  });

  test("the AGENTS.md primitives table still names exactly what we export", () => {
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const table = agents.slice(agents.indexOf("### House primitives"));
    // First column only: the "Use" side of each row.
    const names = [...table.matchAll(/^\| `<(\w+)[\s>*]/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(ui, name).toHaveProperty(name);
  });
});
