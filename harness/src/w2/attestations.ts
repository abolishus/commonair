// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` W2 extensions `signed` and `tamper` (docs/testing/w2-selectors.md,
 * "Scenarios"; ADR 0014). They run after `group`, which ended the broadcast and rolled it up.
 *
 * - `signed`: run the attestation job now (the analytics tick), bypass the 24 h publication delay,
 *   and check that the broadcast's current statement verifies with the SDK verifier against the
 *   published key history, alone and as the public window bundle; that its figures are the
 *   rollup's and equal the session verdicts (verified, unverified, excluded seconds, computed here
 *   from `playback_sessions` the way the rollup does); that it names this instance and carries no
 *   user or session id; and that `/attestations/verify` says it is valid, signed out.
 * - `tamper`: a payload changed after signing fails the SDK verifier; the stored row cannot be
 *   changed (the append-only trigger refuses it), and a served row altered on the way (another
 *   entry hash, a relabelled kind, a payload from another entry, a breakdown that no longer opens
 *   the commitment) fails too.
 */
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { AttestationStatement, canonicalize, fromB64url, toB64url } from "@commonair/tokens/attestation";
// Relative until `@commonair/sdk` re-exports `./attestation.ts` (contract request): the SDK file
// is the verifier third parties get, so the harness checks with exactly that.
import {
  type ServedAttestationEntry,
  verifyAttestation,
  verifyReasons,
  verifyServedBundle,
} from "../../../packages/sdk/src/attestation.ts";
import { internalSecret } from "../safety-io.ts";
import { WebSession } from "../web/session.ts";
import type { IntegrityW2Extension } from "./kit.ts";

const UI_TIMEOUT_MS = 30_000;
/** The tick waits for the worker; a loaded CI runner needs room. */
const TICK_TIMEOUT_MS = 90_000;
const VERIFY_ROUTE = "/attestations/verify";

// ------------------------------------------------------------------ database reads (Bun.SQL)

export interface VerdictSeconds {
  verified: number;
  unverified: number;
  excluded: number;
}

/**
 * Watch seconds by verdict straight from the sessions, as the rollup classifies and clips them
 * (ADR 0014 decision 7): verified means gate-eligible (verified, scored, judged); pending and
 * `fetch_unjudged` are unverified; each session is clipped to the broadcast (an open one ends with
 * it), floored to whole seconds, and counted only with at least one. Timestamps are truncated to
 * milliseconds first, as the rollup reads them through JS `Date`.
 */
export async function readVerdictSeconds(url: string, broadcastId: string): Promise<VerdictSeconds> {
  const sql = new Bun.SQL(url);
  try {
    const [row] = (await sql`
      with s as (
        select ps.verdict,
               (ps.verdict = 'verified' and ps.scored_at is not null
                 and not ('fetch_unjudged' = any(coalesce(ps.verdict_reasons, '{}')))) as eligible,
               floor(extract(epoch from (
                 least(date_trunc('milliseconds', coalesce(ps.ended_at, b.ended_at)), date_trunc('milliseconds', b.ended_at))
                 - greatest(date_trunc('milliseconds', ps.started_at), date_trunc('milliseconds', b.started_at))
               )))::int as secs
          from playback_sessions ps join broadcasts b on b.id = ps.broadcast_id
         where ps.broadcast_id = ${broadcastId}::uuid)
      select coalesce(sum(secs) filter (where secs >= 1 and eligible), 0)::int as verified,
             coalesce(sum(secs) filter (where secs >= 1 and verdict = 'excluded'), 0)::int as excluded,
             coalesce(sum(secs) filter (where secs >= 1 and not eligible and verdict <> 'excluded'), 0)::int as unverified
        from s`) as VerdictSeconds[];
    return row ?? { verified: 0, unverified: 0, excluded: 0 };
  } finally {
    await sql.close();
  }
}

export interface StoredEntry {
  id: string;
  seq: number;
  kind: string;
  payload: string;
  signature: string;
  entryHash: string;
}

