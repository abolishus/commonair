// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `/$channel` needs beyond `ChannelSummary` for its banner and panels (batch 8, B8-web):
 * `Channel.bannerUrl`, `Channel.panels` and `Channel.suspended`, read from the same `channels.get`
 * answer as the summary. Pure, so the rules are unit-tested.
 */
import type { Api } from "../../lib/api.ts";

type ChannelDto = Awaited<ReturnType<Api["channels"]["get"]>>;

export interface ChannelPanelView {
  id: string;
  title: string;
  body: string;
  /** Our media origin's URL (`mediaUrl` on the API); null without an image or when unsafe. */
  imageUrl: string | null;
  /** The panel's link; null without one or when it is not http(s). */
  linkUrl: string | null;
}

export interface ChannelExtras {
  bannerUrl: string | null;
  panels: ChannelPanelView[];
  suspended: boolean;
}

export const NO_EXTRAS: ChannelExtras = Object.freeze({ bannerUrl: null, panels: [], suspended: false });

/**
 * The URL when it is an absolute http(s) URL, else null. The API builds image URLs on our own media
 * origin and checks panel links when they are saved; this keeps a `javascript:` or `data:` value
 * from ever reaching an `href` or `src` if either check is bypassed. The URL is never rewritten.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

/** A panel with no title, body, image or link shows nothing, so it is left out. */
const hasContent = (p: ChannelPanelView) =>
  p.title.trim() !== "" || p.body.trim() !== "" || p.imageUrl !== null || p.linkUrl !== null;

export function channelExtras(c: Pick<ChannelDto, "bannerUrl" | "panels" | "suspended">): ChannelExtras {
  return {
    bannerUrl: safeHttpUrl(c.bannerUrl),
    panels: [...c.panels]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        imageUrl: safeHttpUrl(p.imageUrl),
        linkUrl: safeHttpUrl(p.linkUrl),
      }))
      .filter(hasContent),
    suspended: c.suspended,
  };
}

/** Whether the banner may show: never on a suspended channel, and on a mature one only after 18+. */
export function bannerVisible(s: {
  bannerUrl: string | null;
  suspended: boolean;
  mature: boolean;
  /** Signed in and 18+ confirmed. */
  confirmed: boolean;
  /** The stream is behind the T1 interstitial (`restricted-locked`). */
  locked: boolean;
}): boolean {
  if (s.bannerUrl === null || s.suspended || s.locked) return false;
  return !s.mature || s.confirmed;
}
