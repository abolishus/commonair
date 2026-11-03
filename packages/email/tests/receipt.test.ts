// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payment receipt (`paymentReceipt`, M1-gifts-refunds): the amount, each `PaymentBreakdown`
 * line with its label, the time, the reference, the channel (or the co-op for a share) and the
 * link to the payer's payments page, in English and Spanish. Amounts go through `formatMoney`
 * (integer cents, explicit currency). Nothing personal is in the data, so nothing personal renders.
 */
import { describe, expect, test } from "vite-plus/test";
import { formatMoney, renderEmail, type TemplateData } from "../src/index.ts";
import { RECEIPT_PAYMENTS_PATH } from "../src/templates/receipt.tsx";
import { testSite } from "./fixtures.ts";

const site = testSite();
const data: TemplateData<"paymentReceipt"> = {
  amountCents: 1099,
  currency: "usd",
  lines: [
    { kind: "tax", amountCents: 99 },
    { kind: "creator", amountCents: 900 },
    { kind: "coop_share", amountCents: 100 },
    { kind: "processor_fee", amountCents: -62 },
    { kind: "coop_net", amountCents: 38 },
  ],
  paidAt: "2026-11-03T12:34:00Z",
  reference: "pi_3Receipt",
  channelName: "Ada Plays",
  kind: "subscription",
};

/** The rows of the text part between the lines heading and the button. */
function lineRows(text: string, heading: string, action: string): string[] {
  const from = text.indexOf(heading);
  const to = text.indexOf(action);
  return text
    .slice(from + heading.length, to)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

describe("paymentReceipt", () => {
  test("English: amount, channel, time, reference, and each breakdown line", async () => {
    const mail = await renderEmail("paymentReceipt", data, { site, locale: "en" });
    expect(mail.subject).toBe(`Your receipt: ${formatMoney(1099, "usd", "en")}`);
    expect(mail.text).toContain("Ada Plays");
    expect(mail.text).toContain("pi_3Receipt");
    expect(mail.text).toContain("Subscription");
    expect(mail.text).toContain("2026");
    expect(lineRows(mail.text, "Where your money goes", "See your payments")).toMatchInlineSnapshot(`
      [
        "Tax",
        "$0.99",
        "To the creator",
        "$9.00",
        "To the co-op",
        "$1.00",
        "Payment processing fee (paid by the co-op)",
        "-$0.62",
        "The co-op keeps",
        "$0.38",
      ]
    `);
    expect(mail.html).toContain(`href="${site.publicUrl}${RECEIPT_PAYMENTS_PATH}"`);
    expect(mail.text).toContain("It is not a tax invoice.");
  });

  test("Spanish: the same facts in the payer's language", async () => {
    const mail = await renderEmail("paymentReceipt", data, { site, locale: "es" });
    expect(mail.subject).toBe(`Tu recibo: ${formatMoney(1099, "usd", "es")}`);
    expect(mail.html).toContain('lang="es"');
    // Spanish money has a no-break space before the symbol; compare with the formatter's own output.
    const es = (cents: number) => formatMoney(cents, "usd", "es");
    expect(lineRows(mail.text, "Adónde va tu dinero", "Ver tus pagos")).toEqual([
      "Impuestos",
      es(99),
      "Para el creador",
      es(900),
      "Para la cooperativa",
      es(100),
      "Comisión del procesador de pagos (la paga la cooperativa)",
      es(-62),
      "La cooperativa se queda con",
      es(38),
    ]);
    expect(es(-62)).toMatch(/^-0,62\sUS\$$/);
    expect(mail.text).toContain("No es una factura");
  });

  test("a co-op share names the co-op; a payment without readable lines still has its amount", async () => {
    const mail = await renderEmail(
      "paymentReceipt",
      { ...data, kind: "membership_share", channelName: null, lines: [] },
      { site, locale: "en" },
    );
    expect(mail.text).toContain(`The ${site.name} co-op`);
    expect(mail.text).toContain("Co-op member share");
    expect(mail.text).not.toContain("Where your money goes");
    expect(mail.text).toContain(formatMoney(1099, "usd", "en"));
  });

  test("a tip is labelled as one", async () => {
    const mail = await renderEmail("paymentReceipt", { ...data, kind: "tip" }, { site, locale: "en" });
    expect(mail.text).toContain("Tip");
  });
});
