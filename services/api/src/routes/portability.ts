// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `portability.*` (ADR 0037, decisions (j)–(p)). Contract-step stub: W3-portability fills it. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const portability = {
  links: {
    list: os.portability.links.list.handler(() => notImplemented()),
    create: os.portability.links.create.handler(() => notImplemented()),
    revoke: os.portability.links.revoke.handler(() => notImplemented()),
    resolve: os.portability.links.resolve.handler(() => notImplemented()),
  },
  grants: {
    set: os.portability.grants.set.handler(() => notImplemented()),
    mine: os.portability.grants.mine.handler(() => notImplemented()),
  },
  move: {
    set: os.portability.move.set.handler(() => notImplemented()),
    clear: os.portability.move.clear.handler(() => notImplemented()),
  },
  bundle: {
    create: os.portability.bundle.create.handler(() => notImplemented()),
  },
  imports: {
    upload: os.portability.imports.upload.handler(() => notImplemented()),
    preview: os.portability.imports.preview.handler(() => notImplemented()),
    start: os.portability.imports.start.handler(() => notImplemented()),
    get: os.portability.imports.get.handler(() => notImplemented()),
    list: os.portability.imports.list.handler(() => notImplemented()),
  },
};
