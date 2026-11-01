// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `twitchImport.*` (ADR 0031, decision (b)). Contract-step stub: N3-import fills it. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const twitchImport = {
  status: os.twitchImport.status.handler(() => notImplemented()),
  connect: os.twitchImport.connect.handler(() => notImplemented()),
  preview: os.twitchImport.preview.handler(() => notImplemented()),
  start: os.twitchImport.start.handler(() => notImplemented()),
};
