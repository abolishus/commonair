// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's panels on `/$channel` (`channel-panels`, `channel-panel`;
 * docs/testing/b8-selectors.md). A panel's body is a small, safe markdown subset (D3.8,
 * `PanelMarkdown`): parsed to data and rendered as React elements, never as HTML, so raw HTML in it
 * shows as text. A link, in the body or the panel's own, is a user-generated, off-site link:
 * `nofollow ugc`, opened in a new tab with an icon and a label that say so. An image sits in a fixed
 * 2:1 frame (the seed's panel art is 320 × 160) and loads lazily. No panels, no section.
 */
import { Button } from "@commonair/ui/components/button";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@commonair/ui/lib/utils";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { parsePanelMarkdown, type ChannelPanelView, type MdInline } from "./panels-data.ts";

/** `rel` of every panel link: the target is the streamer's choice, so it gets no referrer, opener or rank. */
export const PANEL_LINK_REL = "noopener noreferrer nofollow ugc";
export const PANEL_IMAGE_RATIO = 2;

export function ChannelPanels({ panels }: { panels: readonly ChannelPanelView[] }): React.JSX.Element | null {
  const headingId = React.useId();
  if (panels.length === 0) return null;
  return (
    <section data-testid="channel-panels" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        {t("channelPage.panels.title")}
      </h2>
      <ul className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {panels.map((p, i) => (
          <li key={p.id} className="min-w-0">
            <ChannelPanel panel={p} index={i} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChannelPanel({ panel: p, index }: { panel: ChannelPanelView; index: number }): React.JSX.Element {
  const title = p.title.trim();
  const body = p.body.trim();
  return (
    <Card data-testid="channel-panel" data-panel-index={index} size="sm" className="h-full min-w-0">
      {p.imageUrl ? (
        <AspectRatio ratio={PANEL_IMAGE_RATIO} className="overflow-hidden bg-muted">
          <img src={p.imageUrl} alt={title} loading="lazy" decoding="async" className="size-full object-cover" />
        </AspectRatio>
      ) : null}
      {title !== "" ? (
        <CardHeader>
          <CardTitle className="break-words">{title}</CardTitle>
        </CardHeader>
      ) : null}
      {body !== "" || p.linkUrl ? (
        <CardContent className="flex min-w-0 flex-col gap-3">
          {body !== "" ? <PanelMarkdown data-testid="channel-panel-body" body={body} /> : null}
          {p.linkUrl ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                className="max-w-full"
                render={
                  <a
                    data-testid="channel-panel-link"
                    href={p.linkUrl}
                    target="_blank"
                    rel={PANEL_LINK_REL}
                    aria-label={t("channelPage.panels.linkLabel", { host: hostOf(p.linkUrl) })}
                  />
                }
              >
                <span className="min-w-0 truncate">{t("channelPage.panels.link", { host: hostOf(p.linkUrl) })}</span>
                <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} aria-hidden />
              </Button>
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function MdInlines({ nodes }: { nodes: readonly MdInline[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <React.Fragment key={i}>{n.text}</React.Fragment>;
          case "strong":
            return (
              <strong key={i} className="font-semibold">
                <MdInlines nodes={n.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <MdInlines nodes={n.children} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="bg-muted px-1 font-mono">
                {n.text}
              </code>
            );
          case "link":
            return (
              <a
                key={i}
                data-testid="channel-panel-body-link"
                href={n.href}
                target="_blank"
                rel={PANEL_LINK_REL}
                className="break-all underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {n.text}
                <span className="sr-only"> {t("d3Watch.panels.opensNewTab")}</span>
              </a>
            );
        }
      })}
    </>
  );
}

/**
 * A panel body's markdown (D3.8), rendered from `parsePanelMarkdown`'s data as React elements: no
 * HTML is ever parsed or injected, and every link is the streamer's, so it gets `PANEL_LINK_REL`.
 */
export function PanelMarkdown({
  body,
  className,
  ...props
}: {
  body: string;
  className?: string;
  "data-testid"?: string;
}): React.JSX.Element {
  const blocks = React.useMemo(() => parsePanelMarkdown(body), [body]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 text-sm break-words", className)} {...props}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "p":
            return (
              <p key={i}>
                {b.lines.map((line, j) => (
                  <React.Fragment key={j}>
                    {j > 0 ? <br /> : null}
                    <MdInlines nodes={line} />
                  </React.Fragment>
                ))}
              </p>
            );
          case "heading":
            return (
              <h3 key={i} className={cn("font-semibold", b.level === 1 ? "text-base" : "text-sm")}>
                <MdInlines nodes={b.children} />
              </h3>
            );
          case "ul":
          case "ol": {
            const List = b.type;
            return (
              <List key={i} className={cn("flex flex-col gap-1 ps-5", b.type === "ul" ? "list-disc" : "list-decimal")}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <MdInlines nodes={item} />
                  </li>
                ))}
              </List>
            );
          }
        }
      })}
    </div>
  );
}

/** The link's host, so the reader sees where it goes before following it. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
