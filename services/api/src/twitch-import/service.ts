// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Twitch import, the API's half (ADR 0031, batch 7 decision (b)).
 *
 * - `connect` answers the authorize URL: no scopes, a session-bound `state` (`state.ts`) and the
 *   import's own redirect URI (`TWITCH_IMPORT_CALLBACK_PATH` on `PUBLIC_URL`).
 * - The callback (`callback.ts` → `completeAuthorization`) checks the state and the session,
 *   exchanges the code, proves the account (the token's own `/users`, the channel read back for the
 *   same broadcaster, and the member's linked Twitch identity if they have one), reads the public
 *   data of decision 2, stores it as a `previewed` import (expiring after `PREVIEW_TTL_MS`) and
 *   **revokes the token**. The token lives only in this function's locals: never in the database,
 *   a queue, a log line or an error.
 * - `preview` and `status` read the stored preview; the items are computed again on every read, so
 *   a code the channel took since is shown as taken.
 * - `start` records the choices and, when emotes are chosen, the art assertion (wording version
 *   `EMOTE_ASSERTION_VERSION`), then queues `TWITCH_JOBS.import`. The worker fetches the images and
 *   calls `applyBundle`.
 *
 * Only the channel's owner imports: an import rewrites the channel's setup.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { schema, uuidv7 } from "@commonair/db";
import {
  authorizeUrl,
  EMOTE_ASSERTION_VERSION,
  exchangeCode,
  HelixClient,
  HelixError,
  planEmotes,
  PREVIEW_TTL_MS,
  previewItems,
  revokeToken,
  snapshotOf,
  toBundle,
  TwitchSnapshot,
  validateToken,
} from "@commonair/twitch";
import { PORTABILITY_LIMITS } from "@commonair/contracts/portability";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { apiError, conflict, forbidden, notFound } from "../lib/errors.ts";
import { toImportDto } from "../portability/imports.ts";
import { TWITCH_IMPORT_CALLBACK_PATH, twitchImportAvailable } from "../raw-routes.ts";
import { twitchImportQueue } from "./queue.ts";
import { sessionHash, signState, STATE_TTL_MS, verifyState } from "./state.ts";

const { portabilityImports: imports, channels, emotes, accounts } = schema;
type ImportRow = typeof imports.$inferSelect;
type ImportDto = z.infer<typeof dto.PortabilityImport>;
type StatusDto = z.infer<typeof dto.TwitchImportStatus>;

/** Per Twitch call. */
export const TWITCH_TIMEOUT_MS = 10_000;

export const redirectUri = (deps: Deps): string => `${deps.site.publicUrl}${TWITCH_IMPORT_CALLBACK_PATH}`;

function requireAvailable(deps: Deps): { clientId: string; clientSecret: string } {
  const { OAUTH_TWITCH_CLIENT_ID: clientId, OAUTH_TWITCH_CLIENT_SECRET: clientSecret } = deps.env;
  if (!twitchImportAvailable(deps.env) || !clientId || !clientSecret)
    throw apiError("PRECONDITION_FAILED", "Import from Twitch is not available on this instance", {
      requirement: "twitch_import_available",
    });
  return { clientId, clientSecret };
}

// The stored preview ---------------------------------------------------------------------------

/**
 * `state: "twitch"`, never `"ready"`: the generic `portability.imports.start` accepts only a
 * `"ready"` preview, so a Twitch preview cannot be started past this module's gates (expiry,
 * availability, audit, panels off). `twitchImportDto` serves it as `ready` or `expired`.
 */
interface StoredPreview {
  state: "twitch";
  expiresAt: string;
  twitch: TwitchSnapshot;
}

function storedSnapshot(row: ImportRow): TwitchSnapshot | null {
  const parsed = TwitchSnapshot.safeParse((row.preview as { twitch?: unknown }).twitch);
  return parsed.success ? parsed.data : null;
}

export const expiresAt = (row: Pick<ImportRow, "createdAt">): Date =>
  new Date(row.createdAt.getTime() + PREVIEW_TTL_MS);
const isExpired = (deps: Deps, row: ImportRow) => row.status === "previewed" && expiresAt(row) <= deps.now();

async function takenCodes(deps: Deps, channelId: string): Promise<Set<string>> {
  const rows = await deps.db.select({ code: emotes.code }).from(emotes).where(eq(emotes.channelId, channelId));
  return new Set(rows.map((r) => r.code));
}

/**
 * The served import: the channel fields as they would land (the bundle mapping), the expiry, and
 * the items computed now. Public data only; the Twitch ids stay in the stored row.
 */
export async function twitchImportDto(deps: Deps, row: ImportRow, channelLanguage: string): Promise<ImportDto> {
  const snap = storedSnapshot(row);
  if (!snap) return toImportDto(row);
  const taken = row.status === "previewed" ? await takenCodes(deps, row.channelId) : new Set<string>();
  const { bundle } = toBundle(snap, { domain: "localhost", exportedAt: deps.now(), fallbackLanguage: channelLanguage });
  const expired = isExpired(deps, row);
  const preview = {
    state: expired ? "expired" : "ready",
    channel: {
      twitchLogin: snap.user.login,
      twitchDisplayName: snap.user.displayName,
      title: bundle.channel.title,
      description: bundle.channel.description,
      tags: bundle.channel.tags,
      language: bundle.channel.language,
      category: bundle.channel.categoryName,
      matureSuggested: bundle.channel.mature,
      schedule: bundle.schedule,
      /** Each Twitch emote's CommonAir tier (null when it is not offered). */
      emotes: planEmotes(snap, taken).map((p) => ({ code: p.name, tier: p.emote?.tier ?? null })),
      expiresAt: expiresAt(row).toISOString(),
    },
    items: previewItems(snap, taken),
  };
  return toImportDto({ ...row, preview });
}

async function latestTwitch(deps: Deps, channelId: string): Promise<ImportRow | null> {
  const [row] = await deps.db
    .select()
    .from(imports)
    .where(and(eq(imports.channelId, channelId), eq(imports.source, "twitch")))
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .limit(1);
  return row ?? null;
}

// Procedures -----------------------------------------------------------------------------------

export async function importStatus(deps: Deps, channel: { id: string; language: string }): Promise<StatusDto> {
  const available = twitchImportAvailable(deps.env);
  const row = await latestTwitch(deps, channel.id);
  const live = row && row.status === "previewed" && !isExpired(deps, row) ? row : null;
  return {
    available,
    connected: available && live !== null,
    twitchLogin: live ? (storedSnapshot(live)?.user.login ?? null) : null,
    latest: row ? await twitchImportDto(deps, row, channel.language) : null,
  };
}

export async function connect(
  deps: Deps,
  input: { channelId: string; userId: string; sessionId: string | null },
): Promise<{ authorizeUrl: string }> {
  const { clientId } = requireAvailable(deps);
  // The state is bound to a browser session: the callback is a top-level navigation with cookies.
  if (!input.sessionId) throw forbidden("Connect Twitch from the studio, signed in");
  const { state } = await signState(deps.env.AUTH_SECRET, {
    channelId: input.channelId,
    userId: input.userId,
    sessionId: input.sessionId,
    now: deps.now(),
  });
  return {
    authorizeUrl: authorizeUrl({
      authBaseUrl: deps.env.TWITCH_AUTH_BASE_URL,
      clientId,
      redirectUri: redirectUri(deps),
      state,
    }),
  };
}

export async function latestPreview(deps: Deps, channel: { id: string; language: string }): Promise<ImportDto> {
  requireAvailable(deps);
  const row = await latestTwitch(deps, channel.id);
  if (!row || row.status !== "previewed") throw notFound("Connect Twitch to preview an import");
  if (isExpired(deps, row))
    throw apiError("NOT_FOUND", "This preview expired; connect Twitch again", { reason: "preview_expired" });
  return twitchImportDto(deps, row, channel.language);
}

export async function startTwitchImport(
  deps: Deps,
  input: {
    channelId: string;
    channelLanguage: string;
    userId: string;
    id: string;
    choices: { channel: boolean; fields?: dto.ImportChoices["fields"]; panels: boolean; emotes: string[] };
    assertEmoteRights: boolean;
  },
): Promise<ImportDto> {
  requireAvailable(deps);
  const now = deps.now();
  const taken = await takenCodes(deps, input.channelId);
  const row = await deps.db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(imports)
      .where(and(eq(imports.id, input.id), eq(imports.channelId, input.channelId), eq(imports.source, "twitch")))
      .for("update");
    if (!cur) throw notFound("Import not found");
    if (cur.status !== "previewed") throw conflict("This import was already started");
    if (isExpired(deps, cur))
      throw apiError("CONFLICT", "This preview expired; connect Twitch again", { reason: "preview_expired" });
    const snap = storedSnapshot(cur);
    if (!snap) throw conflict("This import has no preview");
    const busy = await tx
      .select({ id: imports.id })
      .from(imports)
      .where(
        and(
          eq(imports.channelId, input.channelId),
          inArray(imports.status, ["queued", "running"]),
          ne(imports.id, cur.id),
        ),
      )
      .limit(1);
    if (busy.length > 0) throw conflict("Another import of this channel is still running");
    const offered = new Set(
      previewItems(snap, taken)
        .filter((i) => i.kind === "emote" && i.outcome === null)
        .map((i) => i.ref),
    );
    const chosen = [...new Set(input.choices.emotes)].filter((c) => offered.has(c));
    if (chosen.length > 0 && !input.assertEmoteRights)
      throw apiError("PRECONDITION_FAILED", "Confirm you have the right to use this emote art", {
        requirement: "emote_rights",
      });
    // Twitch has no panels endpoint (decision (b)): panels come by paste, never from the job.
    // Absent fields means every field (batch 8); a stored object limits what the channel line applies.
    const choices = {
      channel: input.choices.channel,
      ...(input.choices.fields ? { fields: input.choices.fields } : {}),
      panels: false,
      emotes: chosen,
    };
    const [updated] = await tx
      .update(imports)
      .set({
        status: "queued",
        choices,
        ...(chosen.length > 0 ? { assertedAt: now, assertionVersion: EMOTE_ASSERTION_VERSION } : {}),
        updatedAt: now,
      })
      .where(eq(imports.id, cur.id))
      .returning();
    await audit(tx, {
      actorType: "user",
      actorId: input.userId,
      action: "twitch_import.start",
      subjectType: "portability_import",
      subjectId: cur.id,
      channelId: input.channelId,
      details: { emotes: chosen.length, channel: choices.channel },
    });
    return updated ?? cur;
  });
  try {
    await twitchImportQueue(deps).enqueue(row.id);
  } catch (err) {
    // Never leave an import queued that the worker will not hear of: hand it back to the preview.
    deps.logger.error("twitch import enqueue failed", { importId: row.id, err: (err as Error).name });
    await deps.db
      .update(imports)
      .set({ status: "previewed", choices: null, assertedAt: null, assertionVersion: null, updatedAt: deps.now() })
      .where(and(eq(imports.id, row.id), eq(imports.status, "queued")));
    throw err;
  }
  return twitchImportDto(deps, row, input.channelLanguage);
}

