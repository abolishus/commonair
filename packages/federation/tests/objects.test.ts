// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Objects and activities (ADR 0030 decisions 3, 7 and 9) against Mastodon-shaped fixtures: the
 * documented outbound shapes Mastodon reads (`tests/fixtures/mastodon.ts`), the mature rules, no
 * clipper, and a schema test that no object carries a field that could hold personal data.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  acceptActivity,
  ACTOR_CONTEXT,
  actorUrls,
  AS2_CONTEXT,
  AS2_PUBLIC,
  channelPageUrl,
  classifyInbound,
  clipPageUrl,
  createActivity,
  deleteActorActivity,
  deleteObjectActivity,
  escapeHtml,
  federationText,
  FEDERATION_TEXT,
  goLiveNote,
  idOf,
  imageMediaType,
  isoDuration,
  mediaVideo,
  objectUrl,
  serviceActor,
  updateServiceActivity,
  vodPageUrl,
} from "../src/index.ts";
import { MASTODON_INBOUND, MASTODON_NOTE_KEYS, MASTODON_VIDEO_KEYS } from "./fixtures/mastodon.ts";

const ORIGIN = "https://air.example";
const CHANNEL = "0192a7c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b";
const OBJECT = "0192a7c4-5b6d-7e8f-9a0b-aaaaaaaaaaaa";
const urls = actorUrls(ORIGIN, CHANNEL);
const PUBLISHED = new Date("2026-11-01T12:00:00.000Z");
const THUMB = "https://media.air.example/media/thumbs/b1/latest.jpg";

const note = (over: Partial<Parameters<typeof goLiveNote>[0]> = {}) =>
  goLiveNote({
    id: objectUrl(ORIGIN, OBJECT),
    actor: urls,
    channelName: "Synth Club",
    channelUrl: channelPageUrl(ORIGIN, "synthclub"),
    title: "Late night synths",
    category: "Music",
    thumbnailUrl: THUMB,
    mature: false,
    published: PUBLISHED,
    locale: "en",
    ...over,
  });

const video = (over: Partial<Parameters<typeof mediaVideo>[0]> = {}) =>
  mediaVideo({
    id: objectUrl(ORIGIN, OBJECT),
    actor: urls,
    channelName: "Synth Club",
    title: "Highlights",
    durationSeconds: 754.4,
    watchUrl: vodPageUrl(ORIGIN, "synthclub", OBJECT),
    thumbnailUrl: THUMB,
    mature: false,
    published: PUBLISHED,
    locale: "en",
    ...over,
  });

const actorInput = (over: Partial<Parameters<typeof serviceActor>[0]> = {}) => ({
  urls,
  slug: "synthclub",
  displayName: "Synth Club",
  description: "Modular <b>synths</b>",
  channelUrl: channelPageUrl(ORIGIN, "synthclub"),
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
  avatarUrl: "https://media.air.example/media/avatars/a.png",
  bannerUrl: "https://media.air.example/media/banners/b.webp",
  mature: false,
  locale: "en",
  ...over,
});

describe("urls", () => {
  test("the actor id is built from the channel id, never the slug (decision 2)", () => {
    expect(urls).toEqual({
      id: `${ORIGIN}/ap/channels/${CHANNEL}`,
      keyId: `${ORIGIN}/ap/channels/${CHANNEL}#main-key`,
      inbox: `${ORIGIN}/ap/channels/${CHANNEL}/inbox`,
      outbox: `${ORIGIN}/ap/channels/${CHANNEL}/outbox`,
      followers: `${ORIGIN}/ap/channels/${CHANNEL}/followers`,
      sharedInbox: `${ORIGIN}/ap/inbox`,
    });
    expect(actorUrls(`${ORIGIN}///`, CHANNEL)).toEqual(urls);
    expect(objectUrl(`${ORIGIN}/`, OBJECT)).toBe(`${ORIGIN}/ap/objects/${OBJECT}`);
  });

  test("home pages follow the web routes", () => {
    expect(channelPageUrl(ORIGIN, "synthclub")).toBe(`${ORIGIN}/synthclub`);
    expect(vodPageUrl(ORIGIN, "synthclub", "v1")).toBe(`${ORIGIN}/synthclub/vods/v1`);
    expect(clipPageUrl(ORIGIN, "synthclub", "c1")).toBe(`${ORIGIN}/synthclub/clips/c1`);
  });
});