/** The broadcast's chain entries, oldest first. */
export async function readEntries(url: string, broadcastId: string): Promise<StoredEntry[]> {
  const sql = new Bun.SQL(url);
  try {
    const rows = (await sql`
      select id::text as id, seq, kind::text as kind, payload, signature, entry_hash as "entryHash"
        from integrity_attestations where broadcast_id = ${broadcastId}::uuid order by seq`) as StoredEntry[];
    // A plain array: Bun.SQL results also carry `count` and `command`.
    return [...rows];
  } finally {
    await sql.close();
  }
}

/**
 * Try to rewrite a stored entry's payload (to one with a changed figure). Returns the database's
 * refusal, or null if the update went through (which would be a failure of the append-only rule).
 */
export async function tryRewriteStoredRow(url: string, id: string, payload: string): Promise<string | null> {
  const sql = new Bun.SQL(url);
  try {
    await sql`update integrity_attestations set payload = ${payload} where id = ${id}::uuid`;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await sql.close();
  }
}

// ------------------------------------------------------------------ pure helpers

export const decodeStatement = (payload: string): AttestationStatement =>
  AttestationStatement.parse(JSON.parse(new TextDecoder().decode(fromB64url(payload))));

/** The same statement with one figure changed, re-encoded canonically; the old signature no longer fits. */
export function tamperedPayload(payload: string): string {
  const s = decodeStatement(payload);
  return toB64url(canonicalize({ ...s, verifiedViewerSeconds: s.verifiedViewerSeconds + 1 }));
}

/** Differences between a statement's figures and the verdict seconds (empty when they agree). */
export function verdictMismatches(s: AttestationStatement, v: VerdictSeconds): string[] {
  const out: string[] = [];
  if (s.verifiedViewerSeconds !== v.verified) out.push(`verified ${s.verifiedViewerSeconds} != ${v.verified}`);
  if (s.unverifiedViewerSeconds !== v.unverified)
    out.push(`unverified ${s.unverifiedViewerSeconds} != ${v.unverified}`);
  if (s.excludedViewerSeconds !== v.excluded) out.push(`excluded ${s.excludedViewerSeconds} != ${v.excluded}`);
  return out;
}

/** Ids that must never appear in a statement (ADR 0004): users and sessions. */
export const leakedIds = (payload: string, ids: readonly string[]): string[] => {
  const text = new TextDecoder().decode(fromB64url(payload));
  return ids.filter((id) => text.includes(id));
};

// ------------------------------------------------------------------ steps

async function hook(ext: IntegrityW2Extension, path: string, method: string, body: unknown): Promise<Response> {
  const secret = internalSecret(ext.ctx.env);
  if (!secret) throw new Error("INTERNAL_API_SECRET is not set: the analytics test hooks need it");
  const res = await fetch(new URL(path, ext.ctx.env.HARNESS_API_URL), {
    method,
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
    signal: AbortSignal.any([ext.ctx.signal, AbortSignal.timeout(TICK_TIMEOUT_MS)]),
  });
  if (res.status === 404)
    throw new Error(`${path} answered 404: the analytics test hooks are off (OPS_TEST_HOOKS=true for the api)`);
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  return res;
}

