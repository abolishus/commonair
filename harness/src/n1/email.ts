// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Step 2 (N1-email): the go-live email digest and its one-click unsubscribe (docs/testing/n1-selectors.md
 * "Scenarios" 2; ADR 0028 decisions 3 and 4). The viewer has a verified address and turns go-live
 * email on; the second streamer goes live; within the digest window plus a sweep, Mailpit holds one
 * go-live email linking the channel, with `List-Unsubscribe` on the one-click route and RFC 8058
 * `List-Unsubscribe-Post`. A POST of that URL turns go-live email off.
 */
import { EMAIL_UNSUBSCRIBE_PATH, NOTIFY_RULES } from "@commonair/contracts/notify";
import { extractLinks, type MailMessage } from "../mailpit.ts";
import { FixturePublisher } from "../safety-io.ts";
import { benignPatternSource, runSeed } from "../safety.ts";
import { rtmpPublishUrl } from "../streamer.ts";
import { sleep } from "../wait.ts";
import { waitLive } from "../e8/kit.ts";
import { type N1Run, type N1Step } from "./run.ts";

/** The harness digest window is one minute and the sweep runs every 30 s (contract step §8: 120 s), plus CI slack. */
export const GO_LIVE_EMAIL_TIMEOUT_MS = 150_000;
const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";
/** Slack past one sweep before counting emails, for a loaded runner and Mailpit's delivery. */
const DUPLICATE_SLACK_MS = 5_000;

/** Every value of a header in Mailpit's `headers()` answer, matched case-insensitively. */
export function headerValues(headers: Record<string, string[]>, name: string): string[] {
  const wanted = name.toLowerCase();
  return Object.entries(headers)
    .filter(([k]) => k.toLowerCase() === wanted)
    .flatMap(([, v]) => v);
}

/**
 * The one `List-Unsubscribe` URL (`<https://…>`), or null when the header is missing, carries
 * several URLs or a `mailto:`, or is not the one-click route with a list and a token.
 */
export function oneClickUrl(headers: Record<string, string[]>): URL | null {
  const values = headerValues(headers, "List-Unsubscribe");
  if (values.length !== 1) return null;
  const m = /^\s*<(https?:\/\/[^<>\s]+)>\s*$/.exec(values[0] ?? "");
  if (!m?.[1]) return null;
  const url = new URL(m[1]);
  if (url.pathname !== EMAIL_UNSUBSCRIBE_PATH) return null;
  if (!url.searchParams.get("list") || !url.searchParams.get("token")) return null;
  return url;
}

/** Whether the mail announces exactly this channel's go-live: a link to `/<slug>` on the instance. */
export function linksChannel(message: Pick<MailMessage, "text" | "html">, slug: string): boolean {
  return extractLinks(message).some((link) => {
    try {
      // The text part reads "<name> <url>: <title>", so a trailing colon is punctuation.
      return new URL(link.replace(/:+$/, "")).pathname === `/${slug}`;
    } catch {
      return false;
    }
  });
}

/**
 * Where the harness POSTs the one-click URL: its path and query on the API the harness reaches
 * (the URL in the mail is on `PUBLIC_URL`, the web app, which proxies `/api/*` to the same route).
 */
export function oneClickTarget(url: URL, apiBaseUrl: string): URL {
  return new URL(`${url.pathname}${url.search}`, apiBaseUrl);
}

async function run(r: N1Run): Promise<void> {
  const { ctx, platform: p, actors } = r;
  const viewer = actors.viewer;
  const streamer = actors.streamers[1];
  const mailpit = p.users.mailpit;

  await ctx.step("2. email: the viewer's address is verified", async () => {
    if ((await viewer.api.client.me.get()).emailVerified) return;
    await p.users.verifyEmail(viewer.api, viewer.email);
    ctx.assert("viewer email verified", (await viewer.api.client.me.get()).emailVerified);
  });
  await ctx.step("2. email: follow the second streamer (bell on) and turn go-live email on", async () => {
    await viewer.api.client.channels.follow({ channel: streamer.channel, notify: true });
    const prefs = await viewer.api.client.notifications.preferences.set({
      type: "go_live",
      medium: "email",
      channel: null,
      enabled: true,
    });
    ctx.assert("go-live email is on", prefs.defaults.email, prefs.defaults);
    ctx.assert("preferences see the verified address", prefs.emailVerified, prefs.emailVerified);
  });
  r.state.emailChannel = streamer.channel;

  const { key } = await streamer.user.api.client.stream.rotateKey({ channel: streamer.channel });
  const pub = new FixturePublisher(
    `publisher-${streamer.channel}`,
    {
      url: rtmpPublishUrl(ctx.env.HARNESS_RTMP_URL, key),
      lavfi: benignPatternSource((runSeed(ctx.runId) + 21) & 0x7fffffff),
    },
    ctx.log,
  );
  ctx.defer(() => pub.stop(1_000));
  await ctx.step("2. email: the second streamer goes live", () => pub.start());
  const liveAt = await ctx.step("2. email: channel is live", () => waitLive(ctx, streamer.channel));

  const mail = await ctx.step("2. email: one go-live email arrives", () =>
    mailpit.waitForMessage(viewer.email, (m) => linksChannel(m, streamer.channel), GO_LIVE_EMAIL_TIMEOUT_MS),
  );
  ctx.data("goLiveEmailMs", Date.now() - liveAt);
  // Stop now: the later steps do not need this channel live.
  await pub.stop(1_000);

  const url = await ctx.step("2. email: List-Unsubscribe is the one-click route (RFC 8058)", async () => {
    const headers = await mailpit.headers(mail.id);
    const found = oneClickUrl(headers);
    ctx.assert("List-Unsubscribe names the one-click route with a list and token", found !== null, {
      values: headerValues(headers, "List-Unsubscribe").length,
    });
    ctx.assert("list is go_live", found?.searchParams.get("list") === "go_live");
    ctx.assert(
      "List-Unsubscribe-Post is One-Click",
      headerValues(headers, "List-Unsubscribe-Post")
        .map((v) => v.trim())
        .join("|") === ONE_CLICK_BODY,
      headerValues(headers, "List-Unsubscribe-Post"),
    );
    if (!found) throw new Error("no one-click List-Unsubscribe URL");
    return found;
  });

  await ctx.step("2. email: exactly one go-live email for the channel", async () => {
    // A duplicate would come from a later sweep, so give one full sweep (plus slack) to show up.
    await sleep(NOTIFY_RULES.emailDigestSweepMs + DUPLICATE_SLACK_MS, ctx.signal);
    const all = await mailpit.search(`to:"${viewer.email}"`);
    let count = 0;
    for (const s of all) if (linksChannel(await mailpit.get(s.id), streamer.channel)) count++;
    ctx.assert("one go-live email for the second channel", count === 1, { count });
  });

  await ctx.step("2. email: a one-click POST unsubscribes", async () => {
    const res = await fetch(oneClickTarget(url, p.apiBaseUrl()), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: ONE_CLICK_BODY,
      redirect: "manual",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
    });
    ctx.assert("one-click POST answers 200", res.status === 200, { status: res.status });
    const prefs = await viewer.api.client.notifications.preferences.get({ type: "go_live" });
    ctx.assert("go-live email is off afterwards", prefs.defaults.email === false, prefs.defaults);
  });
}

export const step: N1Step = {
  name: "email",
  owner: "N1-email",
  needs: [1],
  run,
};
