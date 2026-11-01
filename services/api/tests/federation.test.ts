// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N4-api pure logic (ADR 0030): WebFinger resource parsing, the actor document against a
 * Mastodon-shaped fixture, the mature rule, content negotiation, domain-block matching, the
 * inbox's cheap checks (each refusal, and 202-and-drop for other types), NodeInfo and the catalog.
 */
import { describe, expect, test } from "vite-plus/test";
import { FEDERATION_RULES } from "@commonair/contracts/enums";
import { DATE_SKEW_SECONDS } from "@commonair/federation";
import { buildActorDocument, actorSummary, wantsActivityJson, type ActorInput } from "../src/federation/actor.ts";
import { domainSuffixes, isBlockedBy } from "../src/federation/blocks.ts";
import { outboxCursor, parseOutboxCursor } from "../src/federation/collections.ts";
import { hostOf } from "../src/federation/ids.ts";
import {
  checkInbox,
  dateRefusal,
  isActivityContentType,
  storedHeaders,
  type InboxOutcome,
  type InboxSeams,
} from "../src/federation/inbox.ts";
import { FEDERATION_LOCALES, federationMessage } from "../src/federation/messages.ts";
import { nodeinfo, nodeinfoLinks } from "../src/federation/nodeinfo.ts";
import { actorDeleteActivity } from "../src/federation/settings.ts";
import { buildJrd, parseWebfingerResource } from "../src/federation/webfinger.ts";
import mastodonActor from "./fixtures/federation/mastodon-actor.json" with { type: "json" };
import mastodonFollow from "./fixtures/federation/mastodon-follow.json" with { type: "json" };
import mastodonJrd from "./fixtures/federation/mastodon-webfinger.json" with { type: "json" };

const site = {
  publicUrl: "https://streams.example",
  name: "Streams Example",
  defaultLocale: "en",
  sourceUrl: "https://git.example/commonair",
};
const ID = "0192f000-0000-7000-8000-000000000001";
const ACTOR = `https://streams.example/ap/channels/${ID}`;

describe("WebFinger resource parsing", () => {
  test("acct forms, case-insensitive, our domain only", () => {
    const ok = { kind: "slug", slug: "alice_1" };
    expect(parseWebfingerResource("acct:alice_1@streams.example", site)).toEqual(ok);
    expect(parseWebfingerResource("ACCT:Alice_1@Streams.Example", site)).toEqual(ok);
    expect(parseWebfingerResource("acct:@alice_1@streams.example", site)).toEqual(ok);
    expect(parseWebfingerResource("alice_1@streams.example", site)).toEqual(ok);
    expect(parseWebfingerResource("acct:alice_1@streams.example.", site)).toEqual(ok);
    expect(parseWebfingerResource(" acct:alice_1@streams.example ", site)).toEqual(ok);
  });

  test("a foreign domain, a look-alike or a malformed resource is null", () => {
    for (const r of [
      "acct:alice_1@other.example",
      "acct:alice_1@streams.example.evil",
      "acct:alice_1@evilstreams.example",
      "acct:alice_1",
      "acct:@streams.example",
      "acct:al@streams.example",
      "acct:alice-1@streams.example",
      "acct:alice/../x@streams.example",
      "",
      null,
      `acct:${"a".repeat(600)}@streams.example`,
    ])
      expect([r, parseWebfingerResource(r, site)]).toEqual([r, null]);
  });

  test("the domain includes a non-default port", () => {
    const local = { publicUrl: "http://127.0.0.1:8080" };
    expect(parseWebfingerResource("acct:bob_x@127.0.0.1:8080", local)).toEqual({ kind: "slug", slug: "bob_x" });
    expect(parseWebfingerResource("acct:bob_x@127.0.0.1", local)).toBeNull();
  });

  test("the actor id is accepted; other URLs are not", () => {
    expect(parseWebfingerResource(ACTOR, site)).toEqual({ kind: "actor", channelId: ID });
    expect(
      parseWebfingerResource(ACTOR.toUpperCase().replace("HTTPS://STREAMS.EXAMPLE", "https://streams.example"), site),
    ).toBeNull();
    expect(parseWebfingerResource(`https://other.example/ap/channels/${ID}`, site)).toBeNull();
    expect(parseWebfingerResource(`${ACTOR}/outbox`, site)).toBeNull();
    expect(parseWebfingerResource(`${ACTOR}?x=1`, site)).toBeNull();
    expect(parseWebfingerResource("https://streams.example/ap/channels/not-a-uuid", site)).toBeNull();
    expect(parseWebfingerResource("http://streams.example/ap/channels/" + ID, site)).toBeNull();
  });

  test("the JRD has Mastodon's shape: subject, aliases, self and profile-page links", () => {
    const jrd = buildJrd(site, "alice_1", ID);
    expect(jrd.subject).toBe("acct:alice_1@streams.example");
    expect(Object.keys(jrd).sort()).toEqual(Object.keys(mastodonJrd).sort());
    const rels = (l: { rel: string; type: string }[]) => l.map((x) => `${x.rel} ${x.type}`).sort();
    expect(rels(jrd.links)).toEqual(rels(mastodonJrd.links));
    expect(jrd.links.find((l) => l.rel === "self")?.href).toBe(ACTOR);
    expect(jrd.aliases).toContain(ACTOR);
  });
});

