// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sourceLink } from "@commonair/config";
import { describe, expect, test } from "vite-plus/test";
import {
  EmailLinkError,
  en,
  formatMoney,
  interpolate,
  normalizeInstanceUrl,
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
      "goLiveDigest",
      "dmcaNoticeReceived",
      "dmcaNoticeDecided",
      "dmcaCounterNoticeForwarded",
      "contentRestored",
      "appealDecided",
      "enforcementStatement",
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
  const announcements = new Set(["governanceResultPublished", "governanceVoteOpened", "goLiveDigest"]);
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
    decisionNote: "В уведомлении не указано произведение",
    address: "Улица Примерная, 1",
    statement: "Я сам записал это выступление",
  });
  const refs = JSON.stringify(data).replace(
    /"(reference|noticeRef|appealRef|statementRef|clauseRef|caseRef|requestRef)":"[^"]*"/g,
    '"$1":"№ 1207"',
  );
  const out = JSON.parse(refs) as SampleData;
  // The notice sections are operator text in the recipient's language, passed as data.
  out.enforcementStatement = {
    ...out.enforcementStatement,
    explanation: "Оружие, которое угрожает людям, запрещено.",
    redress: "Вы можете обжаловать решение.",
  };
  return out;
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

const HOSTILE_LINKS = [
  "https://evil.example.test/x",
  "http://air.example.test/x", // scheme differs from the instance origin
  "https://air.example.test.evil.example/x",
  "https://air.example.test@evil.example/x",
  "https://user:pw@air.example.test/x",
  "//evil.example/x",
  "/relative",
  "relative/path",
  "",
  "javascript:alert(1)",
  " javascript:alert(1)",
  "java\tscript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "data:text/html,<script>alert(1)</script>",
  "mailto:x@air.example.test",
  " https://air.example.test/x",
  "https://air.example.test/x ",
  "https://air.example.test/x\r\nBcc: v@evil.example",
  "https://air.example.test/u/x>, <https://evil.example/u",
  "https:\\\\evil.example/x",
  "https://air.example.test\\@evil.example/x",
];

test.each(HOSTILE_LINKS)("rejects link %j", async (link) => {
  expect(() => normalizeInstanceUrl(link, site)).toThrow(EmailLinkError);
  await expect(render("dataExportReady", { ...samples.dataExportReady, downloadUrl: link })).rejects.toBeInstanceOf(
    EmailLinkError,
  );
});

test("a storage link is accepted only in a storageLinks field and only on the configured origin", async () => {
  const signed = "http://storage.example.test:3900/commonair-exports/exports/u/e.zip?X-Amz-Expires=604800";
  const storageOrigin = "http://storage.example.test:3900";
  const mail = await render("dataExportReady", { ...samples.dataExportReady, downloadUrl: signed }, { storageOrigin });
  expect(mail.html).toContain("storage.example.test:3900");
  // Without the configured origin, or on another origin, it is refused.
  await expect(render("dataExportReady", { ...samples.dataExportReady, downloadUrl: signed })).rejects.toBeInstanceOf(
    EmailLinkError,
  );
  await expect(
    render("dataExportReady", { ...samples.dataExportReady, downloadUrl: "https://evil.example/x" }, { storageOrigin }),
  ).rejects.toBeInstanceOf(EmailLinkError);
  // A template field not declared in storageLinks stays on the instance origin.
  await expect(
    render("contentRestored", { ...samples.contentRestored, contentUrl: `${storageOrigin}/x` }, { storageOrigin }),
  ).rejects.toBeInstanceOf(EmailLinkError);
});

