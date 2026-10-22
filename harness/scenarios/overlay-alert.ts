// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E6, overlay alerts (docs/testing/e6-selectors.md, "Scenario `overlay-alert`"):
 * 1 S configures the tip alert and creates a 7-day overlay token on `/overlays`; 2 a browser with
 * no cookies opens the alerts URL; 3 a test alert shows; 4 a confirmed 250-cent tip shows with V's
 * name, a 50-cent tip (below the minimum) shows nothing, an anonymous tip shows without V's name;
 * 5 the token authenticates nothing but its own overlay; 6 rotating and revoking refuse the open
 * overlays within 30 s; 7 a past expiry is refused and a 5-second token stops working, its open
 * stream closing within 30 s; 8 the audit rows exist.
 *
 * Next to the overlay page, an SSE client holds the alert stream open like OBS would, on both
 * paths, so every frame is checked for data the overlay must not carry (payer id, email, an
 * anonymous tipper's name). `--set via=api` replaces the `/overlays` page and the overlay page by
 * API calls and that stream. Token values and overlay URLs are never logged or reported.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import type { ApiClient } from "../src/api/client.ts";
import { auditActionCounts } from "../src/e6/db.ts";
import {
  type Kit,
  UI_TIMEOUT_MS,
  confirmedTip,
  rebaseHttp,
  setupKit,
  staffAccount,
  tokenClient,
  tokenOf,
} from "../src/e6/kit.ts";
import { CONFIRM_DIALOG_CONFIRM, E6_ROUTES, E6_TEST_IDS as E, byE6Id, etid } from "../src/e6/selectors.ts";
import { SseStream, overlayEventsUrl, refusedStream } from "../src/e6/sse.ts";
import {
  chooseOption,
  confirmDialog,
  dataOf,
  fillAmount,
  gotoSecretUrl,
  installAlertRecorder,
  recordedAlerts,
  setSwitch,
  waitOverlayState,
} from "../src/e6/web.ts";
import { ApiTreasurer } from "../src/money-actors.ts";
import { apiError, errorOf } from "../src/safety.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import type { SignedInUser } from "../src/users.ts";
import { waitFor } from "../src/wait.ts";
import type { WebSession } from "../src/web/session.ts";

const TIP_MESSAGE_TEMPLATE = "${user} tipped ${amount}";
const MIN_CENTS = 100;
const DURATION_MS = 5_000;
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
/** Spec: alerts within 10 s of the tip's confirmation; refusals within 30 s. */
const ALERT_DEADLINE_MS = 10_000;
const REFUSE_DEADLINE_MS = 30_000;
const SHORT_TOKEN_MS = 5_000;
/** The overlay's i18n "Anonymous" label (`alert.anonymous`, instance locale `en`). */
const ANONYMOUS_LABEL = "Anonymous";
/** The only SSE event types the overlay stream may send. */
const STREAM_EVENT_TYPES = new Set(["alert", "ping", "revoked"]);

interface OverlayAlertFrame {
  id: string;
  type: string;
  text: string;
  message: string | null;
  amountCents: number | null;
  test: boolean;
}

export default defineScenario({
  name: "overlay-alert",
  description:
    "tip alert + 7-day overlay token on /overlays → cookie-less overlay live → test alert → 250-cent tip alert with the name, 50 cents nothing, anonymous without the name → token grants only its overlay → rotate and revoke refuse open overlays within 30 s → past expiry refused, 5 s token expires and its stream closes → audit rows",
  needs: ["api", "web", "worker", "browser"],
  timeoutMs: 15 * 60_000,
  async run(ctx) {
    const kit = await setupKit(ctx);
    await overlayAlert(ctx, kit);
    kit.done();
  },
});

const isUnauthorized = (err: unknown) => apiError(err).code === "UNAUTHORIZED";

async function overlayAlert(ctx: ScenarioContext, kit: Kit): Promise<void> {
  const p = ctx.platform;
  const signal = ctx.signal;
  const [s, v] = await ctx.step("sign up streamer S and viewer V (API)", () =>
    Promise.all([
      p.signUp({ prefix: "e6oa_s" }),
      p.signUp({ prefix: "e6oa_v", displayName: `Vtipper ${ctx.runId}`.slice(0, 30) }),
    ]),
  );
  const treasurerUser = await staffAccount(kit, "e6oa_tr", "treasurer");
  const treasurer = new ApiTreasurer(treasurerUser.api.client);
  const channel = s.me.channelSlug ?? s.username;
  const vChannel = v.me.channelSlug ?? v.username;
  const channelId = (await p.api().client.channels.get({ channel })).id;
  const currency = (await s.api.client.money.support({ channel })).currency;
  ctx.data("users", { s: s.username, v: v.username, treasurer: treasurerUser.username });

  const webOrigin = new URL(ctx.env.HARNESS_WEB_URL).origin;
  const apiUrl = ctx.env.HARNESS_API_URL;
  const studio = kit.via === "web" ? await kit.webSession("S", s) : null;

  // ------------------------------------------------------------ 1. configure, create a 7-day token
  await ctx.step("1 S enables the tip alert (message, min 100 cents, 5000 ms)", async () => {
    if (studio) {
      const page = await studio.goto(E6_ROUTES.overlays);
      const card = byE6Id(page, E.alertConfig, { type: "tip" });
      await card.waitFor({ timeout: UI_TIMEOUT_MS });
      await setSwitch(byE6Id(card, E.alertEnabled), true, UI_TIMEOUT_MS);
      await byE6Id(card, E.alertMessage).fill(TIP_MESSAGE_TEMPLATE, { timeout: UI_TIMEOUT_MS });
      await fillAmount(card, E.alertMinAmount, MIN_CENTS, currency, UI_TIMEOUT_MS);
      await byE6Id(card, E.alertDuration).fill(String(DURATION_MS / 1000), { timeout: UI_TIMEOUT_MS });
      const ms = await byE6Id(card, E.alertDuration).getAttribute("data-ms");
      ctx.check("1 alert-duration reports 5000 ms", ms === String(DURATION_MS), { ms });
      await byE6Id(card, E.alertSave).click({ timeout: UI_TIMEOUT_MS });
      await byE6Id(page, E.alertConfig, { type: "tip", enabled: "true" }).waitFor({ timeout: UI_TIMEOUT_MS });
    } else {
      await s.api.client.interact.alerts.set({
        channel,
        type: "tip",
        enabled: true,
        template: { message: TIP_MESSAGE_TEMPLATE, animation: "fade", showMessage: true },
        minAmountCents: MIN_CENTS,
        durationMs: DURATION_MS,
      });
    }
  });
  const saved = await ctx.step("1 interact.alerts.list has the tip alert as saved", async () => {
    const configs = await waitFor(
      "the saved tip alert",
      async () => {
        const list = await s.api.client.interact.alerts.list({ channel });
        const tip = list.find((c) => c.type === "tip");
        return tip?.enabled && tip.minAmountCents === MIN_CENTS ? list : null;
      },
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal },
    );
    return configs.find((c) => c.type === "tip");
  });
  ctx.assert(
    "1 the tip alert is enabled with the message, 100 cents and 5000 ms",
    saved?.enabled === true &&
      saved.template.message === TIP_MESSAGE_TEMPLATE &&
      saved.minAmountCents === MIN_CENTS &&
      saved.durationMs === DURATION_MS,
    { minAmountCents: saved?.minAmountCents, durationMs: saved?.durationMs },
  );

  const createdAt7d = Date.now();
  let alertsUrl = await ctx.step("1 S creates an overlay token expiring in 7 days", () =>
    createToken(kit, studio, s, channel, "7d"),
  );
  const status7d = await ctx.step("1 the token is active and expires in 7 days", async () => {
    if (studio) {
      const page = await studio.goto(E6_ROUTES.overlays);
      const d = await dataOf(byE6Id(page, E.overlayToken, { active: "true" }), UI_TIMEOUT_MS);
      return { active: d.active === "true", expiresAt: d.expiresAt ?? "" };
    }
    const st = await s.api.client.interact.overlays.status({ channel });
    return { active: st.active, expiresAt: st.expiresAt ?? "" };
  });
  const expiryOffset = status7d.expiresAt ? Date.parse(status7d.expiresAt) - (createdAt7d + SEVEN_DAYS_MS) : NaN;
  ctx.assert("1 overlay-token data-active=true", status7d.active);
  ctx.assert("1 data-expires-at is within a minute of now + 7 days", Math.abs(expiryOffset) <= 60_000, {
    offsetMs: Number.isFinite(expiryOffset) ? expiryOffset : null,
  });

  // ------------------------------------------------------------ 2. the overlay opens without cookies
  const observers: SseStream[] = [];
  ctx.defer(() => Promise.allSettled(observers.map((o) => o.close())));
  const openObserver = async (label: string, url: string): Promise<SseStream> => {
    const state = await tokenClient(apiUrl, tokenOf(url), "query", webOrigin).interact.overlays.state();
    const stream = await SseStream.open(label, rebaseHttp(state.eventsUrl, apiUrl));
    observers.push(stream);
    return stream;
  };
  let obs = await ctx.step("2 an SSE client holds the alert stream open (like OBS)", () =>
    openObserver("overlay stream 1", alertsUrl),
  );
  ctx.assert("2 the alert stream answers 200", obs.status === 200, { status: obs.status });
  let obsPage: Page | null = null;
  if (kit.via === "web") {
    const obsSession = await kit.webSession("OBS");
    obsPage = await ctx.step("2 a cookie-less browser opens the alerts URL", async () => {
      const page = await gotoSecretUrl(
        () => obsSession.goto(rebaseHttp(alertsUrl, ctx.env.HARNESS_WEB_URL)),
        "the overlay page",
      );
      await installAlertRecorder(page);
      await waitOverlayState(page, "live", UI_TIMEOUT_MS, signal);
      return page;
    });
  }

  /** Every tip/test alert either view saw: the page's recorder (web) and the SSE observer. */
  const alertsSeen = async (stream: SseStream) => {
    const fromStream = stream.ofType<OverlayAlertFrame>("alert").map((a) => ({
      id: a.data.id,
      type: a.data.type,
      test: a.data.test,
      amountCents: a.data.amountCents,
      text: a.data.text,
      at: a.at,
    }));
    const fromPage = obsPage
      ? (await recordedAlerts(obsPage)).map((a) => ({
          id: a.id,
          type: a.type,
          test: a.test === "true",
          amountCents: a.amountCents === "" ? null : Number(a.amountCents),
          text: a.text,
          at: a.at,
        }))
      : [];
    return { fromStream, fromPage };
  };
  /** Wait until the alert shows where the run looks (the page on the web path, else the stream). */
  const waitAlert = async (
    what: string,
    match: (a: { test: boolean; type: string; amountCents: number | null; text: string }) => boolean,
    timeoutMs: number,
  ) =>
    waitFor(
      what,
      async () => {
        const seen = await alertsSeen(obs);
        const list = obsPage ? seen.fromPage : seen.fromStream;
        return list.find(match) ?? null;
      },
      { timeoutMs, intervalMs: 150, signal },
    );

  // ------------------------------------------------------------ 3. test alert
  await ctx.step("3 S fires a test alert", async () => {
    if (studio) {
      const page = await studio.goto(E6_ROUTES.overlays);
      await byE6Id(byE6Id(page, E.alertConfig, { type: "tip" }), E.alertTest).click({ timeout: UI_TIMEOUT_MS });
    } else {
      await s.api.client.interact.alerts.test({ channel, type: "tip" });
    }
  });
  await ctx.step("3 an overlay-alert with data-test=true appears", () =>
    waitAlert("a test alert", (a) => a.test, UI_TIMEOUT_MS),
  );
  await ctx.step("3 the stream carried the test alert too", () =>
    obs.waitEvent<OverlayAlertFrame>("alert", (a) => a.test, UI_TIMEOUT_MS, signal),
  );
  // One alert at a time: let the test alert finish before the tips.
  await delay(DURATION_MS + 1_000, undefined, { signal });

  // ------------------------------------------------------------ 4. tips
  const marker = `e6oa ${ctx.runId}`;
  const tip250 = await ctx.step("4 V tips S 250 cents (confirmed by the treasurer)", () =>
    confirmedTip(kit, treasurer, v, channel, { cents: 250, message: `${marker} 250` }),
  );
  const a250 = await ctx.step("4 a tip alert for 250 cents shows", () =>
    waitAlert("the 250-cent tip alert", (a) => !a.test && a.type === "tip" && a.amountCents === 250, 30_000),
  );
  const ms250 = a250.at - tip250.confirmedAt;
  ctx.metric("overlay_tip_alert_ms", ms250, "ms");
  ctx.check(`4 the tip alert shows within ${ALERT_DEADLINE_MS / 1000} s`, ms250 <= ALERT_DEADLINE_MS, { ms: ms250 });
  ctx.assert("4 the alert text names V", a250.text.includes(v.displayName));

  await delay(DURATION_MS + 1_000, undefined, { signal });
  const tip50 = await ctx.step("4 V tips S 50 cents (below the minimum; confirmed)", () =>
    confirmedTip(kit, treasurer, v, channel, { cents: 50, message: `${marker} 50` }),
  );
  await ctx.step("4 nothing shows for the 50-cent tip within 10 s", async () => {
    await delay(Math.max(0, tip50.confirmedAt + ALERT_DEADLINE_MS - Date.now()), undefined, { signal });
    const seen = await alertsSeen(obs);
    const shown = [...seen.fromStream, ...seen.fromPage].filter((a) => a.amountCents === 50);
    ctx.assert("4 no alert for the 50-cent tip", shown.length === 0, { shown: shown.length });
  });

  const tip300 = await ctx.step("4 V tips S 300 cents anonymously (confirmed)", () =>
    confirmedTip(kit, treasurer, v, channel, { cents: 300, message: `${marker} 300`, anonymous: true }),
  );
  const a300 = await ctx.step("4 the anonymous 300-cent tip alert shows", () =>
    waitAlert("the anonymous tip alert", (a) => !a.test && a.type === "tip" && a.amountCents === 300, 30_000),
  );
  ctx.check(
    `4 the anonymous alert shows within ${ALERT_DEADLINE_MS / 1000} s`,
    a300.at - tip300.confirmedAt <= ALERT_DEADLINE_MS,
    { ms: a300.at - tip300.confirmedAt },
  );
  ctx.assert(
    "4 the anonymous alert does not name V",
    !a300.text.includes(v.displayName) && !a300.text.includes(v.username),
  );
  const anonymousText = `${ANONYMOUS_LABEL} tipped `;
  ctx.assert(`4 the anonymous alert shows the "${ANONYMOUS_LABEL}" label`, a300.text.startsWith(anonymousText));
  if (obsPage) {
    // The 250-cent alert (which named V) ended seconds before this one started.
    const dom = await obsPage.content();
    ctx.assert(
      "4 V's name is nowhere in the overlay DOM while the anonymous alert shows",
      !dom.includes(v.displayName) && !dom.includes(v.username),
    );
  }
  await ctx.step("4 no frame of any stream carries V's id, email or username", async () => {
    const a = await obs.waitEvent<OverlayAlertFrame>("alert", (f) => f.amountCents === 300, 10_000, signal);
    ctx.assert(
      `4 the anonymous alert frame carries the "${ANONYMOUS_LABEL}" label`,
      a.data.text.startsWith(anonymousText),
    );
    checkFrames(ctx, observers, v, tip300.confirmedAt, "4");
  });

  // ------------------------------------------------------------ 5. scope
  await ctx.step("5 the token authenticates nothing but its own overlay", async () => {
    const token = tokenOf(alertsUrl);
    const statusBefore = await s.api.client.interact.overlays.status({ channel });
    for (const mode of ["bearer", "query"] as const) {
      const c: ApiClient = tokenClient(apiUrl, token, mode, webOrigin);
      const refused = {
        overlaysToken: isUnauthorized(await errorOf(() => c.interact.overlays.token({ channel, expiresAt: null }))),
        overlaysRevoke: isUnauthorized(await errorOf(() => c.interact.overlays.revoke({ channel }))),
        overlaysStatus: isUnauthorized(await errorOf(() => c.interact.overlays.status({ channel }))),
        alertsTest: isUnauthorized(await errorOf(() => c.interact.alerts.test({ channel, type: "tip" }))),
        alertsList: isUnauthorized(await errorOf(() => c.interact.alerts.list({ channel }))),
        simulcastList: isUnauthorized(await errorOf(() => c.stream.simulcast.list({ channel }))),
        meGet: isUnauthorized(await errorOf(() => c.me.get())),
        otherChannelAlerts: isUnauthorized(await errorOf(() => c.interact.alerts.list({ channel: vChannel }))),
      };
      ctx.assert(
        `5 (${mode}) overlays.token/revoke/status, alerts.test/list, simulcast.list and me.get are UNAUTHORIZED`,
        Object.values(refused).every(Boolean),
        refused,
      );
    }
    const statusAfter = await s.api.client.interact.overlays.status({ channel });
    ctx.assert(
      "5 overlays.status is unchanged by the token-bearing attempts",
      JSON.stringify(statusAfter) === JSON.stringify(statusBefore),
      { activeBefore: statusBefore.active, activeAfter: statusAfter.active },
    );
    const q = tokenClient(apiUrl, token, "query", webOrigin);
    const st = await q.interact.overlays.state();
    ctx.assert("5 interact.overlays.state answers S's channel", st.channelSlug === channel);
    // The procedure takes no input: a channel smuggled into it must change nothing.
    const smuggled = await (q.interact.overlays.state as unknown as (i: unknown) => Promise<{ channelSlug: string }>)({
      channel: vChannel,
    }).catch((err: unknown) => ({ channelSlug: `refused:${apiError(err).code ?? "error"}` }));
    ctx.assert("5 a token-holding request cannot name another channel", smuggled.channelSlug !== vChannel, {
      answered:
        smuggled.channelSlug === channel
          ? "own channel"
          : smuggled.channelSlug.startsWith("refused")
            ? smuggled.channelSlug
            : "other",
    });
  });

  // ------------------------------------------------------------ 6. rotate and revoke
  const oldUrl = alertsUrl;
  const rotatedAt = Date.now();
  alertsUrl = await ctx.step("6 S rotates the token (no expiry)", () => createToken(kit, studio, s, channel, "none"));
  ctx.assert("6 the rotated URL carries a new token", tokenOf(alertsUrl) !== tokenOf(oldUrl));
  await ctx.step("6 the open old overlay is refused within 30 s", async () => {
    if (obsPage) await waitOverlayState(obsPage, "refused", REFUSE_DEADLINE_MS + 5_000, signal);
    await obs.waitClosed(REFUSE_DEADLINE_MS + 5_000, signal);
  });
  const toRefused = Date.now() - rotatedAt;
  ctx.metric("overlay_rotate_refused_ms", toRefused, "ms");
  ctx.check("6 refused within 30 s of the rotation", toRefused <= REFUSE_DEADLINE_MS + 1_000, { ms: toRefused });
  ctx.check(
    "6 the old stream ended with a revoked event",
    obs.events.some((e) => e.event === "revoked"),
  );
  const oldState = await errorOf(() =>
    tokenClient(apiUrl, tokenOf(oldUrl), "query", webOrigin).interact.overlays.state(),
  );
  ctx.assert("6 the old token's state call is 401", isUnauthorized(oldState), { code: apiError(oldState).code });
  await expectStreamRefused(
    ctx,
    "6 a new stream with the rotated-away token is refused",
    apiUrl,
    tokenOf(oldUrl),
    signal,
  );
  obs = await ctx.step("6 the new URL works", () => openObserver("overlay stream 2", alertsUrl));
  ctx.assert("6 the new alert stream answers 200", obs.status === 200, { status: obs.status });
  if (kit.via === "web") {
    const obs2 = await kit.webSession("OBS2");
    obsPage = await ctx.step("6 the new alerts URL is live in the browser", async () => {
      const page = await gotoSecretUrl(
        () => obs2.goto(rebaseHttp(alertsUrl, ctx.env.HARNESS_WEB_URL)),
        "the rotated overlay page",
      );
      await waitOverlayState(page, "live", UI_TIMEOUT_MS, signal);
      return page;
    });
  }
  const revokedAt = Date.now();
  await ctx.step("6 S revokes the token", async () => {
    if (studio) {
      const page = await studio.goto(E6_ROUTES.overlays);
      await byE6Id(page, E.overlayTokenRevoke).click({ timeout: UI_TIMEOUT_MS });
      await confirmDialog(page, UI_TIMEOUT_MS);
      await byE6Id(page, E.overlayToken, { active: "false" }).waitFor({ timeout: UI_TIMEOUT_MS });
    } else {
      await s.api.client.interact.overlays.revoke({ channel });
    }
  });
  await ctx.step("6 the new overlay is refused within 30 s", async () => {
    if (obsPage) await waitOverlayState(obsPage, "refused", REFUSE_DEADLINE_MS + 5_000, signal);
    await obs.waitClosed(REFUSE_DEADLINE_MS + 5_000, signal);
  });
  ctx.check("6 refused within 30 s of the revocation", Date.now() - revokedAt <= REFUSE_DEADLINE_MS + 1_000, {
    ms: Date.now() - revokedAt,
  });
  const st = await s.api.client.interact.overlays.status({ channel });
  ctx.assert("6 overlays.status is inactive after revoke", !st.active);
  await expectStreamRefused(
    ctx,
    "6 a new stream with the revoked token is refused",
    apiUrl,
    tokenOf(alertsUrl),
    signal,
  );

  // ------------------------------------------------------------ 7. expiry (API)
  const past = await errorOf(() =>
    s.api.client.interact.overlays.token({ channel, expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  );
  ctx.assert("7 an expiresAt in the past is BAD_REQUEST", apiError(past).code === "BAD_REQUEST", {
    code: apiError(past).code,
  });
  const expiresAt = Date.now() + SHORT_TOKEN_MS;
  const short = await ctx.step("7 S creates a token expiring in 5 s (API)", () =>
    s.api.client.interact.overlays.token({ channel, expiresAt: new Date(expiresAt).toISOString() }),
  );
  const shortClient = tokenClient(apiUrl, short.token, "query", webOrigin);
  await ctx.step("7 the 5 s token answers state before expiry", () => shortClient.interact.overlays.state());
  const shortStream = await ctx.step("7 open its alert stream", () =>
    openObserver("overlay stream 3", short.alertsUrl),
  );
  ctx.assert("7 the short token's stream answers 200", shortStream.status === 200, { status: shortStream.status });
  await delay(Math.max(0, expiresAt + 1_000 - Date.now()), undefined, { signal });
  const expired = await errorOf(() => shortClient.interact.overlays.state());
  ctx.assert("7 after expiry the state call is 401", isUnauthorized(expired), { code: apiError(expired).code });
  await expectStreamRefused(ctx, "7 a new stream with the expired token is refused", apiUrl, short.token, signal);
  const closedAt = await ctx.step("7 the open stream closes within 30 s of expiry", () =>
    shortStream.waitClosed(REFUSE_DEADLINE_MS + 5_000, signal),
  );
  ctx.metric("overlay_expiry_close_ms", closedAt - expiresAt, "ms");
  ctx.check("7 closed within 30 s of expiry", closedAt - expiresAt <= REFUSE_DEADLINE_MS, {
    ms: closedAt - expiresAt,
  });

  // ------------------------------------------------------------ 8. audit
  // Streams 2 and 3 opened after step 4: a replay or raw event on a new connection shows here.
  checkFrames(ctx, observers, v, tip300.confirmedAt, "7");
  const audit = await ctx.step("8 audit rows (DB)", () => auditActionCounts(kit.databaseUrl, { channelId }));
  ctx.data("audit", audit);
  ctx.assert("8 alert.update is audited", (audit["alert.update"] ?? 0) >= 1, audit);
  ctx.assert("8 overlay.token.create ×3 is audited", (audit["overlay.token.create"] ?? 0) >= 3, audit);
  ctx.assert("8 overlay.token.revoke is audited", (audit["overlay.token.revoke"] ?? 0) >= 1, audit);
}

/**
 * Every frame of every overlay stream the run held open, whatever its event type: none carries
 * V's id, email or username, none received after the anonymous tip's confirmation carries V's
 * display name, and the stream sends only `alert`, `ping` and `revoked` events.
 */
function checkFrames(
  ctx: ScenarioContext,
  streams: readonly SseStream[],
  v: SignedInUser,
  anonymousFrom: number,
  step: string,
): void {
  const frames = streams.flatMap((st) => st.events);
  const email = v.email.toLowerCase();
  const leaks = {
    id: frames.some((f) => f.data.includes(v.id)),
    email: frames.some((f) => f.data.toLowerCase().includes(email)),
    username: frames.some((f) => f.data.includes(v.username)),
    anonymousName: frames.some((f) => f.at >= anonymousFrom && f.data.includes(v.displayName)),
  };
  ctx.data(`overlayFrames${step}`, { streams: streams.length, frames: frames.length });
  ctx.assert(
    `${step} no frame of ${streams.length} stream(s) (any event type) carries V's id, email or username, nor V's name after the anonymous tip`,
    !Object.values(leaks).some(Boolean),
    leaks,
  );
  const unexpected = [...new Set(frames.map((f) => f.event).filter((e) => !STREAM_EVENT_TYPES.has(e)))];
  ctx.check(`${step} the streams send only alert, ping and revoked events`, unexpected.length === 0, { unexpected });
}

/** A new overlay stream with `token` is refused: not 200, or closed at once with no alert or ping. */
async function expectStreamRefused(
  ctx: ScenarioContext,
  what: string,
  apiUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const stream = await SseStream.open(what, overlayEventsUrl(apiUrl, token));
  try {
    const refused = await refusedStream(stream, 3_000, signal);
    ctx.assert(what, refused, { status: stream.status, closed: stream.closedAt !== null });
  } finally {
    await stream.close();
  }
}

/**
 * Create (or rotate) the overlay token: on `/overlays` with the expiry choice (`7d`, `none`), or
 * through the API. Returns the alerts URL (shown once; read from `overlay-url`'s `data-url`, else
 * revealed from its input).
 */
async function createToken(
  kit: Kit,
  studio: WebSession | null,
  s: SignedInUser,
  channel: string,
  choice: "7d" | "none",
): Promise<string> {
  if (!studio) {
    const expiresAt = choice === "none" ? null : new Date(Date.now() + SEVEN_DAYS_MS).toISOString();
    return (await s.api.client.interact.overlays.token({ channel, expiresAt })).alertsUrl;
  }
  const page = await studio.goto(E6_ROUTES.overlays);
  const panel = byE6Id(page, E.overlayToken);
  await panel.waitFor({ timeout: UI_TIMEOUT_MS });
  await chooseOption(page, page, E.overlayExpiry, choice, UI_TIMEOUT_MS);
  await byE6Id(page, E.overlayTokenCreate).click({ timeout: UI_TIMEOUT_MS });
  // Rotating asks for confirmation; a first token does not.
  const confirm = page.locator(etid(CONFIRM_DIALOG_CONFIRM)).first();
  const url = byE6Id(page, E.overlayUrl).first();
  const first = await waitFor(
    "overlay-url or the rotate confirmation",
    async () => ((await url.isVisible()) ? "url" : (await confirm.isVisible()) ? "confirm" : null),
    { timeoutMs: UI_TIMEOUT_MS, intervalMs: 150, signal: kit.ctx.signal },
  );
  if (first === "confirm") await confirmDialog(page, UI_TIMEOUT_MS);
  await url.waitFor({ timeout: UI_TIMEOUT_MS });
  const fromData = await url.getAttribute("data-url");
  if (fromData) return fromData;
  const reveal = page.locator(etid("overlay-url-reveal")).first();
  if (await reveal.count()) await reveal.click({ timeout: UI_TIMEOUT_MS });
  const value = await byE6Id(url, E.overlayUrlValue).inputValue({ timeout: UI_TIMEOUT_MS });
  if (!URL.canParse(value)) throw new Error("overlay-url does not hold a URL");
  return value;
}
