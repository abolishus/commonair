// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

/**
 * A catalog string with one `{name}` placeholder filled by a React node (a `<RelativeTime>`, a
 * `<time>`), for labels the `@commonair/ui` blocks take as `(node) => ReactNode`. Without the
 * placeholder the text is returned as is.
 */
export function fillNode(template: string, name: string, node: React.ReactNode): React.ReactNode {
  const marker = `{${name}}`;
  const at = template.indexOf(marker);
  if (at < 0) return template;
  return (
    <>
      {template.slice(0, at)}
      {node}
      {template.slice(at + marker.length)}
    </>
  );
}
