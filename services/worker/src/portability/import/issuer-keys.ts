// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The issuer's standing-statement keys (ADR 0037 decision 5): `GET <issuer>/.well-known/
 * commonair-portability`, fetched by the worker (never the API) through the SSRF guard
 * (`resolveCallback`: public addresses only, the connection pinned to the checked address), with
 * no redirects, a deadline and a response cap. A statement this instance issued is checked
 * against its own `portability_signing_keys` without a request.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { AttestationKeyHistory } from "@commonair/contracts/dto";
import { type Executor, schema } from "@commonair/db";
import type { StandingKey } from "@commonair/tokens/standing";
import { asc } from "drizzle-orm";
import { CallbackRejected, resolveCallback, type Resolver } from "../../webhooks/ssrf.ts";

/** Where an issuer publishes its keys (served by the API under `/api`, routed there by Caddy). */
export const PORTABILITY_KEYS_PATH = "/.well-known/commonair-portability";
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

export interface FetchKeysOptions {
  /** Dev and harness only: http and private addresses (`EVENTSUB_ALLOW_INSECURE_CALLBACKS`). */
  allowInsecure: boolean;
  resolve?: Resolver;
  timeoutMs?: number;
  /** Extra trusted CA (PEM); tests only. */
  ca?: string;
}

export type IssuerKeysResult = { ok: true; keys: StandingKey[] } | { ok: false; error: "unreachable" | "malformed" };

/** This instance's own key history. */
export async function localStandingKeys(db: Executor): Promise<StandingKey[]> {
  const k = schema.portabilitySigningKeys;
  const rows = await db.select().from(k).orderBy(asc(k.firstUsedAt), asc(k.kid));
  return rows.map((r) => ({
    kid: r.kid,
    algorithm: "Ed25519" as const,
    publicKey: r.publicKey,
    firstUsedAt: r.firstUsedAt.toISOString(),
    retiredAt: r.retiredAt?.toISOString() ?? null,
    compromisedAt: r.compromisedAt?.toISOString() ?? null,
  }));
}

/** A pinned GET: status and body (capped), or null for any failure. */
async function pinnedGet(raw: string, opts: FetchKeysOptions): Promise<{ status: number; body: string } | null> {
  let target;
  try {
    target = await resolveCallback(raw, opts);
  } catch (err) {
    if (err instanceof CallbackRejected) return null;
    throw err;
  }
  const { url, hostname, address } = target;
  const lookup: LookupFunction = (_host, options, cb) => {
    if (options && options.all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { status: number; body: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(r);
    };
    const req = mod.request(
      {
        method: "GET",
        protocol: url.protocol,
        host: hostname,
        servername: hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        lookup,
        agent: false,
        ...(opts.ca ? { ca: opts.ca } : {}),
        headers: { accept: "application/json", "user-agent": "CommonAir-Portability/1" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => finish(null));
      },
    );
    const deadline = setTimeout(() => {
      req.destroy(new Error("timeout"));
      finish(null);
    }, opts.timeoutMs ?? TIMEOUT_MS);
    req.on("error", () => finish(null));
    req.end();
  });
}

/** Fetch and check an issuer's key history: a 200 JSON body whose `origin` is the issuer. */
export async function fetchIssuerKeys(issuer: string, opts: FetchKeysOptions): Promise<IssuerKeysResult> {
  const res = await pinnedGet(`${issuer}${PORTABILITY_KEYS_PATH}`, opts);
  if (!res || res.status !== 200) return { ok: false, error: "unreachable" };
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return { ok: false, error: "malformed" };
  }
  const parsed = AttestationKeyHistory.safeParse(json);
  if (!parsed.success || parsed.data.origin !== issuer) return { ok: false, error: "malformed" };
  return { ok: true, keys: parsed.data.keys };
}
