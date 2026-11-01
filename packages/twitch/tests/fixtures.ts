// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Helix-shaped answers for a made-up channel (never real Twitch data), and a scripted fetch. */

export const USER = {
  id: "90000001",
  login: "pixelgardener",
  display_name: "PixelGardener",
  type: "",
  broadcaster_type: "affiliate",
  description: "Cozy pixel-art gardening streams. Seeds, sprites and slow mornings.",
  profile_image_url: "https://static-cdn.jtvnw.net/user-default-pictures/x.png",
  created_at: "2020-01-01T00:00:00Z",
};

export const CHANNEL = {
  broadcaster_id: "90000001",
  broadcaster_login: "pixelgardener",
  broadcaster_name: "PixelGardener",
  broadcaster_language: "en",
  game_id: "1",
  game_name: "Pixel Art Gardening",
  title: "Planting sprites until the sun comes up",
  delay: 0,
  tags: ["PixelArt", "Cozy", "English", "pixelart", "has space", "x".repeat(30)],
  content_classification_labels: ["MatureGame"],
  is_branded_content: false,
};

const img = (id: string) => ({
  url_1x: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/static/light/1.0`,
  url_2x: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/static/light/2.0`,
  url_4x: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/static/light/3.0`,
});
const emote = (id: string, name: string, emote_type: string, tier: string, format = ["static"]) => ({
  id,
  name,
  images: img(id),
  tier,
  emote_type,
  emote_set_id: "1",
  format,
  scale: ["1.0", "2.0", "3.0"],
  theme_mode: ["light", "dark"],
});

export const EMOTES = {
  data: [
    emote("e1", "pgWave", "subscriptions", "1000"),
    emote("e2", "pgHype", "subscriptions", "2000", ["static", "animated"]),
    emote("e3", "pgLove", "subscriptions", "3000"),
    emote("e4", "pgHi", "follower", ""),
    emote("e5", "pgBits", "bitstier", ""),
    emote("e6", "pgOdd", "limitedtime", ""),
    emote("e7", "pg-bad!", "follower", ""),
    emote("e8", "PGWAVE", "follower", ""),
  ],
  template: "https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}",
};

export const SCHEDULE_PAGE_1 = {
  data: {
    segments: [
      {
        id: "s1",
        start_time: "2026-11-03T18:00:00Z",
        end_time: "2026-11-03T21:00:00Z",
        title: "Seed swap Tuesday",
        canceled_until: null,
        category: { id: "1", name: "Pixel Art Gardening" },
        is_recurring: true,
      },
    ],
    broadcaster_id: "90000001",
    vacation: null,
  },
  pagination: { cursor: "page2" },
};
export const SCHEDULE_PAGE_2 = {
  data: {
    segments: [
      {
        id: "s2",
        start_time: "2026-11-05T18:00:00Z",
        end_time: null,
        title: "Harvest stream",
        canceled_until: null,
        category: null,
        is_recurring: false,
      },
    ],
    broadcaster_id: "90000001",
    vacation: null,
  },
  pagination: {},
};

export interface Call {
  url: URL;
  init: RequestInit;
}

/** A fetch that answers from a handler and records every call. */
export function scriptedFetch(handler: (url: URL, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    return handler(url, init, calls.length);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