const input = (over: Partial<ActorInput> = {}): ActorInput => ({
  channelId: ID,
  slug: "alice_1",
  displayName: "Alice",
  description: "Speedruns <b>daily</b>.\n\nSecond line & more",
  mature: false,
  avatarUrl: "https://media.streams.example/a.png",
  bannerUrl: "https://media.streams.example/b.png",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
  publishedAt: new Date("2026-01-02T03:04:05.000Z"),
  ...over,
});

/** The type of each field at `path`, for comparing shapes rather than values. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return "array";
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "mediaType")
        .map(([k, x]) => [k, shape(x)]),
    );
  return typeof v;
}

describe("actor document", () => {
  test("every field Mastodon reads from a Service actor, with the same types", () => {
    const doc = buildActorDocument(site, input()) as unknown as Record<string, unknown>;
    const fixture = mastodonActor as Record<string, unknown>;
    // Mastodon's own extras (following, discoverable) are optional for a remote actor.
    const required = [
      "@context",
      "id",
      "type",
      "followers",
      "inbox",
      "outbox",
      "preferredUsername",
      "name",
      "summary",
      "url",
      "manuallyApprovesFollowers",
      "published",
      "publicKey",
      "endpoints",
      "icon",
      "image",
    ];
    for (const k of required) expect([k, shape(doc[k])]).toEqual([k, shape(fixture[k])]);
    expect(doc.type).toBe(fixture.type);
    expect((doc["@context"] as string[]).slice(0, 2)).toEqual((fixture["@context"] as unknown[]).slice(0, 2));
  });

  test("ids, links and the key", () => {
    const doc = buildActorDocument(site, input());
    expect(doc).toMatchObject({
      id: ACTOR,
      type: "Service",
      preferredUsername: "alice_1",
      name: "Alice",
      url: "https://streams.example/alice_1",
      inbox: `${ACTOR}/inbox`,
      outbox: `${ACTOR}/outbox`,
      followers: `${ACTOR}/followers`,
      endpoints: { sharedInbox: "https://streams.example/ap/inbox" },
      publicKey: { id: `${ACTOR}#main-key`, owner: ACTOR },
      published: "2026-01-02T03:04:05.000Z",
      icon: { type: "Image", url: "https://media.streams.example/a.png" },
      image: { type: "Image", url: "https://media.streams.example/b.png" },
    });
    expect(doc.publicKey.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  test("summary: the streamer's text escaped, then the catalog's notice", () => {
    const doc = buildActorDocument(site, input());
    expect(doc.summary).toBe(
      "<p>Speedruns &lt;b&gt;daily&lt;/b&gt;.</p><p>Second line &amp; more</p>" +
        `<p>${federationMessage("en", "repliesNotRead", { instance: "Streams Example" })}</p>`,
    );
    expect(actorSummary("", "N")).toBe("<p>N</p>");
    expect(actorSummary("a\nb", "N")).toBe("<p>a<br>b</p><p>N</p>");
    const es = buildActorDocument({ ...site, defaultLocale: "es-MX" }, input({ description: "" }));
    expect(es.summary).toBe(`<p>${federationMessage("es", "repliesNotRead", { instance: "Streams Example" })}</p>`);
  });

  test("mature channels publish no icon and no image", () => {
    const doc = buildActorDocument(site, input({ mature: true }));
    expect(doc).not.toHaveProperty("icon");
    expect(doc).not.toHaveProperty("image");
    expect(JSON.stringify(doc)).not.toContain("media.streams.example");
  });

  test("no avatar or banner: the fields are left out, never null", () => {
    const doc = buildActorDocument(site, input({ avatarUrl: null, bannerUrl: null }));
    expect(doc).not.toHaveProperty("icon");
    expect(doc).not.toHaveProperty("image");
  });

  test("no personal data: only the public channel fields", () => {
    const keys = Object.keys(buildActorDocument(site, input())).sort();
    expect(keys).toEqual(
      [
        "@context",
        "id",
        "type",
        "preferredUsername",
        "name",
        "summary",
        "url",
        "inbox",
        "outbox",
        "followers",
        "endpoints",
        "manuallyApprovesFollowers",
        "published",
        "icon",
        "image",
        "publicKey",
      ].sort(),
    );
  });

  test("content negotiation: AP types get JSON, a browser gets the page", () => {
    expect(wantsActivityJson("application/activity+json")).toBe(true);
    expect(wantsActivityJson('application/ld+json; profile="https://www.w3.org/ns/activitystreams"')).toBe(true);
    expect(wantsActivityJson("text/html, application/activity+json;q=0.9")).toBe(true);
    expect(wantsActivityJson(null)).toBe(true);
    expect(wantsActivityJson("*/*")).toBe(true);
    expect(wantsActivityJson("application/json")).toBe(true);
    expect(wantsActivityJson("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(wantsActivityJson("text/html, application/activity+json;q=0")).toBe(false);
  });
});

