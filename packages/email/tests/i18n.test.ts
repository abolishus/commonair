// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Email catalogs (batch 5 decision (d)): JSON, ICU plurals, bundled locales and Spanish. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkCatalog, coverage, readNamespaces } from "@commonair/i18n/catalog";
import { Fragment, createElement, isValidElement, type ReactNode } from "react";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLED,
  catalogFallbacks,
  en,
  interpolate,
  interpolateNodes,
  mergeCatalog,
  renderEmail,
  resolveCatalog,
  sampleData,
  TEMPLATE_IDS,
  type GoLiveDigestChannel,
  type SampleData,
  type TemplateId,
} from "../src/index.ts";
import { testSite } from "./fixtures.ts";

const LOCALES_DIR = join(import.meta.dirname, "../src/messages/locales");
const namespaces = readNamespaces(LOCALES_DIR);
const site = testSite();
const samples = sampleData(site.publicUrl);

describe("catalogs", () => {
  test("parse, keep English's arguments in every translation, and have no stray keys", () => {
    // Email keys carry the moderation clause ids, some of which contain "-" (`clause.safety.self-harm`).
    const problems = checkCatalog(namespaces, { keySegment: /[A-Za-z0-9_-]+/ });
    expect(problems).toEqual([]);
  });

  test("Spanish covers every English key", () => {
    const es = coverage(namespaces, "es");
    expect(es.missing).toEqual([]);
    expect(es.translated).toBe(es.total);
    expect(es.total).toBeGreaterThan(250);
  });

  test("one JSON group per template file, every group in every locale", () => {
    const groups = (lang: string) => namespaces.filter((ns) => ns.lang === lang).map((ns) => ns.name);
    expect(groups("en")).toEqual([
      "account",
      "governance",
      "layout",
      "notify",
      "payments",
      "privacy",
      "security",
      "trust",
    ]);
    for (const lang of Object.keys(BUNDLED)) expect(groups(lang)).toEqual(groups("en"));
  });

  test("BUNDLED lists every locale directory", () => {
    const dirs = readdirSync(LOCALES_DIR).filter((d) => statSync(join(LOCALES_DIR, d)).isDirectory());
    expect(Object.keys(BUNDLED).toSorted()).toEqual(dirs.toSorted());
  });

  test("the English JSON is the catalog: every block is a template (or the layout) and nothing else", () => {
    expect(
      Object.keys(en)
        .filter((k) => k !== "layout")
        .toSorted(),
    ).toEqual(TEMPLATE_IDS.toSorted());
    expect(Object.keys(en.layout)).not.toContain("dir");
  });

  test("the bundled Spanish catalog needs no English fallback", () => {
    expect(catalogFallbacks(BUNDLED.es ?? {})).toEqual([]);
    expect(catalogFallbacks({})).toHaveLength(
      namespaces.filter((ns) => ns.lang === "en").flatMap((ns) => ns.entries).length,
    );
  });
});

