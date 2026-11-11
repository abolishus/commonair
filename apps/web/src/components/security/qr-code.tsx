// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A QR code drawn in the browser (uqr, MIT, no network): the TOTP set-up's `otpauth://` URI never
 * leaves the page. Dark modules on white in both themes, with a quiet zone, because scanners read
 * that reliably and an inverted code they often do not.
 */
import * as React from "react";
import { encode } from "uqr";

/** One SVG path for every dark module (`border` modules of quiet zone are in the matrix). */
export function qrPath(text: string): { size: number; d: string } {
  const qr = encode(text, { ecc: "M", border: 2 });
  let d = "";
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size: qr.size, d };
}

export function QrCode({
  value,
  label,
  "data-testid": testId,
}: {
  value: string;
  /** What the code is, for screen readers ("QR code to add your account to an authenticator app"). */
  label: string;
  "data-testid"?: string;
}): React.JSX.Element {
  const { size, d } = React.useMemo(() => qrPath(value), [value]);
  const titleId = React.useId();
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      aria-labelledby={titleId}
      data-testid={testId}
      shapeRendering="crispEdges"
      className="size-48 shrink-0 bg-white text-black"
    >
      <title id={titleId}>{label}</title>
      <path d={d} fill="currentColor" />
    </svg>
  );
}