test("accepts and normalises links on the instance origin", async () => {
  expect(normalizeInstanceUrl("HTTPS://AIR.example.test:443/a/../b?q=1#f", site)).toBe(
    "https://air.example.test/b?q=1#f",
  );
  expect(normalizeInstanceUrl("https://air.example.test/p?x=<y>", site)).toBe("https://air.example.test/p?x=%3Cy%3E");
  const mail = await render("contentRestored", {
    ...samples.contentRestored,
    contentUrl: "https://AIR.example.test/videos/%7e1",
  });
  expect(mail.html).toContain('href="https://air.example.test/videos/%7e1"');
  // The error names the field, never echoes the attacker-controlled value.
  const err = await render("contentRestored", {
    ...samples.contentRestored,
    contentUrl: "https://evil.example/x",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(EmailLinkError);
  expect((err as Error).message).toContain("contentUrl");
  expect((err as Error).message).not.toContain("evil");
});

test("free-text fields may contain URLs: rendered as text, never as links", async () => {
  const hostile = "watch https://evil.example/x and javascript:alert(1)";
  const mail = await render("dmcaNoticeReceived", { ...samples.dmcaNoticeReceived, contentTitle: hostile });
  expect(mail.text).toContain(hostile);
  expect(mail.html).not.toMatch(/href="[^"]*evil/);
  const vote = await render("governanceVoteOpened", { ...samples.governanceVoteOpened, proposalTitle: hostile });
  expect(vote.subject).toContain(hostile);
  const key = await render("streamKeyRevoked", { ...samples.streamKeyRevoked, channelName: "https://evil.example" });
  expect(key.html).not.toMatch(/href="https:\/\/evil/);
  const signIn = await render("newSignIn", { ...samples.newSignIn, device: "https://evil.example/ua" });
  expect(signIn.html).not.toMatch(/href="https:\/\/evil/);
});

test("interpolation keeps unknown placeholders visible", () => {
  expect(interpolate("Hi {name}, {missing}", { name: "Ada" })).toBe("Hi Ada, {missing}");
});

test("every storageLinks field is also a declared link", async () => {
  const { templates } = await import("../src/registry.ts");
  for (const def of Object.values(templates) as { links: readonly string[]; storageLinks?: readonly string[] }[]) {
    for (const key of def.storageLinks ?? []) expect(def.links).toContain(key);
  }
});

describe("DMCA mail (17 U.S.C. § 512; not reviewed by a lawyer)", () => {
  test("a rejection tells the claimant what is missing; an actioned notice says access was disabled", async () => {
    const rejected = await render("dmcaNoticeDecided");
    expect(rejected.subject).toBe("Your copyright notice DMCA-2026-0091 could not be actioned");
    expect(rejected.text).toContain(samples.dmcaNoticeDecided.note);
    expect(rejected.text).toContain(en.dmcaNoticeDecided.resubmit);
    const actioned = await render("dmcaNoticeDecided", {
      ...samples.dmcaNoticeDecided,
      decision: "actioned",
      note: "",
      removedItems: 2,
      totalItems: 2,
    });
    expect(actioned.text).toContain("disabled access to the material it identified");
    expect(actioned.subject).toBe("Your copyright notice DMCA-2026-0091 was actioned");
    expect(actioned.text).toContain(en.dmcaNoticeDecided.headingActioned);
    expect(actioned.text).not.toContain(en.dmcaNoticeDecided.noteLabel);
    expect(actioned.text).not.toContain(en.dmcaNoticeDecided.resubmit);
    // The designated agent's address is the way to answer.
    expect(actioned.html).toContain(`mailto:${site.contacts.dmca}`);
  });

  test("an actioned notice that disabled only some, or none, of its locations says so", async () => {
    const base = { ...samples.dmcaNoticeDecided, decision: "actioned" as const, note: "" };
    const partial = await render("dmcaNoticeDecided", { ...base, removedItems: 1, totalItems: 3 });
    expect(partial.text).toContain("at 1 of the 3 locations");
    expect(partial.text).not.toContain("disabled access to the material it identified");
    const none = await render("dmcaNoticeDecided", { ...base, removedItems: 0, totalItems: 2 });
    expect(none.text).toContain("so nothing was removed");
    expect(none.text).not.toContain("disabled access");
  });

  test("the forwarded counter-notice carries every § 512(g)(3) element and the restore date", async () => {
    const d = samples.dmcaCounterNoticeForwarded;
    const mail = await render("dmcaCounterNoticeForwarded");
    for (const part of [d.fullName, d.address, d.phone, d.statement, d.signature, ...d.items])
      expect(mail.text).toContain(part);
    expect(mail.text).toContain(en.dmcaCounterNoticeForwarded.signatureLabel);
    expect(mail.text).toContain(en.dmcaCounterNoticeForwarded.restoreLabel);
    expect(mail.html).toContain(`mailto:${site.contacts.dmca}`);
    // The item URLs are text, never links.
    for (const u of d.items) expect(mail.html).not.toContain(`href="${u}"`);
  });

  test("counter-notice text is escaped and cannot break the subject", async () => {
    const mail = await render("dmcaCounterNoticeForwarded", {
      ...samples.dmcaCounterNoticeForwarded,
      statement: "<script>alert(1)</script>",
      noticeRef: "Evil\r\nBcc: x@example.test",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  test("the uploader's notice links to the copyright settings page", async () => {
    const mail = await render("dmcaNoticeReceived");
    expect(mail.html).toContain("/settings/copyright?notice=sample");
  });
});
