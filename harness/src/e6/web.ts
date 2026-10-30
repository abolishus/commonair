// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Web helpers for the E6 pages, by test id only (docs/testing/e6-selectors.md): `packages/ui`
 * selects (`<field>-option-<value>`), switches, amount fields, `<ConfirmDialog>`, `data-*` reads,
 * and a recorder for every alert the OBS overlay page shows.
 */
import type { Locator, Page } from "playwright";
import { centsToInput } from "../money.ts";
import { sleep, waitFor } from "../wait.ts";
import { CONFIRM_DIALOG_CONFIRM, E6_TEST_IDS as E, byE6Id, etid, optionId } from "./selectors.ts";

export type Dataset = Record<string, string | undefined>;

/** `data-*` of the first element the locator matches (dataset keys are camelCase). */
export async function dataOf(locator: Locator, timeoutMs: number): Promise<Dataset> {
  await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
  return locator.first().evaluate((e) => Object.fromEntries(Object.entries((e as HTMLElement).dataset)));
}

/** `data-*` of every element the locator matches. */
export async function dataOfAll(locator: Locator): Promise<Dataset[]> {
  return locator.evaluateAll((els) => els.map((e) => Object.fromEntries(Object.entries((e as HTMLElement).dataset))));
}

/**
 * Pick `value` in the select with test id `fieldId` inside `scope`. A native `<select>` is set
 * directly; a `packages/ui` select (the test id on its field wrapper or trigger) is opened and its
 * option `<fieldId>-option-<value>` (rendered in a portal) clicked.
 */
export async function chooseOption(
  page: Page,
  scope: Page | Locator,
  fieldId: string,
  value: string,
  timeoutMs: number,
): Promise<void> {
  const field = byE6Id(scope, fieldId).first();
  await field.waitFor({ timeout: timeoutMs });
  const tag = await field.evaluate((e) => e.tagName.toLowerCase());
  if (tag === "select") {
    await field.selectOption(value, { timeout: timeoutMs });
    return;
  }
  const role = await field.getAttribute("role");
  const trigger = tag === "button" || role === "combobox" ? field : field.locator('[role="combobox"], button').first();
  await trigger.click({ timeout: timeoutMs });
  await page
    .locator(etid(optionId(fieldId, value)))
    .first()
    .click({ timeout: timeoutMs });
  await waitFor(
    `${fieldId} shows ${value}`,
    async () => {
      const v = await field.getAttribute("data-value");
      // Wrappers without `data-value` cannot be read back: the click is the check.
      return v === null || v === value;
    },
    { timeoutMs, intervalMs: 100 },
  );
}

/** Whether a switch / checkbox is on (`aria-checked`, `data-checked` or `checked`). */
export async function isOn(locator: Locator): Promise<boolean> {
  return locator.first().evaluate((e) => {
    const aria = e.getAttribute("aria-checked");
    if (aria !== null) return aria === "true";
    if (e.hasAttribute("data-checked")) return true;
    if (e.hasAttribute("data-unchecked")) return false;
    return e instanceof HTMLInputElement ? e.checked : false;
  });
}

/** Turn a switch on or off like a person: click only when it is not already there. */
export async function setSwitch(locator: Locator, on: boolean, timeoutMs: number): Promise<void> {
  await locator.first().waitFor({ timeout: timeoutMs });
  if ((await isOn(locator)) !== on) await locator.first().click({ timeout: timeoutMs });
  await waitFor(`switch ${on ? "on" : "off"}`, async () => (await isOn(locator)) === on, {
    timeoutMs,
    intervalMs: 100,
  });
}

/** Type an amount in cents into a `packages/ui` amount field (test id on the field or its input). */
export async function fillAmount(
  scope: Page | Locator,
  fieldId: string,
  cents: number,
  currency: string,
  timeoutMs: number,
): Promise<void> {
  const field = byE6Id(scope, fieldId).first();
  await field.waitFor({ timeout: timeoutMs });
  const isInput = await field.evaluate((e) => e instanceof HTMLInputElement);
  const input = isInput ? field : field.locator("input").first();
  await input.fill(centsToInput(cents, currency), { timeout: timeoutMs });
  await input.blur({ timeout: timeoutMs }).catch(() => undefined);
}

/** Click the open `<ConfirmDialog>`'s confirm button and wait for the dialog to go away. */
export async function confirmDialog(page: Page, timeoutMs: number): Promise<void> {
  const confirm = page.locator(etid(CONFIRM_DIALOG_CONFIRM)).first();
  await confirm.click({ timeout: timeoutMs });
  await confirm.waitFor({ state: "detached", timeout: timeoutMs }).catch(() => undefined);
}

