// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure row → DTO helpers behind channels, directory, VOD/clip visibility and subscriptions:
 * media URLs, themes and socials, bot owners, broadcast summaries, panels, categories, the
 * visibility rules for one loaded VOD, subscription DTOs and the unique-violation matcher.
 */
import { describe, expect, test } from "vite-plus/test";
import type { Deps } from "../src/deps.ts";
import {
  categoryRef,
  channelAvatar,
  channelSocials,
  channelTheme,
  iso,
  isoOrNull,
  mediaUrl,
  toBroadcastSummary,
  toPanelDto,
  toUserPublic,
} from "../src/lib/dto.ts";
import { toCategory } from "../src/routes/directory.ts";
import {
  audienceOf,
  HIDDEN_REMOVED_REASONS,
  OWNER_REMOVED_REASONS,
  vodShown,
  type Audience,
} from "../src/media/visibility.ts";
import { subscriptionChannel, toSubscriptionDto, violatesConstraint } from "../src/money/checkout-shared.ts";
import { MOVED_TO_MAX, validMovedTo } from "../src/portability/audience.ts";
import type { Caller } from "../src/lib/access.ts";

const BASE = "https://media.test/m";
const deps = { env: { MEDIA_PUBLIC_URL: `${BASE}//` } } as unknown as Deps;
const T = new Date("2026-11-01T12:00:00.000Z");
const ID = "01890000-0000-7000-8000-000000000001";

type ChannelRow = Parameters<typeof channelTheme>[0];
const channel = (over: Partial<ChannelRow> = {}): ChannelRow =>
  ({
    id: ID,
    slug: "ada",
    displayName: "Ada",
    theme: {},
    socials: [],
    ...over,
  }) as ChannelRow;

describe("mediaUrl", () => {
  test("null and empty keys give null", () => {
    expect(mediaUrl(deps, null)).toBeNull();
    expect(mediaUrl(deps, undefined)).toBeNull();
    expect(mediaUrl(deps, "")).toBeNull();
  });
  test("absolute http(s) URLs pass through untouched", () => {
    expect(mediaUrl(deps, "https://oauth.example/a.png")).toBe("https://oauth.example/a.png");
    expect(mediaUrl(deps, "http://oauth.example/a.png")).toBe("http://oauth.example/a.png");
  });
  test("keys join the normalized base, each segment encoded and slashes kept", () => {
    expect(mediaUrl(deps, "avatars/a b/c#d.png")).toBe(`${BASE}/avatars/a%20b/c%23d.png`);
    // Not a URL scheme this helper recognises: treated as a key.
    expect(mediaUrl(deps, "ftp://x")).toBe(`${BASE}/ftp%3A//x`);
  });
});

describe("iso and isoOrNull", () => {
  test("ISO 8601 UTC, and null for a missing date", () => {
    expect(iso(T)).toBe("2026-11-01T12:00:00.000Z");
    expect(isoOrNull(T)).toBe("2026-11-01T12:00:00.000Z");
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
  });
});

describe("toUserPublic", () => {
  type UserRow = Parameters<typeof toUserPublic>[1];
  const user = (over: Partial<UserRow> = {}) =>
    ({
      id: ID,
      username: "ada",
      name: "Ada L",
      image: null,
      accountType: "human",
      createdAt: T,
      ...over,
    }) as UserRow;
  const owner = { id: "01890000-0000-7000-8000-0000000000ff", username: "boss" };

  test("a human never carries a bot owner, even when one is passed", () => {
    expect(toUserPublic(deps, user({ image: "avatars/x.png" }), owner)).toEqual({
      id: ID,
      username: "ada",
      displayName: "Ada L",
      avatarUrl: `${BASE}/avatars/x.png`,
      accountType: "human",
      botOwner: null,
      createdAt: iso(T),
    });
  });
  test("a bot carries its owner, or null when the owner is gone", () => {
    expect(toUserPublic(deps, user({ accountType: "bot" }), owner).botOwner).toEqual(owner);
    expect(toUserPublic(deps, user({ accountType: "bot" }), null).botOwner).toBeNull();
  });
});

