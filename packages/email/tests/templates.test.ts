// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sourceLink } from "@commonair/config";
import { describe, expect, test } from "vite-plus/test";
import {
  assertInstanceLinks,
  EmailLinkError,
  en,
  formatMoney,
  interpolate,
  renderEmail,
  resolveCatalog,
  sampleData,
  TEMPLATE_IDS,
  type EmailCatalog,
  type PartialCatalog,
  type SampleData,
  type TemplateId,
} from "../src/index.ts";
import { testSite } from "./fixtures.ts";

const site = testSite();
const samples = sampleData(site.publicUrl);

// Every one of the brief's notices is covered.
test("the registry covers every notice the platform sends", () => {
  expect(TEMPLATE_IDS.toSorted()).toEqual(
    [
      "verifyEmail",
      "magicLink",
      "passwordReset",
      "twoFactorEnabled",
      "twoFactorDisabled",
      "newSignIn",
      "streamKeyRevoked",
      "dataExportReady",
      "accountDeletionScheduled",
      "accountDeletionCompleted",
      "payoutSent",
      "chargebackNotice",
      "governanceVoteOpened",
      "governanceResultPublished",
      "councilReviewRequested",
      "dmcaNoticeReceived",
      "contentRestored",
      "appealDecided",
    ].toSorted(),
  );
  expect(
    Object.keys(en)
      .filter((k) => k !== "layout")
      .toSorted(),
  ).toEqual(TEMPLATE_IDS.toSorted());
});

const render = <K extends TemplateId>(id: K, data: SampleData[K] = samples[id], opts = {}) =>
  renderEmail(id, data, { site, ...opts });

describe.each(TEMPLATE_IDS)("%s", (id) => {
  test("renders accessible HTML and a plain-text alternative", async () => {
    const mail = await render(id);
    expect(mail.subject.length).toBeGreaterThan(0);
    expect(mail.subject).not.toMatch(/[\r\n{}]/);
    expect(mail.html).toMatch(/^<!DOCTYPE html>/);
    expect(mail.html).toContain('<html dir="ltr" lang="en">');
    expect(mail.html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(mail.html).toContain('name="color-scheme" content="light dark"');
    expect(mail.text.length).toBeGreaterThan(100);
    // No placeholder left unfilled anywhere.
    expect(mail.html).not.toMatch(/\{\w+\}/);
    expect(mail.text).not.toMatch(/\{\w+\}/);
    // The AGPL §13 source link and the instance identity are in every footer.
    expect(mail.text).toContain(sourceLink(site));
    expect(mail.text).toContain(site.name);
    expect(`${mail.subject}\n\n${mail.text}`).toMatchSnapshot();
  });

  test("links only to the instance and its source, with no remote assets", async () => {
    const mail = await render(id);
    const allowed = [site.publicUrl, sourceLink(site)];
    for (const body of [mail.html, mail.text]) {
      // Trailing sentence punctuation is not part of the URL.
      const urls = (body.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? []).map((u) => u.replace(/[.,;:]+$/, ""));
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls)
        expect(allowed.some((a) => url === a || url.startsWith(`${a}/`) || url.startsWith(`${a}?`))).toBe(true);
    }
    expect(mail.html).not.toMatch(/<img\b/i);
    expect(mail.html).not.toMatch(/<script\b/i);
    expect(mail.html).not.toMatch(/<link\b/i);
    expect(mail.html).not.toMatch(/@import|url\(/i);
    expect(mail.html).not.toMatch(/@font-face|fonts\.googleapis/i);
  });
});

test("only member announcements carry an unsubscribe link", async () => {
  const rows = await Promise.all(
    TEMPLATE_IDS.map(async (id) => {
      const mail = await render(id);
      return {
        id,
        header: mail.unsubscribeUrl?.startsWith(`${site.publicUrl}/`) ?? false,
        footer: mail.html.includes(en.layout.unsubscribe),
      };
    }),
  );
  const announcements = new Set(["governanceResultPublished", "governanceVoteOpened"]);
  expect(rows).toEqual(rows.map(({ id }) => ({ id, header: announcements.has(id), footer: announcements.has(id) })));
});

/* ------------------------------------------------------------------------- *
 * i18n: a pseudo-locale catalog must replace every visible string.
 * ------------------------------------------------------------------------- */

const LATIN = "abcdefghijklmnopqrstuvwxyz";
const CYRILLIC = "абцдефгхийклмнопярстувшхыз";
const pseudo = (s: string) =>
  s
    .split(/(\{\w+\})/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/[a-z]/gi, (c) => {
            const mapped = CYRILLIC[LATIN.indexOf(c.toLowerCase())] ?? c;
            return c === c.toLowerCase() ? mapped : mapped.toUpperCase();
          }),
    )
    .join("");

function pseudoCatalog(): EmailCatalog {
  const out: Record<string, Record<string, string>> = {};
  for (const [block, messages] of Object.entries(en)) {
    out[block] = Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, k === "dir" ? "rtl" : pseudo(v)]));
  }
  return out as unknown as EmailCatalog;
}