describe("resolveCatalog", () => {
  test("exact tag, then language, then English; bundled by default", () => {
    expect(resolveCatalog("es").locale).toBe("es");
    expect(resolveCatalog("es-MX").locale).toBe("es");
    expect(resolveCatalog("es-MX").catalog.magicLink.action).toBe("Iniciar sesión");
    expect(resolveCatalog("en-GB").locale).toBe("en");
    expect(resolveCatalog("zz").locale).toBe("en");
    expect(resolveCatalog("zz").catalog).toBe(en);
    expect(resolveCatalog(undefined).locale).toBe("en");
  });

  test("explicit catalogs replace the bundled ones", () => {
    expect(resolveCatalog("es", {}).locale).toBe("en");
    expect(resolveCatalog("de", { de: { magicLink: { action: "Anmelden" } } }).catalog.magicLink.action).toBe(
      "Anmelden",
    );
  });

  test("a broken or mismatched translation falls back to English, string by string", () => {
    const partial = {
      magicLink: {
        action: "Anmelden",
        heading: "Anmelden bei {instance", // does not parse
        expiry: "Läuft in {minuten} Minuten ab.", // a different argument
        subject: "Anmeldelink für {instance}",
      },
    };
    const merged = mergeCatalog(partial);
    expect(merged.magicLink.action).toBe("Anmelden");
    expect(merged.magicLink.subject).toBe("Anmeldelink für {instance}");
    expect(merged.magicLink.heading).toBe(en.magicLink.heading);
    expect(merged.magicLink.expiry).toBe(en.magicLink.expiry);
    expect(catalogFallbacks(partial)).toContain("magicLink.heading");
    expect(catalogFallbacks(partial)).toContain("magicLink.expiry");
    expect(catalogFallbacks(partial)).not.toContain("magicLink.action");
  });

  test("a broken translation renders the English string in the mail", async () => {
    const mail = await renderEmail("magicLink", samples.magicLink, {
      site,
      locale: "de",
      catalogs: { de: { magicLink: { heading: "Anmelden bei {instance" } } },
    });
    expect(mail.locale).toBe("de");
    expect(mail.text).toContain("Sign in to Example Air");
    expect(mail.text).not.toContain("Anmelden bei");
  });
});

describe.each(TEMPLATE_IDS)("%s in Spanish", (id: TemplateId) => {
  test("renders with lang and dir, and differs from English in subject and body", async () => {
    const data = samples[id] as SampleData[typeof id];
    const [esMail, enMail] = await Promise.all([
      renderEmail(id, data, { site, locale: "es" }),
      renderEmail(id, data, { site, locale: "en" }),
    ]);
    expect(esMail.locale).toBe("es");
    expect(esMail.html).toContain('<html dir="ltr" lang="es">');
    expect(esMail.subject).not.toBe(enMail.subject);
    expect(esMail.subject).not.toMatch(/[\r\n{}]/);
    expect(esMail.html).not.toMatch(/\{\w+\}/);
    // Every English sentence of the block is gone (labels shorter than a few words may coincide).
    const block = en[id] as Record<string, string>;
    const leftovers = Object.values(block)
      .map((message) => interpolate(message, { instance: site.name }))
      .filter((english) => english.split(" ").length >= 4 && esMail.text.includes(english));
    expect({ id, leftovers }).toEqual({ id, leftovers: [] });
    // The footer is Spanish too.
    expect(esMail.text).toContain("Recibes este correo por tu cuenta en Example Air.");
    // A readable copy of every Spanish mail, for review.
    expect(`${esMail.subject}\n\n${esMail.text}`).toMatchSnapshot();
  });
});

test("a right-to-left locale renders dir=rtl and indents the digest list on the right", async () => {
  const mail = await renderEmail("goLiveDigest", samples.goLiveDigest, { site, locale: "ar", catalogs: { ar: {} } });
  expect(mail.locale).toBe("ar");
  expect(mail.html).toContain('<html dir="rtl" lang="ar">');
  expect(mail.html).toMatch(/<ul style="margin:0;padding:0 20px 0 0"/);
});

/* ------------------------------------------------------------------------- *
 * Plurals
 * ------------------------------------------------------------------------- */

const origin = site.publicUrl;
const channel = (i: number): GoLiveDigestChannel => ({
  name: `Channel ${i}`,
  title: `Title ${i}`,
  url: `${origin}/c${i}`,
});
const digest = (n: number, locale: string) =>
  renderEmail(
    "goLiveDigest",
    { ...samples.goLiveDigest, channels: Array.from({ length: n }, (_, i) => channel(i + 1)) },
    { site, locale },
  );

