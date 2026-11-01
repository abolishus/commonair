// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `jury.*` (ADR 0038, decision (u)). Contract-step stub: W3-jury fills it. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const jury = {
  optIn: os.jury.optIn.handler(() => notImplemented()),
  optOut: os.jury.optOut.handler(() => notImplemented()),
  status: os.jury.status.handler(() => notImplemented()),
  panel: os.jury.panel.handler(() => notImplemented()),
  cases: os.jury.cases.handler(() => notImplemented()),
  vote: os.jury.vote.handler(() => notImplemented()),
  results: os.jury.results.handler(() => notImplemented()),
  flags: {
    list: os.jury.flags.list.handler(() => notImplemented()),
  },
};
