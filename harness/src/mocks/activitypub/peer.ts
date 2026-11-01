// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A minimal ActivityPub peer (batch 7 decision (c); ADR 0030): one in-process `Bun.serve` that
 * plays a Mastodon server with one `Person`. It serves the actor document (with its RSA public
 * key) and WebFinger, records every activity POSTed to its inboxes and verifies each one's
 * draft-cavage signature with `packages/federation` (fetching the sender's key by `keyId`), and
 * sends signed `Follow`, `Undo{Follow}`, `Delete` and a deliberately bad-signature `Follow`.
 *
 * Reachability is the `harness/src/e9/receiver.ts` way: it listens on every interface, and its
 * URLs name `host` (the harness passes `HARNESS_WEBHOOK_HOST`, how the stack's containers reach
 * this machine; worker tests pass 127.0.0.1). A second peer on a "blocked" host name signs with a
 * domain the instance blocks: the instance refuses it at the inbox, before any fetch, so that name
 * need not resolve. `rewrite` maps URLs this peer fetches (the instance's public origin) to where
 * this machine reaches them (the API's own port, without Caddy).
 *
 * The keys are generated per peer; no fixture keys. Test and harness only.
 */
// Relative import: the harness has no workspace dependency on packages/federation (as
// `src/w3/giveaways.ts` reaches packages/draw).
import {
  ACTIVITY_CONTENT_TYPE,
  type ActorKeyPair,
  AS2_CONTEXT,
  generateActorKey,
  idOf,
  importPrivateKeyPem,
  parseSignatureHeader,
  SECURITY_CONTEXT,
  signRequest,
  verifyRequest,
  type VerifyRequestResult,
} from "../../../../packages/federation/src/index.ts";

export interface PeerOptions {
  /** The host name in this peer's URLs (how the instance reaches it). */
  host: string;
  /** The `Person`'s username (default `alice`). */
  username?: string;
  /** Map a URL this peer fetches to where this machine reaches it (default: unchanged). */
  rewrite?: (url: string) => string;
  /** Advertise `endpoints.sharedInbox` (Mastodon does). Default true. */
  sharedInbox?: boolean;
  /** Fixed keys (tests); generated otherwise. */
  keys?: ActorKeyPair;
  /** Look a sender's key up without a fetch (worker tests, where no API serves the actor). */
  resolveKey?: (keyId: string) => Promise<{ publicKeyPem: string; owner: string } | null>;
}

export interface ReceivedActivity {
  /** `/users/<name>/inbox` or `/inbox`. */
  path: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string;
  /** The parsed body, or null when it was not JSON. */
  json: Record<string, unknown> | null;
  /** The activity's `type`, and its object's `type` when the object is embedded. */
  type: string | null;
  objectType: string | null;
  /** The draft-cavage check against the sender's fetched key. */
  verified: VerifyRequestResult | { ok: false; error: "key_unavailable" };
  receivedAt: number;
}

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  activity: Record<string, unknown>;
}

export interface WebFingerResult {
  subject: string;
  actorId: string;
  actor: Record<string, unknown>;
}

export interface ActivityPubPeer {
  port: number;
  /** `http://<host>:<port>`. */
  origin: string;
  /** The domain the peer's actor lives on (its host name, no port). */
  domain: string;
  actorId: string;
  keyId: string;
  inbox: string;
  sharedInbox: string | null;
  readonly received: readonly ReceivedActivity[];
  /** The `Person` document this peer serves. */
  actorDocument(): Record<string, unknown>;
  /** First recorded activity (past or future) matching `predicate`. */
  waitFor(predicate: (r: ReceivedActivity) => boolean, timeoutMs?: number): Promise<ReceivedActivity>;
  /** Activities received since index `from` that match. */
  since(from: number, predicate?: (r: ReceivedActivity) => boolean): ReceivedActivity[];
  /** Answer the next `n` inbox POSTs with `status` (then 202 again). */
  failNext(n: number, status: number): void;
  /** Sign a POST of `activity` to `url` without sending it (`date` and a tampered body for tests). */
  sign(url: string, activity: Record<string, unknown>, opts?: SignOptions): Promise<SentRequest>;
  /** Sign and send. */
  post(url: string, activity: Record<string, unknown>, opts?: SignOptions): Promise<Response>;
  follow(
    target: string,
    inbox: string,
    opts?: SignOptions,
  ): Promise<{ activity: Record<string, unknown>; response: Response }>;
  undoFollow(follow: Record<string, unknown>, inbox: string): Promise<Response>;
  deleteSelf(inbox: string): Promise<Response>;
  /** A `Follow` whose signature does not match its body (signed, then the body is changed). */
  badSignatureFollow(target: string, inbox: string): Promise<Response>;
  /** Resolve `@user@domain` at the instance's WebFinger `endpoint`, then fetch the actor (through `rewrite`). */
  webfinger(endpoint: string, handle: string): Promise<WebFingerResult>;
  close(): Promise<void>;
}

export interface SignOptions {
  date?: Date;
  /** Change the body after signing (the digest and signature no longer match). */
  tamper?: boolean;
  /** Sign with this keyId instead of the peer's (an actor/key mismatch). */
  keyId?: string;
  /** Sign with another key (a stale key after rotation). */
  privateKeyPem?: string;
}

const DEFAULT_WAIT_MS = 30_000;
const ACCEPT = `${ACTIVITY_CONTENT_TYPE}, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`;

const lower = (h: Headers) => Object.fromEntries([...h].map(([k, v]) => [k.toLowerCase(), v]));

/** A fresh id on this peer (Mastodon uses random ids for Follows). */
const randomId = (origin: string) => `${origin}/${crypto.randomUUID()}`;

export async function startActivityPubPeer(opts: PeerOptions): Promise<ActivityPubPeer> {
  const username = opts.username ?? "alice";
  const keys = opts.keys ?? (await generateActorKey());
  const privateKey = await importPrivateKeyPem(keys.privateKeyPem);
  const rewrite = opts.rewrite ?? ((u: string) => u);
  const withShared = opts.sharedInbox ?? true;
  const received: ReceivedActivity[] = [];
  const waiters = new Set<{ predicate: (r: ReceivedActivity) => boolean; resolve: (r: ReceivedActivity) => void }>();
  const keyCache = new Map<string, { publicKeyPem: string; owner: string }>();
  let failures: { n: number; status: number } = { n: 0, status: 500 };

  // The URLs need the port, so they are filled in once the server listens.
  let origin = "";
  let actorId = "";
  let keyId = "";
  let inbox = "";
  let sharedInbox: string | null = null;

  const actorDocument = (): Record<string, unknown> => ({
    "@context": [AS2_CONTEXT, SECURITY_CONTEXT],
    id: actorId,
    type: "Person",
    preferredUsername: username,
    name: username,
    inbox,
    outbox: `${actorId}/outbox`,
    followers: `${actorId}/followers`,
    following: `${actorId}/following`,
    ...(sharedInbox ? { endpoints: { sharedInbox } } : {}),
    publicKey: { id: keyId, owner: actorId, publicKeyPem: keys.publicKeyPem },
  });

  const fetchKey = async (kid: string, refresh: boolean) => {
    if (opts.resolveKey) return opts.resolveKey(kid);
    if (!refresh && keyCache.has(kid)) return keyCache.get(kid) ?? null;
    try {
      const res = await fetch(rewrite(kid.split("#")[0] ?? kid), { headers: { accept: ACCEPT } });
      if (!res.ok) return null;
      const doc = (await res.json()) as Record<string, unknown>;
      const pk = (doc.publicKey ?? doc) as Record<string, unknown>;
      if (pk.id !== kid || typeof pk.publicKeyPem !== "string") return null;
      const owner = idOf(pk.owner) ?? idOf(doc.id);
      if (!owner) return null;
      const key = { publicKeyPem: pk.publicKeyPem, owner };
      keyCache.set(kid, key);
      return key;
    } catch {
      return null;
    }
  };

  const verify = async (req: Request, path: string, body: string): Promise<ReceivedActivity["verified"]> => {
    const headers = lower(req.headers);
    const sig = parseSignatureHeader(headers.signature ?? "");
    if (!sig) return { ok: false, error: "missing_signature" };
    // Verify as addressed: the Host the sender signed is the one it connected to.
    const input = { method: "POST", url: `http://${headers.host ?? ""}${path}`, headers, body };
    let key = await fetchKey(sig.keyId, false);
    if (!key) return { ok: false, error: "key_unavailable" };
    let result = await verifyRequest(input, { publicKey: key.publicKeyPem, owner: key.owner });
    if (!result.ok && result.error === "bad_signature") {
      key = await fetchKey(sig.keyId, true);
      if (!key) return { ok: false, error: "key_unavailable" };
      result = await verifyRequest(input, { publicKey: key.publicKeyPem, owner: key.owner });
    }
    return result;
  };

  const record = (r: ReceivedActivity) => {
    received.push(r);
    for (const w of waiters)
      if (w.predicate(r)) {
        waiters.delete(w);
        w.resolve(r);
      }
  };

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "GET" && path === "/.well-known/webfinger") {
        const resource = url.searchParams.get("resource") ?? "";
        if (resource !== `acct:${username}@${new URL(origin).hostname}` && resource !== actorId)
          return new Response(null, { status: 404 });
        return Response.json(
          {
            subject: `acct:${username}@${new URL(origin).hostname}`,
            links: [{ rel: "self", type: ACTIVITY_CONTENT_TYPE, href: actorId }],
          },
          { headers: { "content-type": "application/jrd+json" } },
        );
      }
      if (req.method === "GET" && path === new URL(actorId).pathname)
        return Response.json(actorDocument(), { headers: { "content-type": ACTIVITY_CONTENT_TYPE } });
      const isInbox =
        path === new URL(inbox).pathname || (sharedInbox !== null && path === new URL(sharedInbox).pathname);
      if (req.method === "POST" && isInbox) {
        const body = await req.text();
        let json: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(body);
          json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        } catch {
          json = null;
        }
        const obj = json?.object;
        record({
          path,
          headers: lower(req.headers),
          body,
          json,
          type: typeof json?.type === "string" ? json.type : null,
          objectType:
            obj && typeof obj === "object" && typeof (obj as { type?: unknown }).type === "string"
              ? (obj as { type: string }).type
              : null,
          verified: await verify(req, path, body),
          receivedAt: Date.now(),
        });
        if (failures.n > 0) {
          failures = { n: failures.n - 1, status: failures.status };
          return new Response(null, { status: failures.status });
        }
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    },
  });

  const port = server.port ?? 0;
  origin = `http://${opts.host}:${port}`;
  actorId = `${origin}/users/${username}`;
  keyId = `${actorId}#main-key`;
  inbox = `${actorId}/inbox`;
  sharedInbox = withShared ? `${origin}/inbox` : null;

  const sign = async (url: string, activity: Record<string, unknown>, o: SignOptions = {}): Promise<SentRequest> => {
    const body = JSON.stringify(activity);
    const headers = await signRequest({
      method: "POST",
      url,
      headers: {
        "content-type": ACTIVITY_CONTENT_TYPE,
        accept: ACCEPT,
        ...(o.date ? { date: o.date.toUTCString() } : {}),
      },
      body,
      keyId: o.keyId ?? keyId,
      privateKey: o.privateKeyPem ?? privateKey,
    });
    const sent = o.tamper ? JSON.stringify({ ...activity, tampered: true }) : body;
    return { url, headers, body: sent, activity };
  };

  const post = async (url: string, activity: Record<string, unknown>, o: SignOptions = {}): Promise<Response> => {
    const r = await sign(url, activity, o);
    // fetch sets Host from the URL; the signed one is the same.
    const { host: _host, ...headers } = r.headers;
    return fetch(url, { method: "POST", headers, body: r.body });
  };

  const follow = async (target: string, to: string, o: SignOptions = {}) => {
    const activity = { "@context": AS2_CONTEXT, id: randomId(origin), type: "Follow", actor: actorId, object: target };
    return { activity, response: await post(to, activity, o) };
  };

  return {
    port,
    origin,
    domain: opts.host.toLowerCase(),
    actorId,
    keyId,
    inbox,
    sharedInbox,
    received,
    actorDocument,
    waitFor(predicate, timeoutMs = DEFAULT_WAIT_MS) {
      const past = received.find(predicate);
      if (past) return Promise.resolve(past);
      return new Promise<ReceivedActivity>((resolve, reject) => {
        const w = {
          predicate,
          resolve: (r: ReceivedActivity) => {
            clearTimeout(timer);
            resolve(r);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`activitypub peer: no matching activity within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    since: (from, predicate = () => true) => received.slice(from).filter(predicate),
    failNext(n, status) {
      failures = { n, status };
    },
    sign,
    post,
    follow,
    undoFollow: (f, to) =>
      post(to, { "@context": AS2_CONTEXT, id: `${String(f.id)}/undo`, type: "Undo", actor: actorId, object: f }),
    deleteSelf: (to) =>
      post(to, {
        "@context": AS2_CONTEXT,
        id: `${actorId}#delete`,
        type: "Delete",
        actor: actorId,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        object: actorId,
      }),
    badSignatureFollow: async (target, to) => {
      const activity = {
        "@context": AS2_CONTEXT,
        id: randomId(origin),
        type: "Follow",
        actor: actorId,
        object: target,
      };
      return post(to, activity, { tamper: true });
    },
    async webfinger(endpoint, handle) {
      const resource = `acct:${handle.replace(/^@/, "")}`;
      const res = await fetch(`${endpoint}?resource=${encodeURIComponent(resource)}`, {
        headers: { accept: "application/jrd+json, application/json" },
      });
      if (!res.ok) throw new Error(`webfinger answered ${res.status}`);
      const jrd = (await res.json()) as { subject?: unknown; links?: { rel?: string; type?: string; href?: string }[] };
      const self = jrd.links?.find(
        (l) =>
          l.rel === "self" && (l.type === ACTIVITY_CONTENT_TYPE || (l.type ?? "").startsWith("application/ld+json")),
      );
      if (!self?.href) throw new Error("webfinger has no self link");
      const actorRes = await fetch(rewrite(self.href), { headers: { accept: ACCEPT } });
      if (!actorRes.ok) throw new Error(`actor answered ${actorRes.status}`);
      return {
        subject: typeof jrd.subject === "string" ? jrd.subject : "",
        actorId: self.href,
        actor: (await actorRes.json()) as Record<string, unknown>,
      };
    },
    async close() {
      await server.stop(true);
    },
  };
}
