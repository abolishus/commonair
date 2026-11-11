// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Overhaul wave 5 (w5-notify): the new-sign-in mail's time line and the governance mail headers. */
import { describe, expect, test } from "vite-plus/test";
import { MemoryMailer, renderEmail, sampleData } from "../src/index.ts";
import { testSite } from "./fixtures.ts";

const site = testSite();
const samples = sampleData(site.publicUrl);

describe("newSignIn", () => {
  test("names the time in UTC with a relative time, the device and the sign-out link", async () => {
    const now = await renderEmail("newSignIn", { ...samples.newSignIn, minutesAgo: 0 }, { site });
    expect(now.text).toContain("October 18, 2026 at 2:30 PM UTC (just now)");
    expect(now.text).toContain(samples.newSignIn.device ?? "");
    expect(now.text).toContain(`Sign out everywhere else ${site.publicUrl}/settings/security#sessions`);
    expect(now.unsubscribeUrl).toBeUndefined();
    const later = await renderEmail("newSignIn", { ...samples.newSignIn, minutesAgo: 3 }, { site });
    expect(later.text).toContain("UTC (3 minutes ago)");
    const one = await renderEmail("newSignIn", { ...samples.newSignIn, minutesAgo: 1.7 }, { site });
    expect(one.text).toContain("UTC (1 minute ago)");
    const es = await renderEmail("newSignIn", { ...samples.newSignIn, minutesAgo: 2 }, { site, locale: "es" });
    expect(es.text).toContain("(hace 2 minutos)");
    expect(es.text).toContain("Cerrar sesión en todos los demás");
  });

  test("an unidentified browser is said in words, never left blank", async () => {
    const { device: _device, approximateLocation: _location, ...rest } = samples.newSignIn;
    const mail = await renderEmail("newSignIn", rest, { site });
    expect(mail.text).toContain("A browser we could not identify");
    expect(mail.text).not.toContain("Approximate location");
  });
});

describe("governance mail", () => {
  test("vote opened and result published carry List-Unsubscribe with one-click", async () => {
    const mailer = new MemoryMailer({ site });
    await mailer.send("governanceVoteOpened", samples.governanceVoteOpened, "m@air.example.test");
    await mailer.send("governanceResultPublished", samples.governanceResultPublished, "m@air.example.test");
    expect(mailer.sent).toHaveLength(2);
    for (const mail of mailer.sent) {
      expect(mail.headers["List-Unsubscribe"]).toMatch(
        /^<https:\/\/air\.example\.test\/api\/email\/unsubscribe\?list=governance/,
      );
      expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    }
  });
});
