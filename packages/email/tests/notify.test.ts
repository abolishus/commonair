// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The go-live digest (ADR 0028 decisions 3 and 4) and link lists. */
import { describe, expect, test } from "vite-plus/test";
import {
  buildMail,
  EmailLinkError,
  en,
  GO_LIVE_DIGEST_MAX_CHANNELS,
  MemoryMailer,
  normalizeLinkLists,
  renderEmail,
  sampleData,
  type GoLiveDigestChannel,
  type GoLiveDigestData,
} from "../src/index.ts";
import { testSite } from "./fixtures.ts";

const site = testSite();
const origin = site.publicUrl;
const base = sampleData(origin).goLiveDigest;
const unsubscribeUrl = `${origin}/api/email/unsubscribe?list=go_live&token=v1.abc.def`;

const channel = (i: number, title = `Title ${i}`): GoLiveDigestChannel => ({
  name: `Channel ${i}`,
  title,
  url: `${origin}/channel_${i}`,
});
const digest = (channels: GoLiveDigestChannel[]): GoLiveDigestData => ({ ...base, channels, unsubscribeUrl });
const render = (data: GoLiveDigestData) => renderEmail("goLiveDigest", data, { site });

describe("goLiveDigest", () => {
  test("one channel: the channel names the subject and the heading, linked with its title", async () => {
    const mail = await render(digest([channel(1, "Speedrun night")]));
    expect(mail.subject).toBe("Channel 1 is live on Example Air");
    expect(mail.text).toContain("Channel 1 is live");
    expect(mail.html).toContain(`href="${origin}/channel_1"`);
    expect(mail.text).toContain("Speedrun night");
    expect(mail.text).toContain(en.goLiveDigest.why.replace("{instance}", site.name));
    expect(mail.html).toContain(`href="${origin}/settings/notifications"`);
    expect(mail.text).not.toContain(en.goLiveDigest.more);
  });

  test("several channels: one subject without a count, every channel listed and linked", async () => {
    const mail = await render(digest([channel(1), channel(2), channel(3)]));
    expect(mail.subject).toBe("Channels you follow are live on Example Air");
    expect(mail.subject).not.toMatch(/\d/);
    for (const i of [1, 2, 3]) {
      expect(mail.html).toContain(`href="${origin}/channel_${i}"`);
      expect(mail.text).toContain(`Title ${i}`);
    }
    expect(mail.html.match(/<li[\s>]/g)).toHaveLength(3);
  });

  test("more than the maximum: the first ones are listed, then a line linking the home page", async () => {
    const many = Array.from({ length: GO_LIVE_DIGEST_MAX_CHANNELS + 5 }, (_, i) => channel(i + 1));
    const mail = await render(digest(many));
    expect(mail.html.match(/<li[\s>]/g)).toHaveLength(GO_LIVE_DIGEST_MAX_CHANNELS);
    expect(mail.html).toContain(`href="${origin}/channel_${GO_LIVE_DIGEST_MAX_CHANNELS}"`);
    expect(mail.html).not.toContain(`href="${origin}/channel_${GO_LIVE_DIGEST_MAX_CHANNELS + 1}"`);
    expect(mail.text).toContain(en.goLiveDigest.more);
    expect(mail.html).toMatch(new RegExp(`href="${origin}/?"[^>]*>${en.goLiveDigest.more}`));
  });

  test("exactly the maximum lists everything and has no 'more' line", async () => {
    const mail = await render(digest(Array.from({ length: GO_LIVE_DIGEST_MAX_CHANNELS }, (_, i) => channel(i + 1))));
    expect(mail.html.match(/<li[\s>]/g)).toHaveLength(GO_LIVE_DIGEST_MAX_CHANNELS);
    expect(mail.text).not.toContain(en.goLiveDigest.more);
  });

  test("an empty title (the mature rule) shows the channel alone", async () => {
    const mail = await render(digest([channel(1, "")]));
    expect(mail.html).toMatch(/<li[^>]*><a[^>]*>Channel 1<\/a><\/li>/);
    expect(mail.text).not.toContain("Channel 1:");
  });

  test("a hostile title and name stay escaped text and never become links", async () => {
    const hostile = 'Evil <script>alert(1)</script> <a href="https://evil.example/x">x</a>\r\nBcc: v@evil.example';
    const mail = await render(digest([{ name: hostile, title: hostile, url: `${origin}/evil` }]));
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).not.toMatch(/href="https:\/\/evil/);
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  test("carries List-Unsubscribe and RFC 8058 List-Unsubscribe-Post", async () => {
    const mail = await buildMail("goLiveDigest", digest([channel(1)]), "a@example.test", {
      site,
      from: "x@example.test",
    });
    expect(mail.headers["List-Unsubscribe"]).toBe(`<${unsubscribeUrl}>`);
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.html).toContain(en.layout.unsubscribe);
    const mailer = new MemoryMailer({ site });
    await mailer.send("goLiveDigest", { ...digest([channel(1)]), locale: "en" }, "b@example.test");
    expect(mailer.to("b@example.test")[0]?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
  // The text snapshot of the two-channel sample is in templates.test.ts (every template has one).
});

describe("link lists", () => {
  test("a foreign-origin item URL throws EmailLinkError naming the item, not the value", async () => {
    const err = await render(digest([channel(1), { ...channel(2), url: "https://evil.example/x" }])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EmailLinkError);
    expect((err as Error).message).toContain("channels[1].url");
    expect((err as Error).message).not.toContain("evil");
  });

  test.each(["javascript:alert(1)", "//evil.example/x", "/relative", "", "https://user:pw@air.example.test/x"])(
    "refuses item link %j",
    async (url) => {
      await expect(render(digest([{ ...channel(1), url }]))).rejects.toBeInstanceOf(EmailLinkError);
    },
  );

  test("items are normalised and other fields kept", async () => {
    const out = normalizeLinkLists(
      { channels: [{ name: "a", title: "t", url: "HTTPS://AIR.example.test:443/a/../b" }], other: 1 },
      [{ field: "channels", key: "url" }],
      site,
    );
    expect(out).toEqual({ channels: [{ name: "a", title: "t", url: "https://air.example.test/b" }], other: 1 });
    const mail = await render(digest([{ ...channel(1), url: "HTTPS://AIR.example.test/x/../ch" }]));
    expect(mail.html).toContain(`href="${origin}/ch"`);
  });

  test("a list field that is not an array, or an item that is not an object, is refused", () => {
    const lists = [{ field: "channels", key: "url" }];
    expect(() => normalizeLinkLists({ channels: "x" }, lists, site)).toThrow(EmailLinkError);
    expect(() => normalizeLinkLists({ channels: [null] }, lists, site)).toThrow(EmailLinkError);
    expect(() => normalizeLinkLists({ channels: [] }, lists, site)).not.toThrow();
  });
});
