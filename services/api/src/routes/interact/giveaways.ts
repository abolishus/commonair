// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.giveaways.*` (ADR 0039, decision (s)). Contract-step stub: W3-giveaways fills it. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const giveaways = {
  current: os.interact.giveaways.current.handler(() => notImplemented()),
  open: os.interact.giveaways.open.handler(() => notImplemented()),
  enter: os.interact.giveaways.enter.handler(() => notImplemented()),
  close: os.interact.giveaways.close.handler(() => notImplemented()),
  draw: os.interact.giveaways.draw.handler(() => notImplemented()),
  cancel: os.interact.giveaways.cancel.handler(() => notImplemented()),
  verify: os.interact.giveaways.verify.handler(() => notImplemented()),
};