describe("categoryRef", () => {
  test("keeps id, slug and name only; null stays null", () => {
    expect(categoryRef(null)).toBeNull();
    expect(categoryRef({ id: ID, slug: "games", name: "Games", mature: true } as never)).toEqual({
      id: ID,
      slug: "games",
      name: "Games",
    });
  });
});

describe("toBroadcastSummary", () => {
  type BroadcastRow = Parameters<typeof toBroadcastSummary>[1];
  const b = { id: ID, title: "Show", startedAt: T, mature: false, thumbnailKey: null } as unknown as BroadcastRow;

  test("no catching-up field at zero (the contract default), the count above it", () => {
    const zero = toBroadcastSummary(deps, b, null, 7);
    expect(zero).toEqual({
      id: ID,
      title: "Show",
      category: null,
      startedAt: iso(T),
      mature: false,
      viewerCount: 7,
      thumbnailUrl: null,
    });
    expect("catchingUpCount" in zero).toBe(false);
    expect("catchingUpCount" in toBroadcastSummary(deps, b, null, 7, -1)).toBe(false);
    expect(toBroadcastSummary(deps, b, null, 7, 3).catchingUpCount).toBe(3);
  });
  test("category and thumbnail resolved", () => {
    const s = toBroadcastSummary(
      deps,
      { ...b, thumbnailKey: "thumbs/1.webp" } as BroadcastRow,
      {
        id: ID,
        slug: "art",
        name: "Art",
      },
      0,
    );
    expect(s.category).toEqual({ id: ID, slug: "art", name: "Art" });
    expect(s.thumbnailUrl).toBe(`${BASE}/thumbs/1.webp`);
    expect(s.viewerCount).toBe(0);
  });
});

describe("channelTheme, channelAvatar and channelSocials", () => {
  test("a stored theme that no longer parses reads as empty", () => {
    expect(channelTheme(channel({ theme: { accent: "violet", avatarKey: "a.png" } }))).toEqual({
      accent: "violet",
      avatarKey: "a.png",
    });
    expect(channelTheme(channel({ theme: { accent: "not-a-colour" } as never }))).toEqual({});
    expect(channelTheme(channel({ theme: null as never }))).toEqual({});
  });
  test("the theme's avatar wins over the owner's image; neither gives null", () => {
    expect(channelAvatar(deps, channel({ theme: { avatarKey: "channels/a.png" } }), "owner.png")).toBe(
      `${BASE}/channels/a.png`,
    );
    expect(channelAvatar(deps, channel(), "owner.png")).toBe(`${BASE}/owner.png`);
    expect(channelAvatar(deps, channel(), "https://oauth.example/o.png")).toBe("https://oauth.example/o.png");
    expect(channelAvatar(deps, channel(), null)).toBeNull();
  });
  test("socials keep valid entries in order; a non-array column is empty", () => {
    const good = [
      { platform: "github", url: "https://code.example/ada" },
      { platform: "other", url: "https://ada.example/" },
    ];
    expect(channelSocials({ socials: good as never })).toEqual(good);
    expect(
      channelSocials({
        socials: [
          null,
          7,
          { platform: "github" },
          { platform: "github", url: "https://a:b@x.example/" },
          good[1],
        ] as never,
      }),
    ).toEqual([good[1]]);
    expect(channelSocials({ socials: null as never })).toEqual([]);
    expect(channelSocials({ socials: "x" as never })).toEqual([]);
  });
});

