// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The developer docs (`docs/developers/`) move with the contract: every relative link (and its
 * `#anchor`) resolves, every `OAUTH_PATHS` value and every `EVENTSUB_WS_CLOSE` code is mentioned,
 * every scope is in the scopes table, and every page is linked from the README.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { EVENTSUB_WS_CLOSE, EVENTSUB_WS_PATH } from "@commonair/contracts/eventsub";
import { OAUTH_PATHS } from "@commonair/contracts/oauth";
import { SCOPE_NAMES, TWITCH_SCOPE_MAP } from "@commonair/contracts/scopes";
import { describe, expect, it } from "vite-plus/test";

const ROOT = resolve(import.meta.dirname, "../../..");
const DOCS = join(ROOT, "docs/developers");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

const files = markdownFiles(DOCS);
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const all = [...text.values()].join("\n");

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const m = !inFence && /^#{1,6}\s+(.*)$/.exec(line);
    if (m && m[1]) out.add(slug(m[1]));
  }
  return out;
}

/** Inline links `[text](target)` outside code fences and code spans. */
function links(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const plain = line.replace(/`[^`]*`/g, "");
    for (const m of plain.matchAll(/\]\(([^)\s]+)\)/g)) if (m[1]) out.push(m[1]);
  }
  return out;
}

describe("docs/developers", () => {
  it("has the pages the brief names, each with an SPDX header", () => {
    const names = files.map((f) => relative(DOCS, f)).sort();
    for (const page of [
      "README.md",
      "getting-started.md",
      "oauth.md",
      "eventsub.md",
      "rate-limits.md",
      "porting-from-twitch.md",
    ])
      expect(names).toContain(page);
    for (const [file, body] of text) {
      expect(body, file).toContain("SPDX-License-Identifier: CC-BY-SA-4.0");
      expect(body, file).toContain("SPDX-FileCopyrightText: 2026 CommonAir contributors");
    }
  });

  it("resolves every relative link and anchor", () => {
    const broken: string[] = [];
    for (const [file, body] of text) {
      for (const target of links(body)) {
        if (/^[a-z]+:/i.test(target)) continue; // absolute URLs
        const [path = "", anchor] = target.split("#");
        const dest = path === "" ? file : resolve(dirname(file), path);
        if (!existsSync(dest)) {
          broken.push(`${relative(ROOT, file)} → ${target}`);
          continue;
        }
        if (anchor && dest.endsWith(".md") && !anchors(readFileSync(dest, "utf8")).has(anchor))
          broken.push(`${relative(ROOT, file)} → ${target} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("links every page from the README", () => {
    const readme = text.get(join(DOCS, "README.md")) ?? "";
    const linked = new Set(links(readme).map((l) => l.split("#")[0]));
    const pages = files.map((f) => relative(DOCS, f)).filter((p) => p !== "README.md");
    expect(pages.filter((p) => !linked.has(p))).toEqual([]);
  });

  it("mentions every OAuth path and every WebSocket close code", () => {
    for (const path of Object.values(OAUTH_PATHS)) expect(all, path).toContain(path);
    for (const code of Object.values(EVENTSUB_WS_CLOSE)) expect(all, String(code)).toContain(`\`${code}\``);
    expect(all).toContain(EVENTSUB_WS_PATH);
  });

  it("lists every scope and every Twitch scope mapping", () => {
    const oauth = text.get(join(DOCS, "oauth.md")) ?? "";
    for (const scope of SCOPE_NAMES) expect(oauth, scope).toContain(`| \`${scope}\``);
    const porting = text.get(join(DOCS, "porting-from-twitch.md")) ?? "";
    for (const [twitch, ours] of Object.entries(TWITCH_SCOPE_MAP))
      expect(porting, twitch).toMatch(new RegExp(`\\| \`${twitch}\`\\s+\\| \`${ours}\``));
  });

  it("names no instance hostname", () => {
    for (const [file, body] of text)
      expect(body, file).not.toMatch(
        /https?:\/\/(?!<your instance>|127\.0\.0\.1|localhost|\[::1\])[a-z0-9.-]*commonair/i,
      );
  });
});
