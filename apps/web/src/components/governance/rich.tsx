// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/** U+2063 (invisible separator): never in catalog text, so it marks where a node goes. */
const MARK = "⁣";
const SLOT = new RegExp(`${MARK}(\\d+)${MARK}`);

/**
 * One catalog sentence with elements inside it ("Changed by {proposal}" with the link in place),
 * so a sentence is never two keys joined in code (voice guide). `render` calls `t()` with the
 * placeholders it is given; each comes back as its node, in the translation's own order.
 */
export function rich(
  render: (vars: Record<string, string>) => string,
  nodes: Record<string, React.ReactNode>,
): React.ReactNode {
  const names = Object.keys(nodes);
  const vars = Object.fromEntries(names.map((name, i) => [name, `${MARK}${i}${MARK}`]));
  const parts = render(vars).split(SLOT);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part === "" ? null : <React.Fragment key={i}>{part}</React.Fragment>;
    const name = names[Number(part)];
    return <React.Fragment key={i}>{name === undefined ? null : nodes[name]}</React.Fragment>;
  });
}
