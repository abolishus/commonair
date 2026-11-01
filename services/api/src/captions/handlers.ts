// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `vods.captions.{get,update}` (ADR 0011). W2-captions owns this file; the contract step leaves stubs. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const vodCaptions = {
  get: os.vods.captions.get.handler(notImplemented),
  update: os.vods.captions.update.handler(notImplemented),
};