describe("plurals", () => {
  const plural = (message: string, locale: string) =>
    [0, 1, 2, 5, 1000].map((count) => interpolate(message, { count, instance: "Air" }, locale));

  test.each([
    [
      "en",
      "subjectMany",
      [
        "0 channels you follow are live on Air",
        "1 channel you follow is live on Air",
        "2 channels you follow are live on Air",
        "5 channels you follow are live on Air",
        "1,000 channels you follow are live on Air",
      ],
    ],
    [
      "es",
      "subjectMany",
      [
        "0 canales que sigues están en vivo en Air",
        "1 canal que sigues está en vivo en Air",
        "2 canales que sigues están en vivo en Air",
        "5 canales que sigues están en vivo en Air",
        "1000 canales que sigues están en vivo en Air",
      ],
    ],
    [
      "en",
      "headingMany",
      [
        "0 channels you follow are live",
        "1 channel you follow is live",
        "2 channels you follow are live",
        "5 channels you follow are live",
        "1,000 channels you follow are live",
      ],
    ],
    [
      "es",
      "headingMany",
      [
        "0 canales que sigues están en vivo",
        "1 canal que sigues está en vivo",
        "2 canales que sigues están en vivo",
        "5 canales que sigues están en vivo",
        "1000 canales que sigues están en vivo",
      ],
    ],
    [
      "en",
      "previewMany",
      [
        "0 channels you follow just went live. Come and watch.",
        "1 channel you follow just went live. Come and watch.",
        "2 channels you follow just went live. Come and watch.",
        "5 channels you follow just went live. Come and watch.",
        "1,000 channels you follow just went live. Come and watch.",
      ],
    ],
    [
      "es",
      "previewMany",
      [
        "0 canales que sigues acaban de empezar a transmitir en vivo. Ven a verlos.",
        "1 canal que sigues acaba de empezar a transmitir en vivo. Ven a verlos.",
        "2 canales que sigues acaban de empezar a transmitir en vivo. Ven a verlos.",
        "5 canales que sigues acaban de empezar a transmitir en vivo. Ven a verlos.",
        "1000 canales que sigues acaban de empezar a transmitir en vivo. Ven a verlos.",
      ],
    ],
    [
      "en",
      "more",
      [
        "0 more channels you follow are live",
        "1 more channel you follow is live",
        "2 more channels you follow are live",
        "5 more channels you follow are live",
        "1,000 more channels you follow are live",
      ],
    ],
    [
      "es",
      "more",
      [
        "0 canales más que sigues están en vivo",
        "1 canal más que sigues está en vivo",
        "2 canales más que sigues están en vivo",
        "5 canales más que sigues están en vivo",
        "1000 canales más que sigues están en vivo",
      ],
    ],
  ] as const)("%s goLiveDigest.%s", (locale, key, expected) => {
    expect(plural(resolveCatalog(locale).catalog.goLiveDigest[key], locale)).toEqual(expected);
  });

  test.each([
    ["en", ["0 minutes", "1 minute", "2 minutes", "5 minutes", "1,000 minutes"]],
    ["es", ["0 minutos", "1 minuto", "2 minutos", "5 minutos", "1000 minutos"]],
  ] as const)("%s link expiry minutes", (locale, expected) => {
    const catalog = resolveCatalog(locale).catalog;
    for (const block of [catalog.verifyEmail, catalog.magicLink, catalog.passwordReset]) {
      const out = [0, 1, 2, 5, 1000].map((minutes) => interpolate(block.expiry, { minutes }, locale));
      out.forEach((line, i) => expect(line).toContain(expected[i]));
    }
  });

  // Spanish has a `many` category (exact millions); the catalog writes only one/other, so it must land on other.
  test("es exact millions fall back to the other branch", () => {
    const catalog = resolveCatalog("es").catalog;
    expect(interpolate(catalog.goLiveDigest.headingMany, { count: 1_000_000 }, "es")).toBe(
      "1.000.000 canales que sigues están en vivo",
    );
    expect(interpolate(catalog.goLiveDigest.more, { count: 1_000_000 }, "es")).toBe(
      "1.000.000 canales más que sigues están en vivo",
    );
    expect(interpolate(catalog.verifyEmail.expiry, { minutes: 1_000_000 }, "es")).toContain("1.000.000 minutos");
  });

  test("the digest counts its channels in the subject, heading and 'more' line, in both languages", async () => {
    const two = await digest(2, "en");
    expect(two.subject).toBe("2 channels you follow are live on Example Air");
    const many = await digest(23, "es");
    expect(many.subject).toBe("23 canales que sigues están en vivo en Example Air");
    expect(many.text).toContain("23 canales que sigues están en vivo");
    expect(many.text).toContain("3 canales más que sigues están en vivo");
    const oneMore = await digest(21, "en");
    expect(oneMore.text).toContain("1 more channel you follow is live");
    const one = await digest(1, "es");
    expect(one.subject).toBe("Channel 1 está en vivo en Example Air");
  });

  test("a one-minute link reads in the singular", async () => {
    const en1 = await renderEmail("magicLink", { ...samples.magicLink, expiresInMinutes: 1 }, { site });
    expect(en1.text).toContain("This link expires in 1 minute.");
    const es1 = await renderEmail("magicLink", { ...samples.magicLink, expiresInMinutes: 1 }, { site, locale: "es" });
    expect(es1.text).toContain("Este enlace vence en 1 minuto.");
  });
});

