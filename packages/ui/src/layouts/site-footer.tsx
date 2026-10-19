// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
export interface FooterLink {
  label: string;
  href?: string;
  render?: React.ReactElement;
}
export interface SourceLink extends React.ComponentProps<"a"> {
  label: string;
  href: string;
  "data-testid"?: string;
}
export interface SiteFooterProps extends React.ComponentProps<"footer"> {
  instanceName: string;
  links: FooterLink[];
  sourceLink?: SourceLink;
  license: string;
}
export function SiteFooter({ instanceName, links, sourceLink, license, ...props }: SiteFooterProps): React.JSX.Element {
  return (
    <footer
      className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-4 text-muted-foreground"
      {...props}
    >
      <span>{instanceName}</span>
      <nav aria-label={instanceName} className="flex flex-wrap gap-4">
        {links.map((link) => (
          <React.Fragment key={link.label}>
            {link.render ? (
              React.cloneElement(link.render, {}, link.label)
            ) : (
              <a href={link.href} className="underline-offset-4 hover:underline">
                {link.label}
              </a>
            )}
          </React.Fragment>
        ))}
      </nav>
      <span>{license}</span>
      {sourceLink ? (
        <a {...sourceLink} rel="noopener">
          {sourceLink.label}
        </a>
      ) : null}
    </footer>
  );
}