async function bypassDelay(ext: IntegrityW2Extension): Promise<void> {
  await hook(ext, INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", { channelId: ext.channelId, enabled: true });
  ext.ctx.defer(() =>
    hook(ext, INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", { channelId: ext.channelId, enabled: false }).catch(
      () => undefined,
    ),
  );
}

/** The public window from the broadcast's first entry, as a sponsor would fetch it. */
async function publicBundle(ext: IntegrityW2Extension, fromSeq: number) {
  return ext.platform.api().client.integrity.attestations.bundle({ channel: ext.channel, fromSeq, limit: 2000 });
}

export async function stepSigned(ext: IntegrityW2Extension): Promise<void> {
  const { ctx, channel, streamer } = ext;
  const broadcastId = ext.broadcastId;
  ctx.assert("the scenario's broadcast is known", broadcastId !== null, { broadcastId });
  if (broadcastId === null) return;
  await ext.endBroadcast();
  await ctx.step("bypass the publication delay", () => bypassDelay(ext));

  // The outbox may already have run the job on `analytics.rollup.ready`; then this one finds the
  // same figures and appends nothing.
  const tick = await ctx.step("run the attestation job now", async () => {
    const res = await hook(ext, INTERNAL_ROUTES.analyticsTick, "POST", { job: "integrity-attestation", broadcastId });
    return (await res.json()) as Record<string, number>;
  });
  ctx.data("signed.tick", tick);
  ctx.assert(
    "the job attested the broadcast (or found it attested)",
    tick.attested === 1 || tick.unchanged === 1,
    tick,
  );

  const owned = await ctx.step("the owner reads the chain", () =>
    streamer.api.client.integrity.attestations.list({ channel, limit: 100 }),
  );
  const mine = owned.items.filter((e) => e.broadcastId === broadcastId);
  const current = mine.find((e) => !e.superseded);
  ctx.assert(
    "the broadcast has one current entry",
    current !== undefined && mine.filter((e) => !e.superseded).length === 1,
    {
      entries: mine.map((e) => ({ seq: e.seq, kind: e.kind, superseded: e.superseded })),
    },
  );
  if (!current) return;
  ctx.data("signed.entry", { seq: current.seq, kind: current.kind, kid: current.kid, entryHash: current.entryHash });
  ctx.assert("the owner sees the breakdown and salt", current.breakdown !== null && current.salt !== null);

  const keys = await ctx.step("read /.well-known/commonair-attestation", () =>
    ext.platform.api().client.integrity.keys.list(),
  );
  const single = await verifyAttestation(current.envelope, keys.keys);
  ctx.assert("the statement verifies with the SDK verifier", single.ok, single.ok ? null : single.error);
  if (!single.ok) return;
  const s = single.statement;
  ctx.assert("it names this instance", s.origin === keys.origin, { statement: s.origin, instance: keys.origin });
  ctx.assert("its entry hash is the listed one", single.entryHash === current.entryHash);
  if (current.breakdown && current.salt)
    ctx.assert("the owner's breakdown opens the commitment", await verifyReasons(s, current.salt, current.breakdown));

  const first = Math.min(...mine.map((e) => e.seq));
  const bundle = await ctx.step("read the public window bundle", () => publicBundle(ext, first));
  ctx.assert(
    "the bundle hides the breakdown",
    bundle.entries.every((e) => e.breakdown === null && e.salt === null),
  );
  const window = await verifyServedBundle(bundle);
  ctx.assert("the window bundle verifies with the SDK verifier", window.ok, window.ok ? null : window);
  if (window.ok)
    ctx.assert(
      "the bundle's current entry for the broadcast is this one",
      window.latest.some((e) => e.entryHash === current.entryHash),
    );

  if (ext.databaseUrl) {
    const url = ext.databaseUrl;
    const verdicts = await ctx.step("read the session verdicts", () => readVerdictSeconds(url, broadcastId));
    ctx.data("signed.verdicts", verdicts);
    const diff = verdictMismatches(s, verdicts);
    ctx.assert("the statement's figures equal the session verdicts", diff.length === 0, { diff, verdicts });
    const leaked = leakedIds(current.envelope.payload, [streamer.id, ...ext.swarmSessionIds]);
    ctx.assert("no user or session id in the statement", leaked.length === 0, leaked);
  } else ctx.skipStep("figures against the session verdicts", "the harness cannot reach the database");

  await ctx.step("/attestations/verify says it is valid, signed out", async () => {
    // Signed out: a sponsor checking a statement has no account here.
    const session = await WebSession.open({
      fleet: ctx.platform.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: "",
      label: "attestation-verifier",
      log: ctx.log,
    });
    ctx.defer(() => session.close());
    const page = await session.goto(VERIFY_ROUTE);
    await page.locator('[data-testid="attestation-verify-page"]').waitFor({ timeout: UI_TIMEOUT_MS });
    await page
      .locator('[data-testid="attestation-verify-input"]')
      .fill(JSON.stringify({ payload: current.envelope.payload, signature: current.envelope.signature }));
    await page.locator('[data-testid="attestation-verify-submit"]').click();
    const result = page.locator('[data-testid="attestation-verify-result"]');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.assert("the verifier page says valid", (await result.getAttribute("data-valid")) === "true", {
      reason: await result.getAttribute("data-reason"),
    });
    const origin = page.locator('[data-testid="attestation-verify-origin"]');
    ctx.assert("the verifier page shows the signing instance", (await origin.getAttribute("data-origin")) === s.origin);
  });
}

export async function stepTamper(ext: IntegrityW2Extension): Promise<void> {
  const { ctx, channel, streamer } = ext;
  const broadcastId = ext.broadcastId;
  if (broadcastId === null) return;
  const owned = await streamer.api.client.integrity.attestations.list({ channel, limit: 100 });
  const mine = owned.items.filter((e) => e.broadcastId === broadcastId);
  const current = mine.find((e) => !e.superseded);
  ctx.assert("the signed entry is there to tamper with", current !== undefined);
  if (!current) return;
  const keys = await ext.platform.api().client.integrity.keys.list();

  const forged = tamperedPayload(current.envelope.payload);
  const r = await verifyAttestation({ payload: forged, signature: current.envelope.signature }, keys.keys);
  ctx.assert("a payload changed after signing fails", !r.ok && r.error === "bad_signature", r);

  const first = Math.min(...mine.map((e) => e.seq));
  const bundle = await publicBundle(ext, first);
  const at = bundle.entries.findIndex((e) => e.id === current.id);
  ctx.assert("the entry is in the public bundle", at >= 0);
  if (at < 0) return;
  const alter = (f: (e: ServedAttestationEntry) => ServedAttestationEntry) => ({
    ...bundle,
    entries: bundle.entries.map((e, i) => (i === at ? { ...e, ...f(e) } : e)),
  });
  const cases: [string, ReturnType<typeof alter>][] = [
    ["a forged payload in the bundle", alter((e) => ({ ...e, envelope: { ...e.envelope, payload: forged } }))],
    ["another entry hash", alter((e) => ({ ...e, entryHash: "0".repeat(64) }))],
    ["a relabelled kind", alter((e) => ({ ...e, kind: e.kind === "broadcast" ? "supersede" : "broadcast" }))],
    [
      "a truncated signature",
      alter((e) => ({ ...e, envelope: { ...e.envelope, signature: e.envelope.signature.slice(0, 40) } })),
    ],
  ];
  for (const [name, b] of cases) {
    const v = await verifyServedBundle(b);
    ctx.assert(`a served row with ${name} fails`, !v.ok, v.ok ? null : v.problem);
  }
  if (current.breakdown && current.salt) {
    const s = decodeStatement(current.envelope.payload);
    const [category] = Object.keys(current.breakdown) as (keyof typeof current.breakdown)[];
    const changed = category
      ? { ...current.breakdown, [category]: (current.breakdown[category] ?? 0) + 1 }
      : { other: 1 };
    ctx.assert("a changed breakdown no longer opens the commitment", !(await verifyReasons(s, current.salt, changed)));
  }

  if (ext.databaseUrl) {
    const url = ext.databaseUrl;
    const refusal = await ctx.step("try to rewrite the stored row", () => tryRewriteStoredRow(url, current.id, forged));
    ctx.assert("the database refuses to change a stored entry", refusal !== null, { refusal });
    const [after] = (await readEntries(url, broadcastId)).filter((e) => e.id === current.id);
    ctx.assert("the stored entry is unchanged and still verifies", after?.payload === current.envelope.payload);
    if (after) {
      const still = await verifyAttestation({ payload: after.payload, signature: after.signature }, keys.keys);
      ctx.assert("the stored row verifies as signed", still.ok);
    }
  } else ctx.skipStep("rewrite the stored row", "the harness cannot reach the database");
}
