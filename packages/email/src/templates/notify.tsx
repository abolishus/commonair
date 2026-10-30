// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Go-live notification mail (ADR 0028 decisions 3 and 4): one digest per member and window, for
 * one channel or many, opt-in only, with RFC 8058 one-click unsubscribe. The strings carry no
 * counts: the email catalog has no plurals until N2-email.
 */
import { Link, Section } from "@react-email/components";
import { defineTemplate, H1, Muted, P } from "../template.tsx";
import { styles } from "../theme.ts";

/** Channels listed by name in one digest; the rest are summed up by one line linking the home page. */
export const GO_LIVE_DIGEST_MAX_CHANNELS = 20;

export interface GoLiveDigestChannel {
  /** The channel's display name (free text, escaped). */
  name: string;
  /** The broadcast title; "" for a mature broadcast the member has not confirmed 18+ for. */
  title: string;
  /** The channel page on the instance (a validated link). */
  url: string;
}

export interface GoLiveDigestData {
  /** At least one; beyond `GO_LIVE_DIGEST_MAX_CHANNELS` only the first are listed. */
  channels: GoLiveDigestChannel[];
  settingsUrl: string;
  unsubscribeUrl: string;
}

export const goLiveDigest = defineTemplate("goLiveDigest", {
  links: ["settingsUrl", "unsubscribeUrl"],
  linkLists: [{ field: "channels", key: "url" }],
  subject: (ctx, d: GoLiveDigestData) =>
    d.channels.length === 1
      ? ctx.text(ctx.messages.subjectOne, { channel: d.channels[0]?.name ?? "" })
      : ctx.text(ctx.messages.subjectMany),
  preview: (ctx, d: GoLiveDigestData) =>
    d.channels.length === 1
      ? ctx.text(ctx.messages.previewOne, { channel: d.channels[0]?.name ?? "" })
      : ctx.text(ctx.messages.previewMany),
  unsubscribeUrl: (d: GoLiveDigestData) => d.unsubscribeUrl,
  body: (ctx, d: GoLiveDigestData) => {
    const m = ctx.messages;
    const shown = d.channels.slice(0, GO_LIVE_DIGEST_MAX_CHANNELS);
    const first = d.channels[0];
    return (
      <>
        <H1>
          {d.channels.length === 1 && first ? ctx.t(m.headingOne, { channel: first.name }) : ctx.t(m.headingMany)}
        </H1>
        <Section style={{ margin: "0 0 16px" }}>
          {/* Physical sides from the layout: Outlook's Word engine ignores logical padding. */}
          <ul style={{ margin: 0, padding: ctx.layout.dir === "rtl" ? "0 20px 0 0" : "0 0 0 20px" }}>
            {shown.map((c, i) => {
              const name = (
                <Link className="ca-link" href={c.url} style={{ ...styles.link, fontWeight: 600 }}>
                  {c.name}
                </Link>
              );
              return (
                <li key={`${c.url}-${i}`} className="ca-text" style={{ ...styles.text, margin: "0 0 8px" }}>
                  {c.title === ""
                    ? ctx.t(m.itemNoTitle, { channel: name })
                    : ctx.t(m.item, { channel: name, title: c.title })}
                </li>
              );
            })}
          </ul>
        </Section>
        {d.channels.length > GO_LIVE_DIGEST_MAX_CHANNELS ? (
          <P>
            <Link className="ca-link" href={ctx.site.publicUrl} style={styles.link}>
              {ctx.t(m.more)}
            </Link>
          </P>
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
