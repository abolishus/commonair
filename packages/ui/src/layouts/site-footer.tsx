// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@commonair/ui/lib/utils";

export interface FooterLink {
  label: string;
  href?: string;
  render?: React.ReactElement;
}
/** One titled column of links (Create, Co-op, Legal); each is its own labelled `<nav>`. */
export interface FooterColumn {
  id: string;
  heading: string;
  links: FooterLink[];
}
export interface SourceLink extends React.ComponentProps<"a"> {
  label: string;
  href: string;
  "data-testid"?: string;
}
export interface SiteFooterProps extends React.ComponentProps<"footer"> {
  instanceName: string;
  /** The brand mark beside the name in the first column; decorative. */
  mark?: React.ReactNode;
  /** One or two sentences under the name. */
  tagline?: string;
  /** The link columns, after the brand column: three from `md` (Create, Co-op, Legal). */
  columns?: FooterColumn[];
  /** Label for the base row's navigation (cookie settings, language), when it has links. */
  baseLabel?: string;
  /** The base row: settings-like controls and links (cookie settings, language). */
  links: FooterLink[];
  /** Also in the base row, e.g. the visitor's theme switch. */
  extra?: React.ReactNode;
  sourceLink?: SourceLink;
  license: string;
}

const LINK = "text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

/**
 * The site footer: the brand column and up to three link columns (one column on phones, four
 * from `md`), then a base row with the AGPL source link, the license and the page-wide controls.
 * On the sunken surface, under a rule.
 */
export function SiteFooter({
  instanceName,
  mark,
  tagline,
  columns = [],
  baseLabel,
  links,
  extra,
  sourceLink,
  license,
  className,
  ...props
}: SiteFooterProps): React.JSX.Element {
  return (
    <footer
      data-slot="site-footer"
      className={cn(
        "border-t text-sm text-muted-foreground",
        // The page surface until the art direction's sunken surface token lands (contract request).
        "bg-background",
        className,
      )}
      {...props}
    >
      <div className="mx-auto w-full max-w-400 px-4 md:px-6 xl:px-8">
        <div
          data-slot="site-footer-columns"
          className={cn("grid grid-cols-1 gap-8 py-10", columns.length > 0 && "md:grid-cols-4")}
        >
          <div className="min-w-0">
            <span data-slot="site-footer-brand" className="flex items-center gap-2 font-semibold text-foreground">
              {mark}
              <span>{instanceName}</span>
            </span>
            {tagline ? <p className="mt-3 max-w-xs">{tagline}</p> : null}
          </div>
          {columns.map((column) => (
            <nav key={column.id} aria-label={column.heading} data-footer-column={column.id} className="min-w-0">
              <h2 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {column.heading}
              </h2>
              <ul className="flex flex-col gap-2">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <FooterAnchor link={link} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div data-slot="site-footer-base" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t py-4">
          {sourceLink ? <SourceAnchor {...sourceLink} /> : null}
          <span>{license}</span>
          {links.length ? (
            <nav aria-label={baseLabel ?? instanceName} className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {links.map((link) => (
                <React.Fragment key={link.label}>
                  <FooterAnchor link={link} />
                </React.Fragment>
              ))}
            </nav>
          ) : null}
          {extra}
        </div>
      </div>
    </footer>
  );
}

function FooterAnchor({ link }: { link: FooterLink }): React.JSX.Element {
  if (link.render) {
    const element = link.render as React.ReactElement<{ className?: string }>;
    return React.cloneElement(element, { className: cn(LINK, element.props.className) }, link.label);
  }
  return (
    <a href={link.href} className={LINK}>
      {link.label}
    </a>
  );
}

function SourceAnchor({ label, className, ...props }: SourceLink): React.JSX.Element {
  return (
    <a {...props} rel="noopener" className={className ?? "underline underline-offset-4 hover:text-foreground"}>
      {label}
    </a>
  );
}
