// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one "this channel moved" email (ADR 0037 decision 3, batch 7 decision (l)): sent once to a
 * viewer who asked to be told, then their request is deleted. On the `moved` unsubscribe list
 * (RFC 8058 one-click). Mail links only to this instance, so the destination's host name is shown
 * as escaped text, never as a link or a full address: the button opens the channel page here, which
 * shows the full "moved to" address with its external-link note.
 */
import { Link, Section } from "@react-email/components";
import { Action, defineTemplate, H1, Muted, P } from "../template.tsx";
import { styles } from "../theme.ts";

export interface ChannelMovedData {
  /** The channel's display name (free text, escaped). */
  channelName: string;
  /** The host name of where the streamer says they moved (text only, never a link). */
  movedToHost: string;
  /** The channel page on this instance. */
  channelUrl: string;
  settingsUrl: string;
  unsubscribeUrl: string;
}

export const channelMoved = defineTemplate("channelMoved", {
  links: ["channelUrl", "settingsUrl", "unsubscribeUrl"],
  subject: (ctx, d: ChannelMovedData) => ctx.text(ctx.messages.subject, { channel: d.channelName }),
  preview: (ctx, d: ChannelMovedData) => ctx.text(ctx.messages.preview, { channel: d.channelName }),
  unsubscribeUrl: (d: ChannelMovedData) => d.unsubscribeUrl,
  body: (ctx, d: ChannelMovedData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading, { channel: d.channelName })}</H1>
        <P>{ctx.t(m.body, { channel: d.channelName })}</P>
        <Section style={{ margin: "0 0 16px" }}>
          <code className="ca-text" style={{ ...styles.text, wordBreak: "break-all" }}>
            {d.movedToHost}
          </code>
        </Section>
        <P>{ctx.t(m.caution)}</P>
        <Action ctx={ctx} href={d.channelUrl} label={ctx.text(m.openChannel)} />
        <Muted>{ctx.t(m.subscriptions, { channel: d.channelName })}</Muted>
        <Muted>{ctx.t(m.why, { channel: d.channelName })}</Muted>
        <Muted>
          <Link className="ca-link" href={d.settingsUrl} style={styles.link}>
            {ctx.t(m.settings)}
          </Link>
        </Muted>
      </>
    );
  },
});