describe("domain blocks", () => {
  test("a block covers the domain and its subdomains, case-insensitively", () => {
    const blocks = ["bad.example"];
    expect(isBlockedBy("bad.example", blocks)).toBe("bad.example");
    expect(isBlockedBy("BAD.Example", blocks)).toBe("bad.example");
    expect(isBlockedBy("a.b.bad.example", blocks)).toBe("bad.example");
    expect(isBlockedBy("bad.example.", blocks)).toBe("bad.example");
    expect(isBlockedBy("Bad.Example", ["BAD.EXAMPLE"])).toBe("bad.example");
  });

  test("never a look-alike, a parent or a sibling", () => {
    const blocks = ["bad.example"];
    expect(isBlockedBy("notbad.example", blocks)).toBeNull();
    expect(isBlockedBy("example", blocks)).toBeNull();
    expect(isBlockedBy("bad.example.org", blocks)).toBeNull();
    expect(isBlockedBy("good.example", blocks)).toBeNull();
    expect(isBlockedBy("bad.example", [])).toBeNull();
  });

  test("suffixes", () => {
    expect(domainSuffixes("A.b.Example")).toEqual(["a.b.example", "b.example", "example"]);
    expect(domainSuffixes("")).toEqual([]);
  });

  test("hosts of actor URLs", () => {
    expect(hostOf("https://Mastodon.Example:8443/users/x")).toBe("mastodon.example");
    expect(hostOf("https://xn--bcher-kva.example/u")).toBe("xn--bcher-kva.example");
    expect(hostOf("https://bücher.example/u")).toBe("xn--bcher-kva.example");
    expect(hostOf("ftp://x.example/")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("inbox cheap checks", () => {
  const NOW = new Date("2026-11-01T12:00:00.000Z");
  const httpDate = (d: Date) => d.toUTCString();
  const sig = (keyId: string) =>
    `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="c2lnbmF0dXJl"`;

  interface Opts {
    body?: string;
    headers?: Record<string, string>;
    blocked?: string[];
    limited?: boolean;
    addressLimited?: boolean;
    maxBytes?: number;
    allowHttp?: boolean;
  }
  async function run(
    o: Opts = {},
  ): Promise<{ out: InboxOutcome; stored: { headers: Record<string, string>; body: string }[]; calls: string[] }> {
    const stored: { headers: Record<string, string>; body: string }[] = [];
    const calls: string[] = [];
    const seams: InboxSeams = {
      now: NOW,
      maxBytes: o.maxBytes ?? FEDERATION_RULES.inboxMaxBytes,
      skewSeconds: FEDERATION_RULES.dateSkewSeconds,
      allowHttp: o.allowHttp ?? false,
      blockFor: async (host) => {
        calls.push("block");
        return isBlockedBy(host, o.blocked ?? []);
      },
      addressLimit: async () => {
        calls.push("address");
        return { allowed: !o.addressLimited, retryAfterSeconds: o.addressLimited ? 3 : 0 };
      },
      rateLimit: async () => {
        calls.push("domain");
        return { allowed: !o.limited, retryAfterSeconds: o.limited ? 7 : 0 };
      },
      store: async (item) => {
        stored.push(item);
        return "0192f000-0000-7000-8000-0000000000aa";
      },
    };
    const req = new Request(`https://streams.example/ap/channels/${ID}/inbox`, {
      method: "POST",
      headers: {
        "content-type": "application/activity+json",
        date: httpDate(NOW),
        host: "streams.example",
        signature: sig("https://mastodon.example/users/alice#main-key"),
        ...o.headers,
      },
      body: o.body ?? JSON.stringify(mastodonFollow),
    });
    return { out: await checkInbox(req, `/ap/channels/${ID}/inbox`, seams), stored, calls };
  }
  const refused = (out: InboxOutcome) => (out.kind === "refused" ? [out.reason, out.status] : out.kind);

  test("a Mastodon Follow passes and is stored with its headers", async () => {
    const { out, stored } = await run();
    expect(out).toEqual({ kind: "stored", itemId: "0192f000-0000-7000-8000-0000000000aa", type: "Follow" });
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.body)).toEqual(mastodonFollow);
    expect(stored[0]!.headers).toMatchObject({
      "(request-target)": `post /ap/channels/${ID}/inbox`,
      host: "streams.example",
      date: httpDate(NOW),
    });
  });

  test("Undo and Delete pass; ld+json with a profile is accepted", async () => {
    for (const type of ["Undo", "Delete"]) {
      const { out } = await run({ body: JSON.stringify({ ...mastodonFollow, type }) });
      expect(out.kind).toBe("stored");
    }
    const ld = await run({
      headers: { "content-type": 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
    });
    expect(ld.out.kind).toBe("stored");
  });

  test("other types: 202 and dropped, never stored, before any other check", async () => {
    for (const type of ["Create", "Like", "Announce", "Update", "Move", "Flag"]) {
      const { out, stored } = await run({
        body: JSON.stringify({ ...mastodonFollow, type }),
        headers: { signature: "", date: "nonsense" },
        blocked: ["mastodon.example"],
      });
      expect(out).toEqual({ kind: "dropped", type });
      expect(stored).toHaveLength(0);
    }
  });

  test("content type", async () => {
    for (const ct of ["application/json", "text/plain", ""]) {
      const { out, stored } = await run({ headers: { "content-type": ct } });
      expect(refused(out)).toEqual(["unsupported_media_type", 415]);
      expect(stored).toHaveLength(0);
    }
    expect(isActivityContentType("Application/Activity+JSON; charset=utf-8")).toBe(true);
  });

  test("body size: over the cap by declared length or by bytes read", async () => {
    const big = JSON.stringify({ ...mastodonFollow, pad: "x".repeat(300) });
    expect(refused((await run({ body: big, maxBytes: 256 })).out)).toEqual(["too_large", 413]);
    expect(refused((await run({ body: big, maxBytes: 256, headers: { "content-length": "999999999" } })).out)).toEqual([
      "too_large",
      413,
    ]);
    expect((await run({ maxBytes: 4096 })).out.kind).toBe("stored");
  });

  test("not JSON, not an object, no type, or no actor: malformed", async () => {
    for (const body of [
      "{",
      "[]",
      "null",
      '"Follow"',
      JSON.stringify({ actor: mastodonFollow.actor }),
      JSON.stringify({ type: 3, actor: mastodonFollow.actor }),
      JSON.stringify({ ...mastodonFollow, actor: undefined }),
      JSON.stringify({ ...mastodonFollow, actor: "not a url" }),
    ])
      expect([body, refused((await run({ body })).out)]).toEqual([body, ["malformed", 400]]);
  });

  test("an actor given as an object uses its id", async () => {
    const body = JSON.stringify({ ...mastodonFollow, actor: { id: mastodonFollow.actor, type: "Person" } });
    expect((await run({ body })).out.kind).toBe("stored");
  });

  test("no or malformed Signature: 401", async () => {
    expect(refused((await run({ headers: { signature: "" } })).out)).toEqual(["missing_signature", 401]);
    expect(refused((await run({ headers: { signature: "garbage" } })).out)).toEqual(["missing_signature", 401]);
  });

  test("keyId host must equal the actor host", async () => {
    const other = await run({ headers: { signature: sig("https://evil.example/users/alice#main-key") } });
    expect(refused(other.out)).toEqual(["key_actor_mismatch", 401]);
    const sub = await run({ headers: { signature: sig("https://keys.mastodon.example/alice#main-key") } });
    expect(refused(sub.out)).toEqual(["key_actor_mismatch", 401]);
    const notUrl = await run({ headers: { signature: sig("alice-key") } });
    expect(refused(notUrl.out)).toEqual(["key_actor_mismatch", 401]);
    const caseOnly = await run({ headers: { signature: sig("https://MASTODON.example/users/alice#main-key") } });
    expect(caseOnly.out.kind).toBe("stored");
  });

  test("an http: actor is refused unless private networks are allowed", async () => {
    const body = JSON.stringify({ ...mastodonFollow, actor: "http://mastodon.example/users/alice" });
    const signature = sig("http://mastodon.example/users/alice#main-key");
    expect(refused((await run({ body, headers: { signature } })).out)).toEqual(["insecure_actor", 400]);
    expect((await run({ body, headers: { signature }, allowHttp: true })).out.kind).toBe("stored");
  });

  test("blocked domain or subdomain: 403", async () => {
    expect(refused((await run({ blocked: ["mastodon.example"] })).out)).toEqual(["blocked", 403]);
    expect(refused((await run({ blocked: ["example"] })).out)).toEqual(["blocked", 403]);
    expect((await run({ blocked: ["other.example"] })).out.kind).toBe("stored");
  });

  test("Date: an HTTP-date within the skew", async () => {
    const at = (s: number) => httpDate(new Date(NOW.getTime() + s * 1000));
    expect(refused((await run({ headers: { date: "" } })).out)).toEqual(["bad_date", 401]);
    expect(refused((await run({ headers: { date: NOW.toISOString() } })).out)).toEqual(["bad_date", 401]);
    expect(refused((await run({ headers: { date: at(-DATE_SKEW_SECONDS - 1) } })).out)).toEqual(["date_skew", 401]);
    expect(refused((await run({ headers: { date: at(3601) } })).out)).toEqual(["date_skew", 401]);
    expect((await run({ headers: { date: at(-DATE_SKEW_SECONDS + 5) } })).out.kind).toBe("stored");
    expect((await run({ headers: { date: at(3500) } })).out.kind).toBe("stored");
    expect(dateRefusal(at(0), NOW, 60)).toBeNull();
    expect(dateRefusal(at(-61), NOW, 60)).toBe("date_skew");
    expect(dateRefusal(at(61), NOW, 60)).toBe("date_skew");
  });

  test("per-domain rate limit: 429 with retry-after", async () => {
    const { out, stored } = await run({ limited: true });
    expect(out).toEqual({ kind: "refused", reason: "rate_limited", status: 429, retryAfterSeconds: 7 });
    expect(stored).toHaveLength(0);
  });

  test("per-address limit: counted first, before any lookup or the domain's bucket", async () => {
    const { out, stored, calls } = await run({ addressLimited: true });
    expect(out).toEqual({ kind: "refused", reason: "rate_limited", status: 429, retryAfterSeconds: 3 });
    expect(stored).toHaveLength(0);
    expect(calls).toEqual(["address"]);
    expect((await run()).calls).toEqual(["address", "block", "domain"]);
  });

  test("a signed header the item cannot keep whole is refused, not truncated", async () => {
    const long = `SHA-256=${"a".repeat(5000)}`;
    expect(refused((await run({ headers: { digest: long } })).out)).toEqual(["malformed", 400]);
    const signsCookie = await run({
      headers: {
        cookie: "s=1",
        signature: `keyId="https://mastodon.example/users/alice#main-key",headers="(request-target) date cookie",signature="c2ln"`,
      },
    });
    expect(refused(signsCookie.out)).toEqual(["malformed", 400]);
    // An unsigned header that long is only cut.
    const { out, stored } = await run({ headers: { "x-note": long } });
    expect(out.kind).toBe("stored");
    expect(stored[0]!.headers["x-note"]).toHaveLength(4096);
  });

  test("signed and essential headers survive the header cap", () => {
    const extra = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`x-h${i}`, "v"]));
    const req = new Request("https://streams.example/ap/inbox", {
      method: "POST",
      headers: { ...extra, "x-signed": "kept", date: "d", digest: "SHA-256=abc", signature: "sig", host: "h" },
    });
    const h = storedHeaders(req, "/ap/inbox", ["(request-target)", "x-signed", "date"]);
    expect(h).toMatchObject({ "x-signed": "kept", date: "d", digest: "SHA-256=abc", signature: "sig", host: "h" });
    expect(Object.keys(h).filter((k) => k.startsWith("x-h"))).toHaveLength(64);
  });

  test("stored headers never keep cookies, credentials or client addresses", () => {
    const req = new Request("https://streams.example/ap/inbox", {
      method: "POST",
      headers: {
        cookie: "s=1",
        authorization: "Bearer x",
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
        forwarded: "for=203.0.113.9",
        "cf-connecting-ip": "203.0.113.9",
        digest: "SHA-256=abc",
        "user-agent": "Mastodon/4.3",
      },
    });
    const h = storedHeaders(req, "/ap/inbox?x=1");
    expect(h["(request-target)"]).toBe("post /ap/inbox?x=1");
    expect(h.digest).toBe("SHA-256=abc");
    expect(JSON.stringify(h)).not.toContain("203.0.113.9");
    for (const k of ["cookie", "authorization", "x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip"])
      expect(h).not.toHaveProperty(k);
  });
});

describe("NodeInfo", () => {
  test("software, protocol and registrations; usage carries no counts", () => {
    const doc = nodeinfo(site, "1.2.3");
    expect(doc).toMatchObject({
      version: "2.1",
      software: { version: "1.2.3", repository: "https://git.example/commonair" },
      protocols: ["activitypub"],
      openRegistrations: true,
      usage: { users: {} },
    });
    expect(doc.software.name).toMatch(/^[a-z0-9-]+$/);
    expect(JSON.stringify(doc.usage)).not.toMatch(/\d/);
    expect(doc.usage).not.toHaveProperty("localPosts");
    expect(nodeinfoLinks(site).links).toEqual([
      { rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: "https://streams.example/nodeinfo/2.1" },
    ]);
  });
});

describe("misc", () => {
  test("the catalog has en and es for every key, with the same placeholders", () => {
    expect(FEDERATION_LOCALES.sort()).toEqual(["en", "es"]);
    const en = federationMessage("en", "repliesNotRead", { instance: "X" });
    const es = federationMessage("es", "repliesNotRead", { instance: "X" });
    expect(en).toContain("X");
    expect(es).toContain("X");
    expect(es).not.toBe(en);
    expect(federationMessage("fr", "repliesNotRead", { instance: "X" })).toBe(en);
    expect(federationMessage("es-AR", "repliesNotRead", { instance: "X" })).toBe(es);
  });

  test("outbox cursors round-trip; junk is ignored", () => {
    const c = { publishedAt: new Date("2026-10-01T00:00:00.000Z"), id: ID };
    expect(parseOutboxCursor(outboxCursor(c))).toEqual({ t: c.publishedAt, id: ID });
    for (const bad of [null, "", "x", "1_x", `1_${ID}${ID}`, `${"9".repeat(20)}_${ID}`])
      expect(parseOutboxCursor(bad)).toBeNull();
  });

  test("the actor Delete addresses the public and names the actor", () => {
    expect(actorDeleteActivity(ACTOR, "abc")).toEqual({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${ACTOR}#delete-abc`,
      type: "Delete",
      actor: ACTOR,
      object: ACTOR,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    });
  });
});
