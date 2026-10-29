// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.oauth.*` (consent, device activation) and `developer.grants.*` (E9-oauth; ADR 0027 §1-2). */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const oauth = {
  request: os.developer.oauth.request.handler(notImplemented),
  decide: os.developer.oauth.decide.handler(notImplemented),
  activation: os.developer.oauth.activation.handler(notImplemented),
  activate: os.developer.oauth.activate.handler(notImplemented),
};

export const grants = {
  list: os.developer.grants.list.handler(notImplemented),
  revoke: os.developer.grants.revoke.handler(notImplemented),
};