describe("toPanelDto", () => {
  test("maps a panel row, resolving its image", () => {
    const row = {
      id: ID,
      channelId: ID,
      position: 2,
      title: "About",
      body: "Hi",
      imageKey: "channels/x/panel/p.png",
      linkUrl: null,
    } as unknown as Parameters<ReturnType<typeof toPanelDto>>[0];
    expect(toPanelDto(deps)(row)).toEqual({
      id: ID,
      position: 2,
      title: "About",
      body: "Hi",
      imageUrl: `${BASE}/channels/x/panel/p.png`,
      linkUrl: null,
    });
    expect(toPanelDto(deps)({ ...row, imageKey: null }).imageUrl).toBeNull();
  });
});

describe("toCategory", () => {
  test("carries live counts and stats; no box art is null", () => {
    const row = { id: ID, slug: "art", name: "Art", boxArtKey: null, mature: false } as unknown as Parameters<
      typeof toCategory
    >[1];
    expect(toCategory(deps, row, 3, { viewerCount: 40, tags: ["a"], videoCount: 7 })).toEqual({
      id: ID,
      slug: "art",
      name: "Art",
      boxArtUrl: null,
      mature: false,
      liveChannels: 3,
      viewerCount: 40,
      tags: ["a"],
      videoCount: 7,
    });
    expect(
      toCategory(deps, { ...row, boxArtKey: "boxart/art.webp" }, 0, { viewerCount: 0, tags: [], videoCount: 0 })
        .boxArtUrl,
    ).toBe(`${BASE}/boxart/art.webp`);
  });
});

describe("audienceOf", () => {
  const caller = (id: string) => ({ user: { id } }) as unknown as Caller;
  test("owner only for the channel's owner; anyone else and anonymous are public", () => {
    expect(audienceOf(caller(ID), { ownerId: ID })).toBe("owner");
    expect(audienceOf(caller("someone-else"), { ownerId: ID })).toBe("public");
    expect(audienceOf(null, { ownerId: ID })).toBe("public");
  });
});

describe("removed reasons", () => {
  test("owner and creator removals, plus DMCA, hide media", () => {
    expect([...OWNER_REMOVED_REASONS]).toEqual(["owner", "creator"]);
    expect([...HIDDEN_REMOVED_REASONS]).toEqual(["owner", "creator", "dmca"]);
  });
});

describe("vodShown", () => {
  const live = { suspendedAt: null };
  const suspended = { suspendedAt: T };
  const v = (over: Partial<{ status: string; visibility: string; removedReason: string | null }> = {}) => ({
    status: "ready",
    visibility: "public",
    removedReason: null,
    ...over,
  });
  const all: Audience[] = ["owner", "subscriber", "public"];

  test("deleted, hidden-removed and restricted VODs are shown to nobody, the owner included", () => {
    for (const a of all) {
      expect(vodShown(a, v({ status: "deleted" }), live, null)).toBe(false);
      for (const reason of HIDDEN_REMOVED_REASONS)
        expect(vodShown(a, v({ removedReason: reason }), live, null)).toBe(false);
      expect(vodShown(a, v(), live, T)).toBe(false);
    }
  });
  test("a retention removal does not hide a VOD that is not yet deleted", () => {
    expect(vodShown("public", v({ removedReason: "retention" }), live, null)).toBe(true);
  });
  test("the owner sees processing, failed, private and subscriber VODs, even when suspended", () => {
    for (const over of [
      { status: "processing" },
      { status: "failed" },
      { visibility: "private" },
      { visibility: "subscribers" },
    ])
      expect(vodShown("owner", v(over), suspended, null)).toBe(true);
  });
  test("subscribers see public and subscriber VODs; the public sees public only", () => {
    expect(vodShown("subscriber", v({ visibility: "subscribers" }), live, null)).toBe(true);
    expect(vodShown("subscriber", v({ visibility: "private" }), live, null)).toBe(false);
    expect(vodShown("public", v({ visibility: "subscribers" }), live, null)).toBe(false);
    expect(vodShown("public", v(), live, null)).toBe(true);
  });
  test("others never see unready VODs or VODs of a suspended channel", () => {
    for (const a of ["subscriber", "public"] as const) {
      expect(vodShown(a, v({ status: "processing" }), live, null)).toBe(false);
      expect(vodShown(a, v({ status: "failed" }), live, null)).toBe(false);
      expect(vodShown(a, v(), suspended, null)).toBe(false);
    }
  });
});

