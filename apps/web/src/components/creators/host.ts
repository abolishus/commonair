// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The instance's host with a trailing slash (`air.example/`), the prefix of a channel address. */
export function instanceHost(publicUrl: string): string {
  try {
    return `${new URL(publicUrl).host}/`;
  } catch {
    return "/";
  }
}