// The authorization --------------------------------------------------------------------------

/** Outcomes the callback redirects with (`/import?twitch=<outcome>`); opaque codes only. */
export type CallbackOutcome = "connected" | "denied" | "invalid" | "mismatch" | "failed";

export interface CallbackInput {
  state: string | null;
  code: string | null;
  error: string | null;
  /** The browser session making the callback (cookies), if any. */
  session: { id: string; userId: string } | null;
}

/** See the module comment. Never throws; every failure is an outcome. */
export async function completeAuthorization(deps: Deps, input: CallbackInput): Promise<CallbackOutcome> {
  const { clientId, clientSecret } = requireAvailable(deps);
  const now = deps.now();
  if (!input.state) return "invalid";
  const checked = await verifyState(deps.env.AUTH_SECRET, input.state, now);
  if (!checked.ok) {
    deps.logger.warn("twitch import state refused", { reason: checked.reason });
    return "invalid";
  }
  const st = checked.payload;
  if (!input.session || input.session.userId !== st.u || (await sessionHash(input.session.id)) !== st.s) {
    deps.logger.warn("twitch import state refused", { reason: "session" });
    return "invalid";
  }
  // One use: a replayed state (and with it the code) is refused.
  const fresh = await deps.valkey.set(`twitch-import:state:${st.n}`, "1", "PX", STATE_TTL_MS, "NX");
  if (fresh !== "OK") {
    deps.logger.warn("twitch import state refused", { reason: "replay" });
    return "invalid";
  }
  const [channel] = await deps.db.select().from(channels).where(eq(channels.id, st.c));
  if (!channel || channel.ownerId !== st.u) return "invalid";
  if (input.error || !input.code) return "denied";

  const common = { timeoutMs: TWITCH_TIMEOUT_MS };
  let token: string;
  try {
    token = (
      await exchangeCode({
        ...common,
        authBaseUrl: deps.env.TWITCH_AUTH_BASE_URL,
        clientId,
        clientSecret,
        code: input.code,
        redirectUri: redirectUri(deps),
      })
    ).accessToken;
  } catch (err) {
    deps.logger.warn("twitch import code exchange failed", { channelId: channel.id, ...helixFields(err) });
    return "failed";
  }

  let outcome: CallbackOutcome = "failed";
  let snapshot: TwitchSnapshot | null = null;
  try {
    const v = await validateToken({ ...common, authBaseUrl: deps.env.TWITCH_AUTH_BASE_URL, token });
    if (v.clientId !== clientId) throw new HelixError("malformed", null, "token of another client");
    const helix = new HelixClient({ ...common, baseUrl: deps.env.TWITCH_API_BASE_URL, clientId, token });
    // The token's own user is the account being imported: control of it is what the authorization proves.
    const me = await helix.me();
    if (v.userId !== null && v.userId !== me.id) outcome = "mismatch";
    else if (!(await linkedIdentityMatches(deps, st.u, me.id))) outcome = "mismatch";
    else {
      const ch = await helix.channel(me.id);
      if (ch.broadcaster_id !== me.id || ch.broadcaster_login.toLowerCase() !== me.login.toLowerCase())
        outcome = "mismatch";
      else {
        const [emotesRes, schedule] = [
          await helix.emotes(me.id),
          await helix.schedule(me.id, PORTABILITY_LIMITS.maxScheduleEntries),
        ];
        snapshot = snapshotOf({ user: me, channel: ch, emotes: emotesRes, schedule });
        outcome = "connected";
      }
    }
  } catch (err) {
    deps.logger.warn("twitch import read failed", { channelId: channel.id, ...helixFields(err) });
    outcome = "failed";
  } finally {
    // ADR 0031 decision 4: the token is used once and revoked, whatever happened above.
    const revoked = await revokeToken({
      ...common,
      authBaseUrl: deps.env.TWITCH_AUTH_BASE_URL,
      clientId,
      token,
    }).catch(() => false);
    if (!revoked) deps.logger.warn("twitch import token revocation failed", { channelId: channel.id });
  }
  if (outcome === "mismatch") deps.logger.warn("twitch import account mismatch", { channelId: channel.id });
  if (outcome !== "connected" || !snapshot) return outcome;

  const preview: StoredPreview = {
    state: "twitch",
    expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS).toISOString(),
    twitch: snapshot,
  };
  const id = uuidv7();
  await deps.db.transaction(async (tx) => {
    // One live preview per channel: an earlier one that was never started goes.
    await tx
      .delete(imports)
      .where(and(eq(imports.channelId, channel.id), eq(imports.source, "twitch"), eq(imports.status, "previewed")));
    await tx.insert(imports).values({
      id,
      userId: st.u,
      channelId: channel.id,
      source: "twitch",
      status: "previewed",
      preview: preview as unknown as Record<string, unknown>,
      createdAt: now,
    });
  });
  deps.logger.info("twitch import previewed", { importId: id, channelId: channel.id });
  return "connected";
}

/**
 * When the member signed in with Twitch, the import must be of that same Twitch account. Only the
 * account id is read; the tokens the sign-in keeps are never read (ADR 0031 decision 4).
 */
async function linkedIdentityMatches(deps: Deps, userId: string, twitchUserId: string): Promise<boolean> {
  const linked = await deps.db
    .select({ accountId: accounts.accountId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "twitch")));
  return linked.length === 0 || linked.some((a) => a.accountId === twitchUserId);
}

const helixFields = (err: unknown) =>
  err instanceof HelixError ? { kind: err.kind, status: err.status } : { kind: "error", err: (err as Error)?.name };