/** Non-Latin sample data, so any Latin letter left in the output came from a hard-coded string. */
function cyrillicSamples(origin: string): SampleData {
  const data = sampleData(origin, {
    displayName: "Ада",
    channelName: "ада_играет",
    proposalTitle: "Поднять долю авторов",
    contentTitle: "Ночь спидрана",
    device: "Фаерфокс",
    location: "Лиссабон",
    foundIn: "публичный репозиторий",
  });
  const refs = JSON.stringify(data).replace(/"(reference|noticeRef|appealRef)":"[^"]*"/g, '"$1":"№ 1207"');
  return JSON.parse(refs) as SampleData;
}

/** Visible text with URLs, mail addresses and the UTC zone label removed. */
function visibleText(html: string): string {
  return html
    .replace(/<head>[\s\S]*?<\/head>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ");
}
const stripTechnical = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w.-]+/g, " ")
    .replace(/\bUTC\b/g, " ");

test("a translated catalog changes every visible string (pseudo-locale)", async () => {
  const cyrSite = testSite({ INSTANCE_NAME: "Эфир" });
  const data = cyrillicSamples(cyrSite.publicUrl);
  for (const id of TEMPLATE_IDS) {
    const mail = await renderEmail(id, data[id], { site: cyrSite, locale: "ru", catalogs: { ru: pseudoCatalog() } });
    expect(mail.locale).toBe("ru");
    expect(mail.html).toContain('<html dir="rtl" lang="ru">');
    for (const [where, value] of [
      ["subject", mail.subject],
      ["text", mail.text],
      ["html", visibleText(mail.html)],
    ] as const) {
      const leftovers = stripTechnical(value).match(/[A-Za-z]{2,}/g);
      expect({ id, where, leftovers }).toEqual({ id, where, leftovers: null });
    }
  }
});

test("missing translations fall back to English per string, unknown locales to English", async () => {
  const partial: PartialCatalog = { magicLink: { heading: "Anmelden bei {instance}" } };
  const de = await render("magicLink", samples.magicLink, { locale: "de-AT", catalogs: { de: partial } });
  expect(de.locale).toBe("de");
  expect(de.text).toContain("Anmelden bei Example Air");
  expect(de.text).toContain(interpolate(en.magicLink.body, {}));
  expect(de.html).toContain('lang="de"');

  const fallback = await render("magicLink", samples.magicLink, { locale: "xx", catalogs: { de: partial } });
  expect(fallback.locale).toBe("en");
  expect(resolveCatalog(undefined).locale).toBe("en");
  expect(resolveCatalog("pt-BR", { "pt-BR": {}, pt: {} }).locale).toBe("pt-BR");
});

test("formats dates and money for the locale, from integer minor units", async () => {
  expect(formatMoney(123_456, "EUR", "en")).toBe("€1,234.56");
  expect(formatMoney(1500, "JPY", "en")).toBe("¥1,500");
  expect(formatMoney(-499, "USD", "en")).toBe("-$4.99");
  expect(() => formatMoney(12.5, "EUR", "en")).toThrow(TypeError);
  const de = await render("payoutSent", samples.payoutSent, { locale: "de", catalogs: { de: {} } });
  expect(de.text).toMatch(/1\.234,56\s€/);
  expect(de.text).toContain("18. Oktober 2026");
  await expect(render("payoutSent", { ...samples.payoutSent, sentAt: "not a date" })).rejects.toThrow("invalid date");
});

test("chargeback and clawback variants use their own strings", async () => {
  const chargeback = await render("chargebackNotice");
  const clawback = await render("chargebackNotice", { ...samples.chargebackNotice, kind: "clawback" });
  expect(chargeback.subject).toBe("A payment was charged back: €4.99");
  expect(clawback.subject).toBe("Earnings were reversed: €4.99");
  expect(clawback.text).toContain(en.chargebackNotice.headingClawback);
  expect(clawback.text).not.toContain(en.chargebackNotice.headingChargeback);
});

test("user-provided text is escaped and cannot break the subject line", async () => {
  const mail = await render("governanceVoteOpened", {
    ...samples.governanceVoteOpened,
    proposalTitle: 'Evil <script>alert(1)</script>\r\nBcc: victim@example.test "x"',
  });
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&lt;script&gt;");
  expect(mail.subject).not.toMatch(/[\r\n]/);
});

test("links that leave the instance are rejected", async () => {
  expect(() => assertInstanceLinks({ a: { b: ["https://evil.example.test/x"] } }, site)).toThrow(EmailLinkError);
  expect(() => assertInstanceLinks({ u: "javascript:alert(1)" }, site)).toThrow(EmailLinkError);
  expect(() => assertInstanceLinks({ u: "http://air.example.test/x" }, site)).toThrow(EmailLinkError); // scheme differs
  expect(() =>
    assertInstanceLinks({ u: `${site.publicUrl}/ok`, m: "mailto:x@air.example.test", n: 3 }, site),
  ).not.toThrow();
  await expect(
    render("dataExportReady", { ...samples.dataExportReady, downloadUrl: "https://s3.example.test/bucket/export.zip" }),
  ).rejects.toBeInstanceOf(EmailLinkError);
});

test("interpolation keeps unknown placeholders visible", () => {
  expect(interpolate("Hi {name}, {missing}", { name: "Ada" })).toBe("Hi Ada, {missing}");
});
