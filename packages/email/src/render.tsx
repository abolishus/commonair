// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { InstanceSite } from "@commonair/config";
import { render, toPlainText } from "@react-email/render";
import { singleLine } from "./format.ts";
import { resolveCatalog, type Catalogs } from "./messages/index.ts";
import { templates, type TemplateData } from "./registry.ts";
import { createContext, Layout, type EmailContext, type TemplateDefinition, type TemplateId } from "./template.tsx";

export interface RenderOptions {
  site: InstanceSite;
  /**
   * BCP 47 tag of the recipient's language. Null or unset: the instance default,
   * `site.defaultLocale` (ADR 0029); a tag with no catalog falls back to English.
   */
  locale?: string | null | undefined;
  /** Translations by tag; English is built in. */
  catalogs?: Catalogs;
  /** Origin of the object storage browsers download from; allowed only for `storageLinks`. */
  storageOrigin?: string | undefined;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** The locale actually used (after fallback). */
  locale: string;
  /** Set for mail recipients can opt out of; becomes List-Unsubscribe. */
  unsubscribeUrl?: string;
}

export class EmailLinkError extends Error {
  /** The offending field; the value itself is not kept (it may be attacker-controlled). */
  constructor(public readonly field: string) {
    super(`email link "${field}" must be an http(s) URL on the instance's public origin`);
    this.name = "EmailLinkError";
  }
}

// ASCII whitespace, C0/C1 controls and backslashes: browsers strip or reinterpret them
// (`java\tscript:`, `https:\\evil`), so a link containing any of them is refused outright.
function hasUnsafeChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || ch === "\\") return true;
  }
  return false;
}

/**
 * Validate one link and return its normalised form (`url.href`), which is what gets rendered
 * and put into headers. It must be an absolute http(s) URL on the instance's own origin, with
 * no credentials, whitespace, control characters or backslashes: this rejects
 * protocol-relative (`//evil`), relative, `javascript:`/`vbscript:`/`file:`/`data:` and
 * lookalike-host links. Signed downloads go through an instance page that redirects.
 */
export function normalizeInstanceUrl(
  value: unknown,
  site: Pick<InstanceSite, "publicUrl">,
  field = "url",
  extraOrigin?: string,
): string {
  if (typeof value !== "string" || value === "" || hasUnsafeChar(value)) throw new EmailLinkError(field);
  if (!/^https?:\/\//i.test(value)) throw new EmailLinkError(field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailLinkError(field);
  }
  const origin = new URL(site.publicUrl).origin;
  const allowed = url.origin === origin || (extraOrigin !== undefined && url.origin === new URL(extraOrigin).origin);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !allowed) throw new EmailLinkError(field);
  if (url.username !== "" || url.password !== "") throw new EmailLinkError(field);
  return url.href;
}

/** Return a copy of `data` with every declared link field validated and normalised. */
export function normalizeLinks<D>(
  data: D,
  links: readonly string[],
  site: Pick<InstanceSite, "publicUrl">,
  storage?: { links: readonly string[]; origin: string | undefined },
): D {
  const out = { ...data } as Record<string, unknown>;
  for (const key of links) {
    const extra = storage?.links.includes(key) ? storage.origin : undefined;
    out[key] = normalizeInstanceUrl(out[key], site, key, extra);
  }
  return out as D;
}

/**
 * Return a copy of `data` with the link in `key` of every item of each declared list validated and
 * normalised (`normalizeInstanceUrl`). A list field that is not an array, or an item that is not an
 * object, is refused like a bad link. The error names the field and index, never the value.
 */
export function normalizeLinkLists<D>(
  data: D,
  lists: readonly { field: string; key: string }[],
  site: Pick<InstanceSite, "publicUrl">,
): D {
  const out = { ...data } as Record<string, unknown>;
  for (const { field, key } of lists) {
    const items = out[field];
    if (!Array.isArray(items)) throw new EmailLinkError(field);
    out[field] = items.map((item: unknown, i) => {
      const where = `${field}[${i}].${key}`;
      if (typeof item !== "object" || item === null) throw new EmailLinkError(where);
      const record = item as Record<string, unknown>;
      return { ...record, [key]: normalizeInstanceUrl(record[key], site, where) };
    });
  }
  return out as D;
}

// html-to-text upper-cases headings by default, which is wrong for many scripts (and Turkish i).
const TEXT_SELECTORS = [
  { selector: "h1", options: { uppercase: false } },
  { selector: "dt", format: "block" },
  { selector: "dd", format: "block" },
];

export async function renderEmail<K extends TemplateId>(
  id: K,
  input: TemplateData<K>,
  opts: RenderOptions,
): Promise<RenderedEmail> {
  const { locale, catalog } = resolveCatalog(opts.locale ?? opts.site.defaultLocale, opts.catalogs);
  // The registry is keyed by id, so this pairing is sound; TS cannot correlate the generic.
  const def = templates[id] as unknown as TemplateDefinition<TemplateData<K>, unknown>;
  const data = normalizeLinkLists(
    normalizeLinks(input, def.links, opts.site, { links: def.storageLinks ?? [], origin: opts.storageOrigin }),
    (def.linkLists ?? []) as readonly { field: string; key: string }[],
    opts.site,
  );
  const ctx = createContext(opts.site, locale, catalog.layout, catalog[id] as unknown) as EmailContext<unknown>;
  const subject = singleLine(def.subject(ctx, data));
  const preview = def.preview ? def.preview(ctx, data) : ctx.text((catalog[id] as { preview: string }).preview);
  const unsubscribeUrl = def.unsubscribeUrl?.(data);
  const rendered = await render(
    <Layout ctx={ctx} subject={subject} preview={preview} unsubscribeUrl={unsubscribeUrl}>
      {def.body(ctx, data)}
    </Layout>,
  );
  // An HTML5 doctype instead of React Email's XHTML one: same rendering, and no URL in the markup
  // that points anywhere but this instance.
  const html = rendered.replace(/^<!DOCTYPE[^>]*>/i, "<!DOCTYPE html>");
  const text = toPlainText(html, { selectors: TEXT_SELECTORS });
  return { subject, html, text, locale, ...(unsubscribeUrl ? { unsubscribeUrl } : {}) };
}
