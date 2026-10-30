// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Small web flows several scenarios share (sign up, sign in, wait for one of several elements). */
import type { Page } from "playwright";
import { type Mailpit, findTokenLink } from "../mailpit.ts";
import type { UserCredentials } from "../users.ts";
import { sleep, waitFor } from "../wait.ts";
import { ROUTES, TEST_IDS as T, type TestId, tid } from "./selectors.ts";
import { type WebSession, byTestId, readValue } from "./session.ts";
import { browserVerificationUrl } from "./urls.ts";

/** Wait until one of the test ids is visible; returns which. A form error fails immediately. */
export async function waitForOneOf<Id extends TestId>(
  page: Page,
  ids: readonly Id[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Id> {
  const formError = byTestId(page, T.formError).first();
  const seen = await waitFor(
    `one of ${ids.join(", ")}`,
    async () => {
      for (const id of ids) {
        if (await byTestId(page, id).first().isVisible()) return { id };
      }
      return (await formError.isVisible()) ? { id: null } : null;
    },
    { timeoutMs, intervalMs: 200, signal },
  );
  if (seen.id === null) throw new Error(`form error: ${await readValue(formError, 1_000)}`);
  return seen.id;
}

/** The `error.rateLimited` form error (core.json, en): the `auth` bucket is full for this address. */
const RATE_LIMITED_FORM_ERROR = /too many attempts/i;
/** The `auth` bucket's window (services/api/src/lib/ratelimit.ts) plus a margin. */
const AUTH_WINDOW_WAIT_MS = 65_000;
const RATE_LIMITED_RETRY_MS = 5_000;

/**
 * Fill and submit the sign-in form on the current page; resolves once `nav-user` shows. Scenarios
 * in one shard share an address and so the `auth` bucket (10 a minute): a rate-limited submit is
 * retried every few seconds until the window frees a slot.
 */
export async function signInViaUi(
  page: Page,
  creds: { email: string; password: string },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const ui = { timeout: timeoutMs };
  await byTestId(page, T.signinEmail).fill(creds.email, ui);
  await byTestId(page, T.signinPassword).fill(creds.password, ui);
  const deadline = Date.now() + AUTH_WINDOW_WAIT_MS;
  for (;;) {
    await byTestId(page, T.signinSubmit).click(ui);
    try {
      await waitForOneOf(page, [T.navUser], timeoutMs, signal);
      return;
    } catch (err) {
      const limited = err instanceof Error && RATE_LIMITED_FORM_ERROR.test(err.message);
      if (!limited || Date.now() + RATE_LIMITED_RETRY_MS > deadline) throw err;
      await sleep(RATE_LIMITED_RETRY_MS, signal);
      // A stale error can outlive a submit that went through: signed in is signed in.
      if (await byTestId(page, T.navUser).first().isVisible()) return;
    }
  }
}

/**
 * Wait for the ALTCHA wrapper to report `verified`. Widgets configured to solve on load need
 * nothing; otherwise click the widget's checkbox once, like a person would.
 */
export async function waitForAltcha(page: Page, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const verified = byTestId(page, T.signupAltcha, { state: "verified" });
  const started = Date.now();
  const deadline = started + timeoutMs;
  let clicked = false;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    if (await verified.count()) return;
    if (await byTestId(page, T.formError).count())
      throw new Error(`sign-up form error: ${await readValue(byTestId(page, T.formError), 1_000)}`);
    if (!clicked && Date.now() - started > 3_000) {
      const box = page.locator(`${tid(T.signupAltcha)} input[type="checkbox"]`);
      if (await box.count())
        await box
          .first()
          .click({ timeout: 5_000 })
          .catch(() => undefined);
      clicked = true;
    }
    await page.waitForTimeout(250);
  }
  const state = await byTestId(page, T.signupAltcha)
    .getAttribute("data-state", { timeout: 1_000 })
    .catch(() => null);
  throw new Error(`ALTCHA not verified within ${timeoutMs} ms (data-state=${state})`);
}

export interface WebSignUpOptions {
  session: WebSession;
  creds: UserCredentials;
  mailpit: Mailpit;
  webUrl: string;
  /** Per UI wait. */
  timeoutMs: number;
  altchaTimeoutMs?: number;
  signal: AbortSignal;
  /** Wraps each part in a recorded step (`ctx.step`). */
  step?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Sign up through the web form (ALTCHA, legal checkbox), follow the verification email and end up
 * signed in (`nav-user` shows), signing in through the form when the link lands on `/signin`.
 */
export async function signUpViaUi(o: WebSignUpOptions): Promise<Page> {
  const step = o.step ?? (<T>(_name: string, fn: () => Promise<T>) => fn());
  const ui = { timeout: o.timeoutMs };
  const who = o.session.label;
  const page = await step(`${who}: fill the sign-up form`, async () => {
    const p = await o.session.goto(ROUTES.signup);
    await byTestId(p, T.signupEmail).fill(o.creds.email, ui);
    await byTestId(p, T.signupUsername).fill(o.creds.username, ui);
    await byTestId(p, T.signupPassword).fill(o.creds.password, ui);
    await byTestId(p, T.signupBirthdate).fill(o.creds.birthDate, ui);
    await byTestId(p, T.signupLegal).check(ui);
    return p;
  });
  await step(`${who}: ALTCHA verified`, () => waitForAltcha(page, o.altchaTimeoutMs ?? 60_000, o.signal));
  await step(`${who}: submit sign-up`, async () => {
    await byTestId(page, T.signupSubmit).click(ui);
    await waitForOneOf(page, [T.signupCheckEmail], o.timeoutMs, o.signal);
  });
  const link = await step(`${who}: verification email`, async () => {
    const message = await o.mailpit.waitForMessage(o.creds.email, (m) => findTokenLink(m) !== null, 30_000);
    const found = findTokenLink(message);
    if (!found) throw new Error("verification email has no link");
    return browserVerificationUrl(found, o.webUrl);
  });
  return step(`${who}: follow the link and end up signed in`, async () => {
    const p = await o.session.goto(link);
    const landed = await waitFor(
      "verification link to land signed in or on /signin",
      async () => {
        if (await byTestId(p, T.navUser).count()) return "signed-in";
        const path = new URL(p.url()).pathname;
        return path === ROUTES.signin && (await byTestId(p, T.signinEmail).count()) ? "signin" : null;
      },
      { timeoutMs: o.timeoutMs, intervalMs: 250, signal: o.signal },
    );
    if (landed === "signin") await signInViaUi(p, o.creds, o.timeoutMs, o.signal);
    await byTestId(p, T.navUser, { username: o.creds.username }).waitFor(ui);
    return p;
  });
}