describe("go-live Note", () => {
  test("has the Mastodon shape: title, category, channel link and thumbnail, addressed to Public and followers", () => {
    const n = note();
    expect(Object.keys(n).sort()).toEqual([...MASTODON_NOTE_KEYS].sort());
    expect(n).toEqual({
      id: `${ORIGIN}/ap/objects/${OBJECT}`,
      type: "Note",
      attributedTo: urls.id,
      published: "2026-11-01T12:00:00.000Z",
      url: `${ORIGIN}/synthclub`,
      to: [AS2_PUBLIC],
      cc: [urls.followers],
      content:
        '<p>Synth Club is live: Late night synths</p><p>Category: Music</p><p><a href="https://air.example/synthclub">https://air.example/synthclub</a></p>',
      sensitive: false,
      attachment: [{ type: "Image", url: THUMB, mediaType: "image/jpeg", name: "Late night synths" }],
    });
  });

  test("streamer text is escaped and an empty title or category is left out", () => {
    const n = note({ channelName: "<script>", title: "  ", category: null, thumbnailUrl: null });
    expect(n.content).toBe(
      '<p>&lt;script&gt; is live</p><p><a href="https://air.example/synthclub">https://air.example/synthclub</a></p>',
    );
    expect(n.attachment).toEqual([]);
    expect(note({ title: 'a "b" & <c>' }).content).toContain("a &quot;b&quot; &amp; &lt;c&gt;");
  });

  test("mature: no thumbnail, sensitive, and the catalog's content warning", () => {
    const n = note({ mature: true });
    expect(n.attachment).toEqual([]);
    expect(n.sensitive).toBe(true);
    expect(n.summary).toBe(FEDERATION_TEXT.en.mature);
    expect(JSON.stringify(n)).not.toContain(THUMB);
    expect(note({ mature: true, locale: "es-MX" }).summary).toBe(FEDERATION_TEXT.es.mature);
  });

  test("the locale picks the catalog, English when unknown", () => {
    expect(note({ locale: "es" }).content).toContain("Synth Club está en directo");
    expect(note({ locale: "xx" }).content).toContain("Synth Club is live");
  });
});

describe("Video", () => {
  test("has the Mastodon/PeerTube shape: name, duration, thumbnail and a watch-page url", () => {
    const v = video();
    expect(Object.keys(v).sort()).toEqual([...MASTODON_VIDEO_KEYS].sort());
    expect(v.type).toBe("Video");
    expect(v.name).toBe("Highlights");
    expect(v.duration).toBe("PT754S");
    expect(v.url).toEqual([{ type: "Link", mediaType: "text/html", href: `${ORIGIN}/synthclub/vods/${OBJECT}` }]);
    expect(v.icon).toEqual({ type: "Image", url: THUMB, mediaType: "image/jpeg", name: "Highlights" });
    expect(v.attachment).toEqual([v.icon]);
    expect(v.to).toEqual([AS2_PUBLIC]);
    expect(v.cc).toEqual([urls.followers]);
    expect(v.attributedTo).toBe(urls.id);
  });

  test("never carries a media URL: no playlist, segment or stream link", () => {
    const text = JSON.stringify(video());
    for (const bad of [".m3u8", ".m4s", '.ts"', "/vod/", "/live/", "rtmp", "playlist"]) expect(text).not.toContain(bad);
  });

  test("a clip names no clipper: attributed to the channel actor only", () => {
    const v = video({ watchUrl: clipPageUrl(ORIGIN, "synthclub", OBJECT), title: "Wow" });
    expect(v.attributedTo).toBe(urls.id);
    const keys = new Set<string>();
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object")
        for (const [k, val] of Object.entries(x)) {
          keys.add(k);
          walk(val);
        }
    };
    walk(v);
    for (const k of ["creator", "creatorId", "clipper", "author", "generator"]) expect(keys.has(k)).toBe(false);
  });

  test("mature: no thumbnail or icon, sensitive with a warning; an untitled video is named after the channel", () => {
    const v = video({ mature: true, title: " " });
    expect(v.icon).toBeUndefined();
    expect(v.attachment).toEqual([]);
    expect(v.sensitive).toBe(true);
    expect(v.summary).toBe(FEDERATION_TEXT.en.mature);
    expect(v.name).toBe("Synth Club");
  });

  test("durations are whole, non-negative seconds", () => {
    expect(isoDuration(0)).toBe("PT0S");
    expect(isoDuration(-3)).toBe("PT0S");
    expect(isoDuration(Number.NaN)).toBe("PT0S");
    expect(isoDuration(59.5)).toBe("PT60S");
  });
});

