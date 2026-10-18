// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import nodemailer from "nodemailer";
import { expect, test } from "vite-plus/test";
import {
  buildMail,
  createMailer,
  EmailLinkError,
  MailerClosedError,
  smtpTransportOptions,
  defaultFrom,
  InvalidRecipientError,
  MemoryMailer,
  renderEmail,
  sampleData,
} from "../src/index.ts";
import { testSite } from "./fixtures.ts";

const site = testSite();
const samples = sampleData(site.publicUrl);

test("MemoryMailer captures exactly what would be sent", async () => {
  const mailer = new MemoryMailer({ site });
  const id = await mailer.send("passwordReset", samples.passwordReset, "ada@air.example.test");
  expect(id).toMatch(/^<[0-9a-f-]{36}@air\.example\.test>$/);
  expect(mailer.sent).toHaveLength(1);

  const [mail] = mailer.to("ada@air.example.test");
  const rendered = await renderEmail("passwordReset", samples.passwordReset, { site });
  expect(mail).toMatchObject({
    messageId: id,
    template: "passwordReset",
    locale: "en",
    to: "ada@air.example.test",
    from: { name: "Example Air", address: "noreply@air.example.test" },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: { "Auto-Submitted": "auto-generated" },
  });
  expect(mail!.headers).not.toHaveProperty("List-Unsubscribe");

  mailer.clear();
  expect(mailer.sent).toHaveLength(0);
});

test("governance announcements get one-click List-Unsubscribe headers", async () => {
  const mailer = new MemoryMailer({ site });
  await mailer.send("governanceVoteOpened", samples.governanceVoteOpened, "member@air.example.test");
  expect(mailer.sent[0]!.headers).toMatchObject({
    "List-Unsubscribe": `<${samples.governanceVoteOpened.unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });
});

test("the recipient's locale is used and removed from template data", async () => {
  const mailer = new MemoryMailer({ site, catalogs: { fr: { magicLink: { subject: "Connexion à {instance}" } } } });
  await mailer.send("magicLink", { ...samples.magicLink, locale: "fr-CA" }, "a@air.example.test");
  expect(mailer.sent[0]).toMatchObject({ locale: "fr", subject: "Connexion à Example Air" });
});

test("rejects anything but a single plain address", async () => {
  const mailer = new MemoryMailer({ site });
  for (const bad of ["", "nobody", "a@b.test, c@d.test", "Ada <a@b.test>", "a@b.test\r\nBcc: c@d.test", "a b@c.test"]) {
    await expect(mailer.send("magicLink", samples.magicLink, bad)).rejects.toBeInstanceOf(InvalidRecipientError);
  }
  expect(mailer.sent).toHaveLength(0);
});

test("From: MAIL_FROM wins, flagship uses its noreply contact, others their own host", () => {
  expect(defaultFrom(site, '"Air" <mail@air.example.test>')).toBe('"Air" <mail@air.example.test>');
  expect(defaultFrom(site)).toEqual({ name: "Example Air", address: "noreply@air.example.test" });
  const flagship = testSite({ INSTANCE_IS_FLAGSHIP: "true" });
  expect(defaultFrom(flagship)).toEqual({ name: "Example Air", address: flagship.contacts.noreply });
});

test("SMTP send failures surface as rejections (nothing listening)", async () => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = closed.port ?? 1;
  await closed.stop(true);
  const mailer = createMailer(
    { SMTP_HOST: "127.0.0.1", SMTP_PORT: port, SMTP_SECURE: false, SMTP_REQUIRE_TLS: false },
    { site, timeouts: { connection: 2_000, greeting: 2_000, socket: 2_000 } },
  );
  try {
    await expect(mailer.send("magicLink", samples.magicLink, "a@air.example.test")).rejects.toBeInstanceOf(Error);
  } finally {
    await mailer.close();
  }
});

test("List-Unsubscribe cannot be spliced into a second URL", async () => {
  const mailer = new MemoryMailer({ site });
  const spliced = "https://air.example.test/u/x>, <https://evil.example/u";
  await expect(
    mailer.send(
      "governanceVoteOpened",
      { ...samples.governanceVoteOpened, unsubscribeUrl: spliced },
      "m@air.example.test",
    ),
  ).rejects.toBeInstanceOf(EmailLinkError);

  // Without whitespace the URL is valid, but serialisation percent-encodes the brackets.
  const tight = "https://air.example.test/u/x>,<https://evil.example/u";
  const mail = await buildMail(
    "governanceVoteOpened",
    { ...samples.governanceVoteOpened, unsubscribeUrl: tight },
    "m@air.example.test",
    { site, from: defaultFrom(site) },
  );
  const sent = (
    await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      headers: mail.headers,
    })
  ).message as Buffer;
  const raw = sent.toString("utf8");
  const header = raw.split(/\r?\n(?=\S)/).find((l) => l.startsWith("List-Unsubscribe:"));
  expect(header?.replace(/\r?\n\s+/g, " ")).toBe(
    "List-Unsubscribe: <https://air.example.test/u/x%3E,%3Chttps://evil.example/u>",
  );
  expect(mail.html).toContain('href="https://air.example.test/u/x%3E,%3Chttps://evil.example/u"');
});

test("STARTTLS is required when configured and whenever credentials go over a plain connection", () => {
  const base = { SMTP_HOST: "smtp.example.test", SMTP_PORT: 587, SMTP_SECURE: false, SMTP_REQUIRE_TLS: false };
  expect(smtpTransportOptions(base).requireTLS).toBe(false);
  expect(smtpTransportOptions({ ...base, SMTP_REQUIRE_TLS: true }).requireTLS).toBe(true);
  expect(smtpTransportOptions({ ...base, SMTP_USER: "u", SMTP_PASSWORD: "p" })).toMatchObject({
    requireTLS: true,
    auth: { user: "u", pass: "p" },
  });
  // Implicit TLS (port 465) is already encrypted; STARTTLS does not apply.
  expect(smtpTransportOptions({ ...base, SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: "u" }).requireTLS).toBe(false);
});

test("close() waits for in-flight sends, then refuses new ones", async () => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = closed.port ?? 1;
  await closed.stop(true);
  const mailer = createMailer(
    { SMTP_HOST: "127.0.0.1", SMTP_PORT: port, SMTP_SECURE: false, SMTP_REQUIRE_TLS: false },
    { site, timeouts: { connection: 2_000, greeting: 2_000, socket: 2_000 } },
  );
  let settled = false;
  const inFlight = mailer.send("magicLink", samples.magicLink, "a@air.example.test").then(
    () => (settled = true),
    () => (settled = true),
  );
  await mailer.close();
  expect(settled).toBe(true);
  await inFlight;
  await expect(mailer.send("magicLink", samples.magicLink, "a@air.example.test")).rejects.toBeInstanceOf(
    MailerClosedError,
  );
});
