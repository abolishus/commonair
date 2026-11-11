// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The small Markdown subset the legal documents use (`packages/db/src/legal/*.md`): `##`/`###`
 * headings, paragraphs, `-` and `1.` lists with indented continuation lines, `>` quotes, and
 * `**bold**`, `*emphasis*` and `` `code` `` inline. Parsed to plain data and rendered as React
 * elements, never as HTML, so a document's text can never inject markup. Anything else stays
 * literal text.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; text: string };

export type Block =
  | { kind: "heading"; level: 2 | 3; id: string; text: string }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; blocks: Block[] };

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

/** A heading's anchor: lowercase words joined by dashes, unique within the document. */
export function slugify(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

const URL_OR_EMAIL = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Plain text with bare http(s) URLs and email addresses turned into links. */
function linkify(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_OR_EMAIL)) {
    const at = m.index;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    const [whole, url, email] = m;
    if (url) out.push({ kind: "link", href: url, text: url });
    else if (email) out.push({ kind: "link", href: `mailto:${email}`, text: email });
    last = at + whole.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Inline emphasis: `**strong**`, `*em*` and `` `code` ``; unmatched markers stay literal. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push(...linkify(buffer));
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    } else if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (text[i] === "*" && text[i + 1] !== " ") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && text[end - 1] !== " ") {
        flush();
        out.push({ kind: "em", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  flush();
  return out;
}

const BULLET = /^[-*] +(.*)$/;
const NUMBERED = /^\d+[.)] +(.*)$/;
const HEADING = /^(#{1,6}) +(.+?)\s*#*\s*$/;

function parseLines(lines: readonly string[], taken: Set<string>): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const hashes = (heading[1] ?? "").length;
      const text = (heading[2] ?? "").trim();
      // The page title is the document's h1, so `#` and `##` are sections, deeper ones subsections.
      const level = hashes <= 2 ? 2 : 3;
      blocks.push({ kind: "heading", level, id: slugify(text, taken), text });
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        quoted.push((lines[i] ?? "").replace(/^> ?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", blocks: parseLines(quoted, taken) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const marker = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const item = marker.exec(current);
        if (item) {
          items.push(item[1] ?? "");
        } else if (current.trim() !== "" && /^\s+/.test(current) && items.length > 0) {
          items[items.length - 1] += ` ${current.trim()}`;
        } else if (current.trim() === "") {
          // A blank line ends the list unless the next line is another item of it.
          const next = lines[i + 1] ?? "";
          if (!marker.exec(next)) break;
        } else break;
        i++;
      }
      blocks.push({ kind: "list", ordered, items: items.map((text) => parseInline(text)) });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "" || HEADING.test(current) || current.startsWith(">") || BULLET.test(current)) break;
      if (NUMBERED.test(current) && paragraph.length > 0) break;
      paragraph.push(current.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}

/** Parse a document body into blocks; headings get unique anchors. */
export function parseMarkdown(body: string): Block[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n");
  return parseLines(text.split("\n"), new Set());
}

/** The table of contents: every heading, in order (quotes' headings included). */
export function tableOfContents(blocks: readonly Block[]): TocEntry[] {
  return blocks.flatMap((b): TocEntry[] =>
    b.kind === "heading"
      ? [{ id: b.id, text: b.text, level: b.level }]
      : b.kind === "quote"
        ? tableOfContents(b.blocks)
        : [],
  );
}
