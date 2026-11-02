// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portability imports (ADR 0031, 0037) through the product: streamer3 imports from the in-harness
 * Twitch mock (`harness/src/mocks/twitch/`, never the real Twitch), the way `harness/src/n3/index.ts`
 * does over the API; and one bulk channel's bundle is exported and imported into another, so the
 * import's standing is verified (the worker signs the statement, which writes the protected
 * `portability_signing_keys` row). The T0 fixture emote is never chosen, and the mock is started
 * without its image.
 */
import type { PortabilityImport } from "@commonair/contracts/dto";
import { download } from "../../e6/exports.ts";
import { startTwitchMock, TWITCH_FIXTURE, type TwitchMock } from "../../mocks/twitch/server.ts";
import { putPresigned } from "../../safety-io.ts";
import type { SignedInUser } from "../../users.ts";
import { waitFor } from "../../wait.ts";
import type { PlatformSessions } from "./api.ts";
import { step } from "./api.ts";
import type { PortabilitySpec } from "./plan.ts";

/** `harness/src/n3/index.ts`'s `TWITCH_MOCK_PORT`: `harness/compose.n3.yaml` points the stack at it (a test keeps them equal). */
export const TWITCH_MOCK_PORT = 4791;
const IMPORT_TIMEOUT_MS = 120_000;
const EXPORT_TIMEOUT_MS = 120_000;

export const TWITCH_FIX =
  "the Twitch import is off on this stack: start api and worker with TWITCH_IMPORT_ENABLED=true, OAUTH_TWITCH_CLIENT_ID/SECRET and TWITCH_API_BASE_URL/TWITCH_AUTH_BASE_URL/TWITCH_IMAGE_HOSTS pointed at the harness Twitch mock on port 4791 (harness/compose.n3.yaml)";

/** The emotes to import: every one offered, except the T0 fixture's (a scenario test, never seed data). Pure. */
export function importableEmotes(offered: readonly string[]): string[] {
  return offered.filter((code) => code !== TWITCH_FIXTURE.t0Emote);
}

/** The mock's base URLs the stack must be pointed at (for the plan test: only ever the mock). */
export function twitchMockBases(webhookHost: string, port = TWITCH_MOCK_PORT) {
  return {
    api: `http://${webhookHost}:${port}/helix`,
    auth: `http://${webhookHost}:${port}/oauth2`,
  };
}

const finished = (dto: PortabilityImport | null | undefined) =>
  dto && (dto.status === "done" || dto.status === "failed") ? dto : null;

export interface ImportResult {
  twitch: PortabilityImport;
  bundle: PortabilityImport | null;
}

async function twitchImport(user: SignedInUser, channel: string, mock: TwitchMock, signal?: AbortSignal) {
  const who = user.username;
  const status = await step(who, "read the Twitch import status", () =>
    user.api.client.twitchImport.status({ channel }),
  );
  if (!status.available) throw new Error(`seed-platform: ${TWITCH_FIX}`);
  const { authorizeUrl } = await step(who, "connect Twitch", () => user.api.client.twitchImport.connect({ channel }));
  const u = new URL(authorizeUrl);
  if (u.port !== String(mock.port))
    throw new Error(`seed-platform: the Twitch authorize URL is not the harness mock (${u.host}): ${TWITCH_FIX}`);
  // The mock answers on this machine; its redirect goes to the instance's callback with the user's session.
  const res = await fetch(`${mock.origin}${u.pathname}${u.search}`, { redirect: "manual", signal });
  const cb = new URL(res.headers.get("location") ?? "");
  const api = new URL(user.api.baseUrl);
  const back = await user.api.fetch(new Request(`${api.origin}${cb.pathname}${cb.search}`, { redirect: "manual" }));
  const outcome = new URL(back.headers.get("location") ?? "http://x.invalid/").searchParams.get("twitch");
  if (outcome !== "connected") throw new Error(`seed-platform: the Twitch connect came back "${outcome ?? "nothing"}"`);
  const preview = await step(who, "preview the Twitch import", () => user.api.client.twitchImport.preview({ channel }));
  const emotes = importableEmotes(
    preview.preview.items.filter((i) => i.kind === "emote" && i.outcome === null).map((i) => i.ref),
  );
  await step(who, "start the Twitch import", () =>
    user.api.client.twitchImport.start({
      channel,
      id: preview.id,
      choices: { channel: true, panels: false, emotes },
      assertEmoteRights: true,
    }),
  );
  return waitFor(
    "the Twitch import finished",
    async () => finished((await user.api.client.twitchImport.status({ channel })).latest),
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 2_000, signal },
  );
}

