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
  /** BCP 47 tag of the recipient's language; falls back to English. */
  locale?: string | undefined;
  /** Translations by tag; English is built in. */
  catalogs?: Catalogs;
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
  constructor(public readonly url: string) {
    super("email links must point at the instance's public URL");
    this.name = "EmailLinkError";
  }
}

/**
 * Every link in template data must stay on this instance: no third-party
 * hosts (tracking, phishing-lookalike redirects, raw storage URLs). Signed
 * downloads go through an instance page that redirects after a session check.
 */
export function assertInstanceLinks(data: unknown, site: InstanceSite): void {
  const origin = new URL(site.publicUrl).origin;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === origin) return;
      if (
        url.protocol === "http:" ||
        url.protocol === "https:" ||
        url.protocol === "javascript:" ||
        url.protocol === "data:"
      )
        throw new EmailLinkError(value);
      return;
    }
    if (value && typeof value === "object" && !(value instanceof Date)) Object.values(value).forEach(visit);
  };
  visit(data);
}

// html-to-text upper-cases headings by default, which is wrong for many scripts (and Turkish i).
const TEXT_SELECTORS = [
  { selector: "h1", options: { uppercase: false } },
  { selector: "dt", format: "block" },
  { selector: "dd", format: "block" },
];

export async function renderEmail<K extends TemplateId>(
  id: K,
  data: TemplateData<K>,
  opts: RenderOptions,
): Promise<RenderedEmail> {
  assertInstanceLinks(data, opts.site);
  const { locale, catalog } = resolveCatalog(opts.locale, opts.catalogs);
  // The registry is keyed by id, so this pairing is sound; TS cannot correlate the generic.
  const def = templates[id] as unknown as TemplateDefinition<TemplateData<K>, unknown>;
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