describe("activities", () => {
  test("Create wraps the object with a derived stable id and the same addressing", () => {
    const n = note();
    const c = createActivity(n);
    expect(c).toEqual({
      "@context": AS2_CONTEXT,
      id: `${n.id}/activity`,
      type: "Create",
      actor: urls.id,
      published: n.published,
      to: [AS2_PUBLIC],
      cc: [urls.followers],
      object: n,
    });
    expect(createActivity(note()).id).toBe(c.id);
  });

  test("Delete sends a Tombstone of the object", () => {
    const id = objectUrl(ORIGIN, OBJECT);
    expect(deleteObjectActivity(urls, id, "video", PUBLISHED)).toEqual({
      "@context": AS2_CONTEXT,
      id: `${id}#delete`,
      type: "Delete",
      actor: urls.id,
      to: [AS2_PUBLIC],
      cc: [urls.followers],
      object: { id, type: "Tombstone", formerType: "Video", deleted: "2026-11-01T12:00:00.000Z" },
    });
    expect(deleteObjectActivity(urls, id, "note", PUBLISHED).object.formerType).toBe("Note");
  });

  test("Delete of the actor names the actor as its object", () => {
    expect(deleteActorActivity(urls)).toEqual({
      "@context": AS2_CONTEXT,
      id: `${urls.id}#delete`,
      type: "Delete",
      actor: urls.id,
      to: [AS2_PUBLIC],
      cc: [urls.followers],
      object: urls.id,
    });
    // One id per occasion, so a second suspension is not deduped against the first.
    expect(deleteActorActivity(urls, "0193a5c0-ev").id).toBe(`${urls.id}#delete/0193a5c0-ev`);
    expect(deleteActorActivity(urls, "a/b").id).toBe(`${urls.id}#delete/a%2Fb`);
  });

  test("Accept echoes the Follow Mastodon sent (its id, actor and object)", () => {
    const follow = MASTODON_INBOUND.follow(urls.id);
    const a = acceptActivity(urls, { id: follow.id, type: "Follow", actor: follow.actor, object: urls.id }, "row1");
    expect(a).toEqual({
      "@context": AS2_CONTEXT,
      id: `${urls.id}#accepts/follows/row1`,
      type: "Accept",
      actor: urls.id,
      to: [follow.actor],
      object: { id: follow.id, type: "Follow", actor: follow.actor, object: urls.id },
    });
  });

  test("Update{Service} carries the whole actor document with the new key", () => {
    const at = new Date("2027-11-01T00:00:00.000Z");
    const u = updateServiceActivity(actorInput(), at);
    expect(u["@context"]).toEqual(ACTOR_CONTEXT);
    expect(u.id).toBe(`${urls.id}#updates/key-${at.getTime()}`);
    expect(u.type).toBe("Update");
    expect(u.actor).toBe(urls.id);
    expect(u.object.publicKey).toEqual({
      id: urls.keyId,
      owner: urls.id,
      publicKeyPem: actorInput().publicKeyPem,
    });
    expect(u.object).toMatchObject({
      type: "Service",
      preferredUsername: "synthclub",
      inbox: urls.inbox,
      outbox: urls.outbox,
      followers: urls.followers,
      endpoints: { sharedInbox: urls.sharedInbox },
      manuallyApprovesFollowers: false,
    });
    expect(u.object.summary).toBe(
      `<p>Modular &lt;b&gt;synths&lt;/b&gt;</p><p>${escapeHtml(FEDERATION_TEXT.en.repliesNotRead)}</p>`,
    );
    expect(u.object.icon?.mediaType).toBe("image/png");
    expect(u.object.image?.mediaType).toBe("image/webp");
  });

  test("a mature actor has no avatar or banner", () => {
    const a = serviceActor(actorInput({ mature: true }), ACTOR_CONTEXT);
    expect(a.icon).toBeUndefined();
    expect(a.image).toBeUndefined();
  });
});

