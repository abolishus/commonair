// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/** A router-agnostic link target: `href`, or a router `render` element (e.g. `<Link to="/x" />`). */
export interface LinkTarget {
  href?: string;
  render?: React.ReactElement;
}

/** Renders `children` as a plain `<a href>` or inside the app's router link element. */
export function TargetLink({
  target,
  className,
  children,
}: {
  target: LinkTarget;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (target.render)
    return React.cloneElement(target.render as React.ReactElement<{ className?: string }>, { className }, children);
  return (
    <a href={target.href} className={className}>
      {children}
    </a>
  );
}
