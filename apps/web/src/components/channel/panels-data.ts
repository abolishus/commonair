// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `/$channel` needs beyond `ChannelSummary` for its banner and panels (batch 8, B8-web):
 * `Channel.bannerUrl`, `Channel.panels` and `Channel.suspended`, read from the same `channels.get`
 * answer as the summary. Pure, so the rules are unit-tested.
 */
import type { Api } from "../../lib/api.ts";

type ChannelDto = Awaited<ReturnType<Api["channels"]["get"]>>;

export interface ChannelPanelView {
  id: string;
  title: string;
  body: string;
  /** Our media origin's URL (`mediaUrl` on the API); null without an image or when unsafe. */
  imageUrl: string | null;
  /** The panel's link; null without one or when it is not http(s). */
  linkUrl: string | null;
}

export interface ChannelExtras {
  bannerUrl: string | null;
  panels: ChannelPanelView[];
  suspended: boolean;
}

export const NO_EXTRAS: ChannelExtras = Object.freeze({ bannerUrl: null, panels: [], suspended: false });

/**
 * The URL when it is an absolute http(s) URL, else null. The API builds image URLs on our own media
 * origin and checks panel links when they are saved; this keeps a `javascript:` or `data:` value
 * from ever reaching an `href` or `src` if either check is bypassed. The URL is never rewritten.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

/** A panel with no title, body, image or link shows nothing, so it is left out. */
const hasContent = (p: ChannelPanelView) =>
  p.title.trim() !== "" || p.body.trim() !== "" || p.imageUrl !== null || p.linkUrl !== null;

export function channelExtras(c: Pick<ChannelDto, "bannerUrl" | "panels" | "suspended">): ChannelExtras {
  return {
    bannerUrl: safeHttpUrl(c.bannerUrl),
    panels: [...c.panels]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        imageUrl: safeHttpUrl(p.imageUrl),
        linkUrl: safeHttpUrl(p.linkUrl),
      }))
      .filter(hasContent),
    suspended: c.suspended,
  };
}

// ── Panel markdown (D3.8) ─────────────────────────────────────────────────────────────────────

/**
 * A panel body's markdown, as a small safe subset parsed to data (never to HTML): paragraphs with
 * their line breaks, `-`/`*` and `1.` lists, `#`-`###` headings, `**strong**`, `*em*`, `` `code` ``,
 * `[text](https://…)` links and bare http(s) URLs. Anything else, raw HTML included, stays literal
 * text that React escapes. A link whose target is not absolute http(s) is its text alone.
 */
export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; text: string };

export type MdBlock =
  | { type: "p"; lines: MdInline[][] }
  | { type: "heading"; level: 1 | 2 | 3; children: MdInline[] }
  | { type: "ul" | "ol"; items: MdInline[][] };

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|(?<![\w])__[^_\n]+__(?![\w]))|((?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<![\w])_[^_\s][^_\n]*_(?![\w]))|(\[[^\]\n]+\]\([^()\s]+\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

function pushText(out: MdInline[], text: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/** One line's inline markdown. */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    const start = m.index;
    pushText(out, src.slice(at, start));
    const [whole, code, strong, em, link, bare] = m;
    if (code) out.push({ type: "code", text: code.slice(1, -1) });
    else if (strong) out.push({ type: "strong", children: parseInline(strong.slice(2, -2)) });
    else if (em) out.push({ type: "em", children: parseInline(em.slice(1, -1)) });
    else if (link) {
      const split = link.indexOf("](");
      const text = link.slice(1, split);
      const href = safeHttpUrl(link.slice(split + 2, -1));
      if (href) out.push({ type: "link", href, text });
      else pushText(out, text);
    } else if (bare) {
      const href = safeHttpUrl(bare);
      if (href) out.push({ type: "link", href, text: bare });
      else pushText(out, bare);
    } else pushText(out, whole);
    at = start + whole.length;
  }
  pushText(out, src.slice(at));
  return out;
}

const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.*?)\s*#*\s*$/;

/** A panel body as blocks. Blank lines end a block; a list ends where its items stop. */
export function parsePanelMarkdown(body: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: MdInline[][] | null = null;
  let list: { type: "ul" | "ol"; items: MdInline[][] } | null = null;
  const close = () => {
    if (para) blocks.push({ type: "p", lines: para });
    if (list) blocks.push(list);
    para = null;
    list = null;
  };
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      const level = (heading[1]?.length ?? 1) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, children: parseInline(heading[2] ?? "") });
      continue;
    }
    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    const item = ul ?? ol;
    if (item) {
      const type = ul ? "ul" : "ol";
      if (para || (list && list.type !== type)) close();
      list ??= { type, items: [] };
      list.items.push(parseInline(item[1] ?? ""));
      continue;
    }
    if (list) close();
    para ??= [];
    para.push(parseInline(line.trim()));
  }
  close();
  return blocks;
}

/** Whether the banner may show: never on a suspended channel, and on a mature one only after 18+. */
export function bannerVisible(s: {
  bannerUrl: string | null;
  suspended: boolean;
  mature: boolean;
  /** Signed in and 18+ confirmed. */
  confirmed: boolean;
  /** The stream is behind the T1 interstitial (`restricted-locked`). */
  locked: boolean;
}): boolean {
  if (s.bannerUrl === null || s.suspended || s.locked) return false;
  return !s.mature || s.confirmed;
}
