// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d7-security (overhaul wave 4, D7.2): two-step sign-in end to end in the browser. A new member
 * signs in, turns two-step sign-in on at `/settings/security` (password → QR code and key → a TOTP
 * code computed here from the key the page shows → 10 backup codes → "I saved these"), signs out,
 * signs in again with the password and then a code, and turns it off with the password. The API
 * agrees at each end (`me.twoFactorEnabled`). The report carries no secret, code or address.
 */
import { join } from "node:path";
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import { D7_SECURITY_ROUTES, D7_SECURITY_IDS as S, ROUTES, TEST_IDS as T, tid } from "../src/web/selectors.ts";
import { d7Locator, msToNextPeriod, totp } from "../src/d7/security.ts";
import { playerBundles } from "../src/player-server.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { defineScenario } from "../src/scenario.ts";
import { signInViaUi } from "../src/web/flows.ts";
import { WebSession, byTestId, readValue, waitForHydration } from "../src/web/session.ts";

const UI_TIMEOUT_MS = 30_000;

export default defineScenario({
  name: "two-factor",
  description:
    "member turns two-step sign-in on at /settings/security (QR + key, TOTP code, backup codes), signs out, signs in with password + code, turns it off",
  needs: ["api", "web", "mail", "browser"],
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const p = ctx.platform;
    const webUrl = ctx.env.HARNESS_WEB_URL;
    const ui = { timeout: UI_TIMEOUT_MS };
    const user = await ctx.step("sign up", () => p.signUp({ prefix: "tfa" }));
    const { probe } = await playerBundles();
    const session = await WebSession.open({
      fleet: p.fleet,
      engine: "chromium",
      webUrl,
      probeScript: probe,
      label: "two-factor",
      log: ctx.log,
    });
    let finished = false;
    ctx.defer(async () => {
      if (!finished) {
        // The key field is masked in a screenshot only until revealed: redact it either way.
        const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-two-factor`);
        const files = await session.screenshotAll(dir, [
          `[data-testid="${S.securityKey}"]`,
          `[data-testid="${S.securityBackupCodes}"]`,
        ]);
        if (files.length > 0) ctx.data("screenshots", files);
      }
      await session.close();
    });
    const page = await session.page();
    const open = async (path: string) => {
      await page.goto(new URL(path, webUrl).toString(), { waitUntil: "domcontentloaded" });
      await waitForHydration(page);
    };

    await ctx.step("sign in with the password", async () => {
      await open(ROUTES.signin);
      await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal, ctx.log);
    });

    const secret = await ctx.step("set up: password, QR code and key", async () => {
      await open(D7_SECURITY_ROUTES.security);
      await d7Locator(page, S.securityRow, { state: "off" }).waitFor(ui);
      await d7Locator(page, S.securitySetup).click(ui);
      await d7Locator(page, S.securityPassword).fill(user.password, ui);
      await d7Locator(page, S.securityContinue).click(ui);
      await d7Locator(page, S.securityQr).waitFor(ui);
      await d7Locator(page, S.securityKeyReveal).click(ui);
      const key = (await readValue(d7Locator(page, S.securityKey), UI_TIMEOUT_MS)).replace(/\s+/g, "");
      ctx.assert("the key is base32", /^[A-Z2-7]{16,}$/.test(key), { length: key.length });
      await d7Locator(page, S.securityNext).click(ui);
      return key;
    });

    await ctx.step("set up: code, then backup codes", async () => {
      await d7Locator(page, S.securityCode).fill(totp(secret), ui);
      await d7Locator(page, S.securityVerify).click(ui);
      await d7Locator(page, S.securityBackupCodes).waitFor(ui);
      const codes = await d7Locator(page, S.securityBackupCodes).locator("li").count();
      ctx.check("ten backup codes", codes === 10, { codes });
      await d7Locator(page, S.securitySaved).click(ui);
      await d7Locator(page, S.securityRow, { state: "on" }).waitFor(ui);
    });
    const on = await ctx.step("API: two-step sign-in is on", () => user.api.client.me.get());
    ctx.assert("me.twoFactorEnabled after set-up", on.twoFactorEnabled === true);

    await ctx.step("sign out", async () => {
      await page.evaluate(async (path) => {
        await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      }, AUTH_ROUTES.signOut);
      await open(ROUTES.signin);
      await byTestId(page, T.signinEmail).waitFor(ui);
    });

    await ctx.step("sign in: password, then a code", async () => {
      await byTestId(page, T.signinEmail).fill(user.email, ui);
      await byTestId(page, T.signinPassword).fill(user.password, ui);
      await byTestId(page, T.signinSubmit).click(ui);
      await d7Locator(page, S.signinCodeStep, { mode: "totp" }).waitFor(ui);
      ctx.check("not signed in before the code", !(await page.locator(tid(T.navUser)).first().isVisible()));
      // A code from the set-up's period still verifies (one period of drift either way), but a
      // fresh one keeps the step independent of how long set-up took.
      if (msToNextPeriod() < 3_000) await page.waitForTimeout(msToNextPeriod() + 250);
      await d7Locator(page, S.signinCode).fill(totp(secret), ui);
      await d7Locator(page, S.signinCodeSubmit).click(ui);
      await byTestId(page, T.navUser).first().waitFor(ui);
      await page.waitForURL((u) => u.pathname !== ROUTES.signin, ui);
    });

    await ctx.step("turn it off with the password", async () => {
      await open(D7_SECURITY_ROUTES.security);
      await d7Locator(page, S.securityRow, { state: "on" }).waitFor(ui);
      await d7Locator(page, S.securityOff).click(ui);
      await d7Locator(page, S.securityConfirmPassword).fill(user.password, ui);
      await byTestId(page, T.confirmDialogConfirm).click(ui);
      await d7Locator(page, S.securityRow, { state: "off" }).waitFor(ui);
    });
    const off = await ctx.step("API: two-step sign-in is off", () => user.api.client.me.get());
    ctx.assert("me.twoFactorEnabled after turning off", off.twoFactorEnabled === false);
    finished = true;
  },
});
