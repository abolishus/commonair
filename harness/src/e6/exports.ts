// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data-export flows shared by `data-export` and `account-deletion`: request an export on
 * `/settings/privacy` (or `me.exports.create`), wait for it to be ready, find its link in the
 * `dataExportReady` email and download it. Links are presigned credentials: they are returned to
 * the scenario, never logged or reported.
 */
import type { ApiClient } from "../api/client.ts";
import { extractLinks } from "../mailpit.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import type { WebSession } from "../web/session.ts";
import { type Kit, UI_TIMEOUT_MS } from "./kit.ts";
import { E6_ROUTES, E6_TEST_IDS as E, byE6Id } from "./selectors.ts";
import { exportLinkIn, storageLinks } from "./signed-url.ts";
import { dataOfAll, reloadUntil } from "./web.ts";

export type ExportKind = "account" | "channel";
export type ExportJob = Awaited<ReturnType<ApiClient["me"]["exports"]["list"]>>[number];

export const EXPORT_READY_TIMEOUT_MS = 3 * 60_000;

/** Request an export of `kind`; returns its id. */
export async function requestExport(
  kit: Kit,
  session: WebSession | null,
  user: SignedInUser,
  kind: ExportKind,
): Promise<string> {
  if (!session) return (await user.api.client.me.exports.create({ kind })).id;
  const page = await session.goto(E6_ROUTES.privacy);
  const button = byE6Id(page, E.exportRequest, { kind });
  await button.waitFor({ timeout: UI_TIMEOUT_MS });
  const before = new Set((await dataOfAll(byE6Id(page, E.exportRow, { kind }))).map((d) => d.exportId));
  await button.click({ timeout: UI_TIMEOUT_MS });
  return waitFor(
    `a new ${kind} export-row`,
    async () => {
      const rows = await dataOfAll(byE6Id(page, E.exportRow, { kind }));
      return rows.map((d) => d.exportId).find((id): id is string => !!id && !before.has(id)) ?? null;
    },
    { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal: kit.ctx.signal },
  );
}

/** Wait until the export is `ready` (the row's `data-status` on the web path) and return it. */
export async function waitExportReady(
  kit: Kit,
  session: WebSession | null,
  user: SignedInUser,
  exportId: string,
): Promise<ExportJob> {
  if (session) {
    const page = await session.goto(E6_ROUTES.privacy);
    await reloadUntil(
      page,
      `export-row ${exportId} ready`,
      async () => {
        const row = byE6Id(page, E.exportRow, { "export-id": exportId });
        const status = (await row.count()) > 0 ? await row.first().getAttribute("data-status") : null;
        if (status === "failed") throw new Error("the export failed");
        return status === "ready" ? true : null;
      },
      { timeoutMs: EXPORT_READY_TIMEOUT_MS, intervalMs: 3_000, signal: kit.ctx.signal },
    );
  }
  return waitFor(
    `export ${exportId} ready`,
    async () => {
      const job = (await user.api.client.me.exports.list()).find((e) => e.id === exportId);
      if (job?.status === "failed") throw new Error("the export failed");
      return job?.status === "ready" ? job : null;
    },
    { timeoutMs: session ? UI_TIMEOUT_MS : EXPORT_READY_TIMEOUT_MS, intervalMs: 2_000, signal: kit.ctx.signal },
  );
}

/** What the export's `dataExportReady` email links to. */
export interface ExportMail {
  /** The presigned link for this export's own key. */
  link: string;
  /** Every presigned or storage-host link in the email (the export's own included). */
  storageLinks: string[];
}

/** The export's email: its presigned link and every other storage link it carries. */
export async function exportMail(kit: Kit, user: SignedInUser, exportId: string): Promise<ExportMail> {
  const message = await kit.ctx.platform.mailpit.waitForMessage(
    user.email,
    (m) => exportLinkIn(extractLinks(m), user.id, exportId) !== null,
    60_000,
  );
  const links = extractLinks(message);
  const link = exportLinkIn(links, user.id, exportId);
  if (!link) throw new Error("the export email has no link for this export");
  return { link, storageLinks: storageLinks(links, new URL(link).origin) };
}

/** The export's presigned link from the user's `dataExportReady` email. */
export async function exportMailLink(kit: Kit, user: SignedInUser, exportId: string): Promise<string> {
  return (await exportMail(kit, user, exportId)).link;
}

/**
 * GET a URL without credentials; the body only when 200. The URL is a presigned credential, so a
 * network error is rethrown without it (fetch errors can carry the URL).
 */
export async function download(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; bytes: Uint8Array | null }> {
  const timeout = AbortSignal.timeout(60_000);
  try {
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "manual" });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, bytes: null };
    }
    return { status: 200, bytes: new Uint8Array(await res.arrayBuffer()) };
  } catch (err) {
    throw new Error(`download failed (${err instanceof Error ? err.name : "error"})`);
  }
}
