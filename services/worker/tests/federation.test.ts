// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** N4-delivery's pure helpers: block matching, local actor ids, remote documents, job ids, config. */
import { describe, expect, test } from "vite-plus/test";
import { federationConfig, federationEnvSlice, hostOf, mediaUrl } from "../src/federation/config.ts";
import { deliverJobId, retiredKeyStashKey } from "../src/federation/deliver.ts";
import { inboxPath } from "../src/federation/inbox.ts";
import { domainMatches, isBlocked, localChannelIdOf } from "../src/federation/local.ts";
import { actorFromDocument, keyFromDocument, remoteKeyCacheKey } from "../src/federation/remote.ts";

const CH = "0192a7c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b";
const ALICE = "https://mastodon.example/users/alice";
const KEY = `${ALICE}#main-key`;
const PEM = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n";

describe("domain blocks", () => {
  test("a block matches the domain and its subdomains, case- and port-insensitively", () => {
    expect(domainMatches("evil.example", "evil.example")).toBe(true);
    expect(domainMatches("A.Evil.Example", "evil.example")).toBe(true);
    expect(domainMatches("evil.example:8443", "evil.example")).toBe(true);
    expect(domainMatches("evil.example.", "EVIL.example")).toBe(true);
    expect(domainMatches("notevil.example", "evil.example")).toBe(false);
    expect(domainMatches("evil.example.com", "evil.example")).toBe(false);
  });

  test("isBlocked checks every URL's host; an unparseable URL counts as blocked", () => {
    expect(isBlocked(["evil.example"], "https://ok.example/u", "https://x.evil.example/k#main-key")).toBe(true);
    expect(isBlocked(["evil.example"], "https://ok.example/u")).toBe(false);
    expect(isBlocked([], "not a url")).toBe(true);
  });
});

describe("local actor ids", () => {
  const cfg = { site: { publicUrl: "https://air.example", defaultLocale: "en" } };
  test("only this instance's channel actor ids map to a channel", () => {
    expect(localChannelIdOf(cfg, `https://air.example/ap/channels/${CH}`)).toBe(CH);
    expect(localChannelIdOf(cfg, `https://air.example/ap/channels/${CH.toUpperCase()}`)).toBe(CH);
    expect(localChannelIdOf(cfg, `https://other.example/ap/channels/${CH}`)).toBeNull();
    expect(localChannelIdOf(cfg, `https://air.example/ap/channels/${CH}/inbox`)).toBeNull();
    expect(localChannelIdOf(cfg, "https://air.example/ap/channels/slug")).toBeNull();
  });
  test("inbox paths are the API's routes", () => {
    expect(inboxPath(CH)).toBe(`/ap/channels/${CH}/inbox`);
    expect(inboxPath(null)).toBe("/ap/inbox");
  });
});

