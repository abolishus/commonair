// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sends through real SMTP (Mailpit) and reads the message back over Mailpit's API. */
import { loadEnv, mailEnv } from "@commonair/config";
import { afterAll, expect, test } from "vite-plus/test";
import { createMailer, sampleData } from "../src/index.ts";
import { testSite } from "./fixtures.ts";

const MAILPIT_API = process.env.MAILPIT_API_URL ?? "http://localhost:8025";
const site = testSite();
const samples = sampleData(site.publicUrl);
const mailer = createMailer(loadEnv(mailEnv), { site });

afterAll(() => mailer.close());

interface Summary {
  ID: string;
  MessageID: string;
  To: { Address: string }[];
  Subject: string;
}

async function waitForMessage(recipient: string): Promise<Summary> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_API}/api/v1/messages?limit=200`);
    expect(res.ok).toBe(true);
    const { messages } = (await res.json()) as { messages: Summary[] };
    const found = messages.find((m) => m.To.some((t) => t.Address === recipient));
    if (found) return found;
    await Bun.sleep(100);
  }
  throw new Error(`no message for ${recipient} within 10s`);
}

test("delivers HTML + text with headers over SMTP", async () => {
  const recipient = `member-${crypto.randomUUID()}@air.example.test`;
  const messageId = await mailer.send("governanceVoteOpened", samples.governanceVoteOpened, recipient);
  expect(messageId).toMatch(/^<.+@.+>$/);

  const summary = await waitForMessage(recipient);
  expect(`<${summary.MessageID}>`).toBe(messageId);
  expect(summary.Subject).toBe(`Vote now: ${samples.governanceVoteOpened.proposalTitle}`);

  const message = (await (await fetch(`${MAILPIT_API}/api/v1/message/${summary.ID}`)).json()) as {
    From: { Name: string; Address: string };
    HTML: string;
    Text: string;
  };
  expect(message.From).toEqual({ Name: "Example Air", Address: "noreply@air.example.test" });
  expect(message.HTML).toContain(samples.governanceVoteOpened.voteUrl.replaceAll("&", "&amp;"));
  expect(message.Text).toContain(samples.governanceVoteOpened.voteUrl);

  const headers = (await (await fetch(`${MAILPIT_API}/api/v1/message/${summary.ID}/headers`)).json()) as Record<
    string,
    string[]
  >;
  expect(headers["List-Unsubscribe"]).toEqual([`<${samples.governanceVoteOpened.unsubscribeUrl}>`]);
  expect(headers["List-Unsubscribe-Post"]).toEqual(["List-Unsubscribe=One-Click"]);
  expect(headers["Auto-Submitted"]).toEqual(["auto-generated"]);
});

test("pooled transport sends several messages concurrently", async () => {
  const recipients = Array.from({ length: 5 }, () => `burst-${crypto.randomUUID()}@air.example.test`);
  const ids = await Promise.all(recipients.map((r) => mailer.send("magicLink", samples.magicLink, r)));
  expect(new Set(ids).size).toBe(5);
  for (const r of recipients) expect((await waitForMessage(r)).Subject).toBe("Your sign-in link for Example Air");
});