async function exportBundle(user: SignedInUser, channel: string, signal?: AbortSignal): Promise<Uint8Array> {
  await step(user.username, "export a bundle", () => user.api.client.portability.bundle.create({ channel }));
  const job = await waitFor(
    "a ready bundle export",
    async () => {
      const e = (await user.api.client.me.exports.list()).find((x) => x.kind === "bundle");
      if (e?.status === "failed") throw new Error("the bundle export failed");
      return e?.status === "ready" && e.downloadUrl ? e : null;
    },
    { timeoutMs: EXPORT_TIMEOUT_MS, intervalMs: 2_000, signal },
  );
  const got = await download(job.downloadUrl as string, signal);
  if (got.status !== 200 || !got.bytes)
    throw new Error(`seed-platform: the bundle download answered HTTP ${got.status}`);
  return got.bytes;
}

async function importBundle(user: SignedInUser, channel: string, archive: Uint8Array, signal?: AbortSignal) {
  const who = user.username;
  const up = await step(who, "request a bundle upload", () =>
    user.api.client.portability.imports.upload({ channel, sizeBytes: archive.byteLength }),
  );
  await putPresigned(up.uploadUrl, up.headers, archive, signal ?? new AbortController().signal);
  const dto = await step(who, "preview the bundle", () =>
    user.api.client.portability.imports.preview({ channel, key: up.key }),
  );
  const emotes = importableEmotes(
    dto.preview.items.filter((i) => i.kind === "emote" && i.outcome === null).map((i) => i.ref),
  );
  await step(who, "start the bundle import", () =>
    user.api.client.portability.imports.start({
      channel,
      id: dto.id,
      choices: { channel: true, panels: true, emotes },
      assertEmoteRights: emotes.length > 0,
    }),
  );
  return waitFor(
    "the bundle import finished",
    async () => finished(await user.api.client.portability.imports.get({ channel, id: dto.id })),
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 2_000, signal },
  );
}

/** The Twitch import and the bundle round trip. The mock runs only while this does. */
export async function seedImports(
  sessions: PlatformSessions,
  spec: PortabilitySpec,
  slugOf: (handle: string) => string,
  opts: { webhookHost: string; signal?: AbortSignal },
): Promise<ImportResult> {
  const mock = await startTwitchMock({ port: TWITCH_MOCK_PORT, hostname: "0.0.0.0", publicHost: opts.webhookHost });
  let twitch: PortabilityImport;
  try {
    const importer = await sessions.as(spec.twitchImporter);
    twitch = await twitchImport(importer, slugOf(spec.twitchImporter), mock, opts.signal);
  } finally {
    await mock.close();
  }
  if (twitch.status !== "done") throw new Error(`seed-platform: streamer3's Twitch import ended ${twitch.status}`);
  let bundle: PortabilityImport | null = null;
  if (spec.bundle) {
    const from = await sessions.as(spec.bundle.from);
    const to = await sessions.as(spec.bundle.to);
    const archive = await exportBundle(from, slugOf(spec.bundle.from), opts.signal);
    bundle = await importBundle(to, slugOf(spec.bundle.to), archive, opts.signal);
    if (bundle.status !== "done")
      throw new Error(`seed-platform: the bundle import into ${spec.bundle.to} ended ${bundle.status}`);
  }
  return { twitch, bundle };
}