describe("inbound classification (Mastodon's documented shapes)", () => {
  const me = urls.id;
  test("Follow", () => {
    const f = MASTODON_INBOUND.follow(me);
    expect(classifyInbound(f)).toEqual({ kind: "follow", id: f.id, actor: f.actor, object: me });
  });
  test("Undo{Follow}, embedded or by id", () => {
    const u = MASTODON_INBOUND.undoFollow(me);
    expect(classifyInbound(u)).toEqual({ kind: "undo-follow", actor: u.actor, followId: u.object.id, object: me });
    expect(classifyInbound({ ...u, object: u.object.id })).toEqual({
      kind: "undo-follow",
      actor: u.actor,
      followId: u.object.id,
      object: null,
    });
  });
  test("an Undo of someone else's Follow, or of a Like, is not an unfollow", () => {
    const u = MASTODON_INBOUND.undoFollow(me);
    expect(classifyInbound({ ...u, object: { ...u.object, actor: "https://evil.example/users/x" } }).kind).toBe(
      "other",
    );
    expect(classifyInbound({ ...u, object: { ...u.object, type: "Like" } }).kind).toBe("other");
  });
  test("Delete of the sender itself, and nothing else", () => {
    const d = MASTODON_INBOUND.deleteActor();
    expect(classifyInbound(d)).toEqual({ kind: "delete-actor", actor: d.actor });
    expect(classifyInbound({ ...d, object: { id: "https://mastodon.example/users/alice/statuses/1" } }).kind).toBe(
      "other",
    );
  });
  test("anything else, and junk, is other", () => {
    expect(classifyInbound(MASTODON_INBOUND.createReply(me))).toEqual({
      kind: "other",
      actor: "https://mastodon.example/users/alice",
      type: "Create",
    });
    expect(classifyInbound(null)).toEqual({ kind: "other", actor: null, type: null });
    expect(classifyInbound({ type: "Follow" })).toEqual({ kind: "other", actor: null, type: "Follow" });
    expect(classifyInbound({ type: "Follow", actor: "x" }).kind).toBe("other");
  });
  test("idOf reads a string or an object's id", () => {
    expect(idOf("a")).toBe("a");
    expect(idOf({ id: "b" })).toBe("b");
    expect(idOf({ id: 1 })).toBeNull();
    expect(idOf(undefined)).toBeNull();
  });
});

describe("text and helpers", () => {
  test("every locale has every key", () => {
    const keys = Object.keys(FEDERATION_TEXT.en).sort();
    for (const t of Object.values(FEDERATION_TEXT)) expect(Object.keys(t).sort()).toEqual(keys);
    expect(federationText("ES_es")).toBe(FEDERATION_TEXT.es);
  });
  test("image media types from the extension", () => {
    expect(imageMediaType("https://x.example/a.JPEG")).toBe("image/jpeg");
    expect(imageMediaType("https://x.example/a.png?x=1")).toBe("image/png");
    expect(imageMediaType("https://x.example/a")).toBeNull();
    expect(imageMediaType("not a url")).toBeNull();
  });
});

/**
 * Decision 9, as a schema test: every field any published object or activity can carry is on an
 * allow-list, and none is a place for an email, an IP or a local user id. A new field fails here
 * until it is reviewed.
 */
describe("no personal data (schema)", () => {
  const ALLOWED = new Set([
    "@context",
    "id",
    "type",
    "actor",
    "attributedTo",
    "published",
    "to",
    "cc",
    "object",
    "url",
    "content",
    "sensitive",
    "summary",
    "attachment",
    "icon",
    "image",
    "mediaType",
    "name",
    "href",
    "duration",
    "formerType",
    "deleted",
    "preferredUsername",
    "inbox",
    "outbox",
    "followers",
    "endpoints",
    "sharedInbox",
    "manuallyApprovesFollowers",
    "publicKey",
    "owner",
    "publicKeyPem",
  ]);
  const everything = [
    note(),
    note({ mature: true }),
    video(),
    createActivity(note()),
    createActivity(video()),
    deleteObjectActivity(urls, objectUrl(ORIGIN, OBJECT), "note", PUBLISHED),
    deleteActorActivity(urls),
    acceptActivity(
      urls,
      { id: "https://m.example/f/1", type: "Follow", actor: "https://m.example/u/a", object: urls.id },
      "r",
    ),
    updateServiceActivity(actorInput(), PUBLISHED),
  ];
  const EMAIL = /[^\s@/]+@[^\s@/]+\.[a-z]{2,}/i;
  const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

  test.each(everything.map((o) => [String((o as { type: string }).type), o] as const))(
    "%s: only allow-listed fields, and no email- or IP-shaped values",
    (_, o) => {
      const problems: string[] = [];
      const walk = (x: unknown, path: string) => {
        if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}[${i}]`));
        else if (x && typeof x === "object")
          for (const [k, v] of Object.entries(x)) {
            if (!ALLOWED.has(k)) problems.push(`${path}.${k} is not allow-listed`);
            walk(v, `${path}.${k}`);
          }
        else if (typeof x === "string") {
          if (EMAIL.test(x)) problems.push(`${path} looks like an email`);
          if (IPV4.test(x)) problems.push(`${path} looks like an IP`);
        }
      };
      walk(o, "$");
      expect(problems).toEqual([]);
    },
  );
});
