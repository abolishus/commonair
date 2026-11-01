// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The panel paste-in helper (ADR 0031 decision 6 as replaced at acceptance; batch 7 decision (b)).
 * Helix has no panels endpoint, so the streamer pastes their panels' text and this turns it into
 * panels `channels.setPanels` accepts. Pure and browser-safe: the web previews it live.
 *
 * - **HTML is removed**, all of it: `<script>` and `<style>` with their contents, every tag and
 *   its attributes. Entities are decoded, and tags are stripped again afterwards, so an encoded
 *   `&lt;script&gt;` cannot come back as markup. An `<a href>` to http(s) becomes a markdown link;
 *   any other href keeps only its text.
 * - **Links:** markdown links and bare URLs survive only as http(s). A line holding nothing but an
 *   http(s) URL becomes the panel's link (the "image links to" of a Twitch panel), once per panel.
 * - **Splitting:** blocks are separated by blank lines. A block that starts with a heading (`#`,
 *   `##`, … or a whole-line `**bold**`) starts a panel; other blocks join the panel above. With no
 *   heading anywhere, every block is a panel, titled by its first line when that line is short and
 *   more follows.
 * - **Caps:** at most 20 panels (`PORTABILITY_LIMITS.maxPanels`, as `setPanels`), titles 60 and
 *   bodies 5000 UTF-16 units, links 2000; surrogate pairs are never split. Empty panels are dropped.
 */
import { PORTABILITY_LIMITS } from "@commonair/contracts/portability";
import { capText } from "./bundle.ts";

export const PANEL_LIMITS = {
  maxPanels: PORTABILITY_LIMITS.maxPanels,
  maxTitle: 60,
  maxBody: 5000,
  maxLink: 2000,
  /** Longer pastes are cut before parsing. */
  maxInput: 100_000,
} as const;

/** A panel as `channels.setPanels` takes it (no image: images are added as any panel image is). */
export interface PastedPanel {
  title: string;
  body: string;
  imageKey: null;
  linkUrl: string | null;
}

export interface PanelPasteResult {
  panels: PastedPanel[];
  /** Panels past the cap, left out. */
  dropped: number;
  /** Some title, body or the input itself was cut to its cap. */
  truncated: boolean;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      // Controls and surrogates never come back from an entity.
      if (!Number.isFinite(n) || n < 0x20 || (n >= 0x7f && n < 0xa0) || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff)
        return "";
      return String.fromCodePoint(n);
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export const isHttpUrl = (s: string): boolean => {
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" && !u.username && !u.password;
  } catch {
    return false;
  }
};

const BLOCK_TAGS = /<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|hr)\b[^>]*>/gi;

/** One pass of tag removal: dangerous elements with their contents, links kept as markdown, then every tag. */
function stripTags(s: string): string {
  let out = s.replace(/<!--[\s\S]*?(-->|$)/g, "");
  out = out.replace(/<\s*(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, "");
  out = out.replace(
    /<\s*a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi,
    (_m, d?: string, q?: string, u?: string, text?: string) => {
      const href = decodeEntities((d ?? q ?? u ?? "").trim());
      const label = (text ?? "").replace(/<[^>]*>/g, "").trim();
      return isHttpUrl(href) ? `[${label || href}](${href})` : label;
    },
  );
  out = out.replace(BLOCK_TAGS, "\n");
  // A tag, or the start of one left unclosed at the end of the text.
  out = out.replace(/<\s*[A-Za-z!/?][^>]*(>|$)/g, "");
  return out;
}

/** Remove all HTML: strip, decode, and strip again until nothing changes (bounded). */
export function stripHtml(s: string): string {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const next = stripTags(decodeEntities(stripTags(cur)));
    if (next === cur) break;
    cur = next;
  }
  // Whatever angle brackets remain are not markup: drop them so nothing renders as a tag.
  return cur.replace(/[<>]/g, "");
}

/** Markdown links survive only as http(s); others keep their text. */
function filterLinks(s: string): string {
  // One level of balanced parentheses inside the URL, as markdown allows.
  return s.replace(/\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g, (_m, text: string, url: string) =>
    isHttpUrl(url) ? `[${text}](${url})` : text,
  );
}

/** C0 controls (but the line feed) and DEL; tabs and CRs are normalized before this runs. */
const stripControls = (s: string): string =>
  Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c === 0x0a || (c >= 0x20 && c !== 0x7f);
    })
    .join("");

function headingOf(line: string): string | null {
  const t = line.trim();
  const hash = /^#{1,6}\s+(.+?)\s*#*$/.exec(t);
  if (hash?.[1]) return hash[1].trim();
  const bold = /^(\*\*|__)(.+?)\1:?$/.exec(t);
  if (bold?.[2]) return bold[2].trim();
  return null;
}

interface Draft {
  title: string;
  lines: string[];
}

export function panelPasteDetails(text: string): PanelPasteResult {
  let truncated = text.length > PANEL_LIMITS.maxInput;
  const input = capText(text, PANEL_LIMITS.maxInput).normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  const clean = stripControls(filterLinks(stripHtml(input)));
  const blocks = clean
    .split(/\n[  ]*\n+/)
    .map((b) =>
      b
        .split("\n")
        .map((l) => l.replace(/[  ]+$/g, ""))
        .filter((l, i, all) => !(l.trim() === "" && (i === 0 || i === all.length - 1))),
    )
    .filter((b) => b.some((l) => l.trim() !== ""));

  const drafts: Draft[] = [];
  const anyHeading = blocks.some((b) => headingOf(b[0] ?? "") !== null);
  for (const block of blocks) {
    const heading = headingOf(block[0] ?? "");
    if (anyHeading) {
      if (heading !== null) drafts.push({ title: heading, lines: block.slice(1) });
      else if (drafts.length === 0) drafts.push({ title: "", lines: block });
      else {
        const last = drafts[drafts.length - 1] as Draft;
        last.lines.push("", ...block);
      }
    } else {
      const first = (block[0] ?? "").trim();
      const titled = block.length > 1 && first.length <= PANEL_LIMITS.maxTitle && !isHttpUrl(first);
      drafts.push(titled ? { title: first, lines: block.slice(1) } : { title: "", lines: block });
    }
  }

  const panels: PastedPanel[] = [];
  for (const d of drafts) {
    let linkUrl: string | null = null;
    const lines: string[] = [];
    for (const line of d.lines) {
      const t = line.trim();
      if (linkUrl === null && isHttpUrl(t) && !/\s/.test(t) && t.length <= PANEL_LIMITS.maxLink) linkUrl = t;
      else lines.push(line);
    }
    const body = lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const title = capText(d.title.trim(), PANEL_LIMITS.maxTitle);
    const cappedBody = capText(body, PANEL_LIMITS.maxBody);
    if (title !== d.title.trim() || cappedBody !== body) truncated = true;
    if (!title && !cappedBody && !linkUrl) continue;
    panels.push({ title, body: cappedBody, imageKey: null, linkUrl });
  }
  const kept = panels.slice(0, PANEL_LIMITS.maxPanels);
  return { panels: kept, dropped: panels.length - kept.length, truncated };
}

/** Pasted panel text → panels for `channels.setPanels`. See the module comment. */
export function panelPaste(text: string): PastedPanel[] {
  return panelPasteDetails(text).panels;
}
