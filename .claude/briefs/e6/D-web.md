<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit D: web routes for E6

You are implementing unit D of slice E6 for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, `.claude/briefs/e6/_common.md` and `docs/testing/e6-selectors.md` first. Do not look
outside the repository. Batch 1 (API, worker, `packages/ui`) is merged on `main`: build on its
compositions and API.

## You own (write only these)

- `apps/web/src/**`, `apps/web/tests/**`, `apps/web/messages/**` (or wherever the web i18n
  catalog lives)

## Contracts you must honor (read-only for you)

The spec's Routes and Test ids, the `packages/ui` blocks from unit C, the API contract.

## Build

1. `/dashboard` simulcast section (`stream.simulcast.*`, status polling every 5 s while live).
2. `/overlays` (studio): alert configs, test alert, token panel (expiry choice → `expiresAt`
   instant or null; the URL is shown once from the create response and never stored in client
   storage or query caches beyond the page's state).
3. `/overlay/alerts` (outside every layout and auth guard, transparent `html`/`body`, no
   analytics or chrome, `<meta name="referrer" content="no-referrer">`): read `token` from the
   query, call `interact.overlays.state` with it, open an `EventSource` on `eventsUrl`, feed the
   alert queue, `data-state` per the spec, on `revoked`/401 stop reconnecting. Reconnect with
   backoff on network errors only. `/overlay/goals` and `/overlay/chat`: `<EmptyState>`.
4. `/content` (studio): VODs and clips of the owner's channel with update/remove.
5. `/settings/privacy`: exports (request, list polling while queued/running, download link) and
   deletion (request, status, cancel). Add Privacy to the account settings navigation and
   Overlays/Content to the studio sidebar.
6. Every new page: loading skeletons, error state with retry (not a skeleton forever), i18n
   strings, keyboard and focus, both themes, 320 px.

## Tests you must add

Route/component tests per page (test ids, API calls with the right inputs, the overlay page's
state machine with a fake `EventSource`, the expiry choice mapping), and the source-policy test.

## Done means

As in `_common.md`. Run `apps/web` tests you added or touched, `bunx tsc -p apps/web --noEmit`,
lint/fmt of your paths and `vp build` in `apps/web`.
