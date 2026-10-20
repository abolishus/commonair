// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Hands the browser a generated file (the CSV statement) without a server round trip. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  // The byte-order mark makes spreadsheet apps read the file as UTF-8.
  const url = URL.createObjectURL(new Blob(["﻿", text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