/** Reload `page` until `probe` returns a value (pages that do not poll on their own). */
export async function reloadUntil<T>(
  page: Page,
  what: string,
  probe: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<T> {
  let first = true;
  return waitFor(
    what,
    async () => {
      if (!first) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForSelector("html[data-hydrated]", { state: "attached", timeout: 15_000 }).catch(() => null);
      }
      first = false;
      return probe();
    },
    { timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs ?? 2_000, signal: opts.signal },
  );
}

// ---------------------------------------------------------------- overlay alert recorder

export interface SeenAlert {
  id: string;
  type: string;
  test: string;
  amountCents: string;
  text: string;
  message: string | null;
  /** When the recorder first saw it (page clock, ms epoch). */
  at: number;
}

declare global {
  interface Window {
    __e6Alerts?: Record<string, SeenAlert>;
  }
}

/**
 * Record every `overlay-alert` the page ever shows (alerts are queued and removed after their
 * duration, so a poll could miss one). Idempotent; survives nothing across reloads.
 */
export async function installAlertRecorder(page: Page): Promise<void> {
  await page.evaluate(
    ([alertSel, textSel, messageSel]) => {
      if (window.__e6Alerts) return;
      const seen: Record<string, SeenAlert> = {};
      window.__e6Alerts = seen;
      const scan = () => {
        for (const el of document.querySelectorAll<HTMLElement>(alertSel)) {
          const id = el.dataset.alertId ?? "";
          if (!id || seen[id]) continue;
          seen[id] = {
            id,
            type: el.dataset.type ?? "",
            test: el.dataset.test ?? "",
            amountCents: el.dataset.amountCents ?? "",
            text: el.querySelector(textSel)?.textContent ?? "",
            message: el.querySelector(messageSel)?.textContent ?? null,
            at: Date.now(),
          };
        }
      };
      scan();
      new MutationObserver(scan).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    },
    [etid(E.overlayAlert), etid(E.overlayAlertText), etid(E.overlayAlertMessage)] as const,
  );
}

export async function recordedAlerts(page: Page): Promise<SeenAlert[]> {
  return page.evaluate(() => Object.values(window.__e6Alerts ?? {}));
}

/** The overlay root's `data-state` (`connecting` / `live` / `refused`), or null before it renders. */
export async function overlayState(page: Page): Promise<string | null> {
  const root = page.locator(etid(E.overlayAlerts)).first();
  if ((await root.count()) === 0) return null;
  return root.getAttribute("data-state");
}

export async function waitOverlayState(page: Page, state: string, timeoutMs: number, signal?: AbortSignal) {
  const started = Date.now();
  await waitFor(`overlay data-state="${state}"`, async () => (await overlayState(page)) === state, {
    timeoutMs,
    intervalMs: 200,
    signal,
  });
  return Date.now() - started;
}

/**
 * Every `/rpc` response body a page receives (the browser's create/update/list answers), kept in
 * memory for "the key is in no response" scans; never written to the report.
 */
export class RpcResponses {
  readonly bodies: string[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly pages = new WeakSet<Page>();

  attach(page: Page): Page {
    if (this.pages.has(page)) return page;
    this.pages.add(page);
    page.on("response", (res) => {
      if (isRpcUrl(res.url())) this.track(res.text());
    });
    return page;
  }

  /** Keep a body being read; exposed for tests, which have no browser. */
  track(body: Promise<string>): void {
    const p: Promise<void> = body.then(
      (t) => void this.bodies.push(t),
      () => undefined,
    );
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /**
   * Wait up to `timeoutMs` for bodies still being read. A Playwright `response.text()` can stay
   * pending for good (the page navigated or closed mid-read); waiting without a deadline hung
   * simulcast until its 10-minute scenario timeout on CI. `unfinished` counts the ones given up on.
   */
  async settle(timeoutMs = 15_000, signal?: AbortSignal): Promise<{ bodies: string[]; unfinished: number }> {
    await Promise.race([Promise.allSettled(this.pending), sleep(timeoutMs, signal)]);
    return { bodies: this.bodies, unfinished: this.pending.size };
  }
}

/** True for the API's oRPC endpoint (`…/rpc/…`). */
export function isRpcUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  return /(^|\/)rpc(\/|$)/.test(new URL(url).pathname);
}

/**
 * Navigate to a URL that carries a credential (an overlay token). Playwright's navigation errors
 * quote the URL, and step errors go into the report: rethrow with the error's name only.
 */
export async function gotoSecretUrl(goto: () => Promise<Page>, what: string): Promise<Page> {
  try {
    return await goto();
  } catch (err) {
    throw new Error(`${what} did not load (${err instanceof Error ? err.name : "error"})`);
  }
}
