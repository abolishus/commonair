// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Small web flows several scenarios share (sign in, wait for one of several elements). */
import type { Page } from "playwright";
import { waitFor } from "../wait.ts";
import { TEST_IDS as T, type TestId } from "./selectors.ts";
import { byTestId, readValue } from "./session.ts";

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

/** Fill and submit the sign-in form on the current page; resolves once `nav-user` shows. */
export async function signInViaUi(
  page: Page,
  creds: { email: string; password: string },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const ui = { timeout: timeoutMs };
  await byTestId(page, T.signinEmail).fill(creds.email, ui);
  await byTestId(page, T.signinPassword).fill(creds.password, ui);
  await byTestId(page, T.signinSubmit).click(ui);
  await waitForOneOf(page, [T.navUser], timeoutMs, signal);
}
