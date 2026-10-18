// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `url` when it is an absolute http(s) URL, else null (never render `javascript:` and friends). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}
