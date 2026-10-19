// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "./utils.ts";

/** A router-agnostic link target: `href`, or a router `render` element (e.g. `<Link to="/x" />`). */
export interface LinkTarget {
  href?: string;
  render?: React.ReactElement;
}

type RenderProps = { className?: string; children?: React.ReactNode };

export interface TargetLinkProps {
  target: LinkTarget;
  className?: string;
  children: React.ReactNode;
  [key: `data-${string}`]: string | undefined;
}

/**
 * Renders `children` inside the app's router element (its classes merged with `className`), as a
 * plain `<a href>`, or, with neither, as plain text: an `<a>` without `href` is not a link.
 */
export function TargetLink({ target, className, children, ...dataProps }: TargetLinkProps): React.JSX.Element {
  if (target.render) {
    const element = target.render as React.ReactElement<RenderProps>;
    return React.cloneElement(element, { ...dataProps, className: cn(element.props.className, className) }, children);
  }
  if (target.href)
    return (
      <a href={target.href} className={className} {...dataProps}>
        {children}
      </a>
    );
  return (
    <span className={className} {...dataProps}>
      {children}
    </span>
  );
}
