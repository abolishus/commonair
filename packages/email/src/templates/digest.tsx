// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4 (D7.3; account-admin.md P5): the opt-in weekly "What you missed" email and the
 * creator's "Your video is ready" email. Both carry RFC 8058 one-click unsubscribe. Text and links
 * only: no images, so no remote content loads and nothing in them can track an open.
 */
import { Link, Section } from "@react-email/components";
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, H1, Muted, P } from "../template.tsx";
import { styles } from "../theme.ts";

/** One new video or clip from a channel the member follows. */
export interface WeeklyDigestItem {
  kind: "video" | "clip";
  /** The channel's display name (free text, escaped). */
  channelName: string;
  /** The video or clip title (free text, escaped). */
  title: string;
  /** Its page on the instance (a validated link). */
  url: string;
}

/** An open co-op vote. */
export interface WeeklyDigestVote {
  title: string;
  closesAt: DateInput;
  url: string;
}

export interface WeeklyDigestData {
  /** At most `DIGEST_RULES.maxItems`; the caller never sends a digest with nothing in it. */
  items: WeeklyDigestItem[];
  votes: WeeklyDigestVote[];
  settingsUrl: string;
  unsubscribeUrl: string;
}

/** Physical list indent from the locale direction: Outlook's Word engine ignores logical padding. */
const listStyle = (dir: string) => ({ margin: 0, padding: dir === "rtl" ? "0 20px 0 0" : "0 0 0 20px" });

export const weeklyDigest = defineTemplate("weeklyDigest", {
  links: ["settingsUrl", "unsubscribeUrl"],
  linkLists: [
    { field: "items", key: "url" },
    { field: "votes", key: "url" },
  ],
  subject: (ctx) => ctx.text(ctx.messages.subject),
  preview: (ctx) => ctx.text(ctx.messages.preview),
  unsubscribeUrl: (d: WeeklyDigestData) => d.unsubscribeUrl,
  body: (ctx, d: WeeklyDigestData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        {d.items.length > 0 ? (
          <Section style={{ margin: "0 0 16px" }}>
            <P>{ctx.t(m.itemsHeading)}</P>
            <ul style={listStyle(ctx.dir)}>
              {d.items.map((item, i) => (
                <li key={`${item.url}-${i}`} className="ca-text" style={{ ...styles.text, margin: "0 0 8px" }}>
                  {ctx.t(item.kind === "video" ? m.video : m.clip, {
                    channel: item.channelName,
                    title: (
                      <Link className="ca-link" href={item.url} style={{ ...styles.link, fontWeight: 600 }}>
                        {item.title}
                      </Link>
                    ),
                  })}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {d.votes.length > 0 ? (
          <Section style={{ margin: "0 0 16px" }}>
            <P>{ctx.t(m.votesHeading)}</P>
            <ul style={listStyle(ctx.dir)}>
              {d.votes.map((vote, i) => (
                <li key={`${vote.url}-${i}`} className="ca-text" style={{ ...styles.text, margin: "0 0 8px" }}>
                  {ctx.t(m.vote, {
                    title: (
                      <Link className="ca-link" href={vote.url} style={{ ...styles.link, fontWeight: 600 }}>
                        {vote.title}
                      </Link>
                    ),
                    closesAt: ctx.dateTime(vote.closesAt),
                  })}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <Muted>{ctx.t(m.why)}</Muted>
        <Muted>
          <Link className="ca-link" href={d.settingsUrl} style={styles.link}>
            {ctx.t(m.settings)}
          </Link>
        </Muted>
      </>
    );
  },
});

export interface VodReadyData {
  /** The video title (free text, escaped). */
  title: string;
  videoUrl: string;
  settingsUrl: string;
  unsubscribeUrl: string;
}

export const vodReady = defineTemplate("vodReady", {
  links: ["videoUrl", "settingsUrl", "unsubscribeUrl"],
  subject: (ctx, d: VodReadyData) => ctx.text(ctx.messages.subject, { title: d.title }),
  preview: (ctx) => ctx.text(ctx.messages.preview),
  unsubscribeUrl: (d: VodReadyData) => d.unsubscribeUrl,
  body: (ctx, d: VodReadyData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { title: <strong>{d.title}</strong> })}</P>
        <Action ctx={ctx} href={d.videoUrl} label={m.action} />
        <Muted>{ctx.t(m.why)}</Muted>
        <Muted>
          <Link className="ca-link" href={d.settingsUrl} style={styles.link}>
            {ctx.t(m.settings)}
          </Link>
        </Muted>
      </>
    );
  },
});