describe("interpolateNodes", () => {
  const link = createElement("a", { href: "https://air.example.test/x" }, "Ada");
  /** A minimal serializer (elements, fragments, text; `href` only), enough to see where nodes landed. */
  const markup = (node: ReactNode): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map((n: ReactNode) => markup(n)).join("");
    if (isValidElement<{ children?: ReactNode; href?: string }>(node)) {
      const inner = markup(node.props.children);
      if (node.type === Fragment) return inner;
      const tag = String(node.type);
      return `<${tag}${node.props.href ? ` href="${node.props.href}"` : ""}>${inner}</${tag}>`;
    }
    return "";
  };
  const html = (node: ReactNode) => `<p>${markup(node)}</p>`;

  test("node values inside plural branches, # formatted for the locale", () => {
    const message = "{count, plural, =0 {Nobody} one {{who} alone} other {{who} and # others}}";
    expect(html(interpolateNodes(message, { count: 0, who: link }))).toBe("<p>Nobody</p>");
    expect(html(interpolateNodes(message, { count: 1, who: link }))).toBe(
      '<p><a href="https://air.example.test/x">Ada</a> alone</p>',
    );
    expect(html(interpolateNodes(message, { count: 1234, who: link }, "es"))).toBe(
      '<p><a href="https://air.example.test/x">Ada</a> and 1234 others</p>',
    );
    expect(html(interpolateNodes(message, { count: 12345, who: link }, "de"))).toBe(
      '<p><a href="https://air.example.test/x">Ada</a> and 12.345 others</p>',
    );
  });

  test("select, offset and missing arguments", () => {
    const sel = "{kind, select, a {Alpha {who}} other {Other}}";
    expect(html(interpolateNodes(sel, { kind: "a", who: link }))).toBe(
      '<p>Alpha <a href="https://air.example.test/x">Ada</a></p>',
    );
    expect(html(interpolateNodes(sel, { kind: "zzz" }))).toBe("<p>Other</p>");
    expect(
      html(interpolateNodes("{n, plural, offset:1 =1 {{who}} other {{who} and # more}}", { n: 3, who: link })),
    ).toBe('<p><a href="https://air.example.test/x">Ada</a> and 2 more</p>');
    expect(html(interpolateNodes("Hi {name}, {missing}", { name: "Ada" }))).toBe("<p>Hi Ada, {missing}</p>");
    // A plural with no number takes `other`.
    expect(html(interpolateNodes("{n, plural, one {# item} other {# items}}", {}))).toBe("<p> items</p>");
  });

  test("an unparseable message still fills simple placeholders", () => {
    expect(interpolate("Hi {name} {", { name: "Ada" })).toBe("Hi Ada {");
    expect(html(interpolateNodes("Hi {name} {", { name: link }))).toBe(
      '<p>Hi <a href="https://air.example.test/x">Ada</a> {</p>',
    );
  });
});