describe("subscription DTOs", () => {
  type SubRow = Parameters<typeof toSubscriptionDto>[0];
  const sub = (over: Partial<SubRow> = {}) =>
    ({
      id: ID,
      tier: 2,
      status: "active",
      provider: "manual",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      giftedById: null,
      giftPaymentId: null,
      createdAt: T,
      ...over,
    }) as SubRow;
  const subscriber = { id: ID, username: "bob", displayName: "Bob" };

  test("subscriptionChannel: the card's slug, name, avatar and accent", () => {
    expect(subscriptionChannel(deps, channel({ theme: { accent: "violet" } }), "o.png")).toEqual({
      slug: "ada",
      displayName: "Ada",
      avatarUrl: `${BASE}/o.png`,
      accent: "violet",
    });
    expect(subscriptionChannel(deps, channel(), null)).toEqual({
      slug: "ada",
      displayName: "Ada",
      avatarUrl: null,
      accent: undefined,
    });
  });

  test("gifted by a user or by a gift payment; the period end as ISO or null", () => {
    const c = subscriptionChannel(deps, channel(), null);
    const plain = toSubscriptionDto(sub(), c, subscriber);
    expect(plain).toMatchObject({
      id: ID,
      channelSlug: "ada",
      channel: c,
      subscriber,
      tier: 2,
      gifted: false,
      currentPeriodEnd: null,
      createdAt: iso(T),
    });
    expect(toSubscriptionDto(sub({ giftedById: ID }), c, subscriber).gifted).toBe(true);
    expect(toSubscriptionDto(sub({ giftPaymentId: ID }), c, subscriber).gifted).toBe(true);
    expect(toSubscriptionDto(sub({ currentPeriodEnd: T }), c, subscriber).currentPeriodEnd).toBe(iso(T));
  });
});

describe("violatesConstraint", () => {
  test("matches `constraint` as well as `constraint_name`, any of several names", () => {
    expect(violatesConstraint({ code: "23505", constraint: "b_uq" }, "a_uq", "b_uq")).toBe(true);
    expect(violatesConstraint({ code: "23505", constraint_name: 7, constraint: "a_uq" }, "a_uq")).toBe(true);
    expect(violatesConstraint({ code: "23505" }, "a_uq")).toBe(false);
    expect(violatesConstraint({ code: "23505", constraint_name: "a_uq" })).toBe(false);
  });
  test("follows `cause` at most five levels deep", () => {
    const wrap = (e: unknown, n: number): unknown => (n === 0 ? e : { cause: wrap(e, n - 1) });
    const pg = { code: "23505", constraint_name: "a_uq" };
    expect(violatesConstraint(wrap(pg, 4), "a_uq")).toBe(true);
    expect(violatesConstraint(wrap(pg, 5), "a_uq")).toBe(false);
  });
  test("null, undefined and primitives are no violation", () => {
    expect(violatesConstraint(null, "a_uq")).toBe(false);
    expect(violatesConstraint(undefined, "a_uq")).toBe(false);
    expect(violatesConstraint("23505", "a_uq")).toBe(false);
  });
});

describe("validMovedTo boundaries", () => {
  test("exactly the maximum length is accepted, one more is not; an empty host is refused", () => {
    const at = (n: number) => `https://e.org/${"a".repeat(n - "https://e.org/".length)}`;
    expect(validMovedTo(at(MOVED_TO_MAX))).toBe(at(MOVED_TO_MAX));
    expect(validMovedTo(at(MOVED_TO_MAX + 1))).toBeNull();
    expect(validMovedTo("https://")).toBeNull();
    expect(validMovedTo("")).toBeNull();
  });
});