describe("remote documents", () => {
  test("a key from a Mastodon actor document (owner defaults to the actor)", () => {
    expect(keyFromDocument(KEY, { id: ALICE, publicKey: { id: KEY, owner: ALICE, publicKeyPem: PEM } })).toEqual({
      keyId: KEY,
      owner: ALICE,
      publicKeyPem: PEM,
    });
    expect(keyFromDocument(KEY, { id: ALICE, publicKey: [{ id: "other" }, { id: KEY, publicKeyPem: PEM }] })).toEqual({
      keyId: KEY,
      owner: ALICE,
      publicKeyPem: PEM,
    });
  });
  test("a bare key document needs its owner", () => {
    expect(keyFromDocument(KEY, { id: KEY, owner: ALICE, publicKeyPem: PEM })?.owner).toBe(ALICE);
    expect(keyFromDocument(KEY, { id: KEY, publicKeyPem: PEM })).toBeNull();
  });
  test("a document without the named key, or with an oversized PEM, holds no key", () => {
    expect(keyFromDocument(KEY, { id: ALICE, publicKey: { id: `${ALICE}#other`, publicKeyPem: PEM } })).toBeNull();
    expect(keyFromDocument(KEY, { id: KEY, owner: ALICE, publicKeyPem: "x".repeat(20_000) })).toBeNull();
    expect(keyFromDocument(KEY, null)).toBeNull();
  });
  test("an actor's inbox and shared inbox must be on its own origin", () => {
    const doc = {
      id: ALICE,
      type: "Person",
      preferredUsername: "alice",
      inbox: `${ALICE}/inbox`,
      endpoints: { sharedInbox: "https://mastodon.example/inbox" },
    };
    expect(actorFromDocument(ALICE, doc)).toEqual({
      id: ALICE,
      inbox: `${ALICE}/inbox`,
      sharedInbox: "https://mastodon.example/inbox",
      handle: "@alice@mastodon.example",
      domain: "mastodon.example",
    });
    expect(actorFromDocument(ALICE, { ...doc, inbox: "https://elsewhere.example/inbox" })).toBeNull();
    expect(
      actorFromDocument(ALICE, { ...doc, endpoints: { sharedInbox: "https://elsewhere.example/inbox" } })?.sharedInbox,
    ).toBeNull();
    expect(actorFromDocument(ALICE, { ...doc, id: "https://mastodon.example/users/bob" })).toBeNull();
    expect(actorFromDocument(ALICE, { ...doc, preferredUsername: "<b>" })?.handle).toBeNull();
    expect(actorFromDocument(ALICE, { ...doc, inbox: "javascript:alert(1)" })).toBeNull();
  });
  test("cache keys hash the keyId (a stranger's URL)", async () => {
    const k = await remoteKeyCacheKey(KEY);
    expect(k).toMatch(/^federation:remote-key:[0-9a-f]{64}$/);
    expect(k).not.toContain("mastodon");
  });
});

describe("delivery job ids", () => {
  test("deterministic per activity, inbox and attempt, with no colon", async () => {
    const a = await deliverJobId("https://air.example/ap/objects/1/activity", "https://m.example/inbox", 1);
    expect(a).toBe(await deliverJobId("https://air.example/ap/objects/1/activity", "https://m.example/inbox", 1));
    expect(a).not.toBe(await deliverJobId("https://air.example/ap/objects/1/activity", "https://m.example/inbox", 2));
    expect(a).not.toBe(await deliverJobId("https://air.example/ap/objects/1/activity", "https://n.example/inbox", 1));
    expect(a).toMatch(/^federation-deliver-[0-9a-f]{40}-1$/);
    expect(retiredKeyStashKey(CH)).toBe(`federation:retired-key:${CH}`);
  });
});

describe("config", () => {
  test("reads the flags through loadEnv; blank values fall back to the defaults (off)", () => {
    const env = federationEnvSlice({ FEDERATION_ENABLED: "", OUTBOUND_ALLOW_PRIVATE_NETWORKS: "" });
    expect(env.FEDERATION_ENABLED).toBe(false);
    expect(env.OUTBOUND_ALLOW_PRIVATE_NETWORKS).toBe(false);
    const on = federationEnvSlice({ FEDERATION_ENABLED: "true", OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true" });
    const cfg = federationConfig({ webhooks: { authSecret: "s".repeat(32) } as never }, on);
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowInsecure).toBe(true);
    expect(cfg.maxAttempts).toBe(5);
  });
  test("the inbox hosts are the public origin and the API's", () => {
    const env = federationEnvSlice({
      PUBLIC_URL: "https://air.example",
      API_PUBLIC_URL: "https://api.air.example",
      MEDIA_PUBLIC_URL: "https://media.air.example/media",
    });
    const cfg = federationConfig({ webhooks: { authSecret: "s".repeat(32) } as never }, env);
    expect([...cfg.inboxHosts].sort()).toEqual(["air.example", "api.air.example"]);
    expect(cfg.site.publicUrl).toBe("https://air.example");
    expect(mediaUrl(cfg, "thumbs/a b/x.jpg")).toBe("https://media.air.example/media/thumbs/a%20b/x.jpg");
    expect(mediaUrl(cfg, "https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
    expect(mediaUrl(cfg, null)).toBeNull();
    expect(hostOf("HTTP://Air.Example:8080/x")).toBe("air.example:8080");
  });
});
