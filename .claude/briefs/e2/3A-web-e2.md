<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **the E2 web slice** for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md (especially "Design rules (web)" and "House primitives"), PLAN.md ("Milestones"),
docs/architecture.md, `docs/testing/e1-selectors.md` and **`docs/testing/e2-selectors.md` (your
contract)** first. Do not look outside the repository. You work in your own git worktree: run
`git merge main --no-edit` first.

## You own (write only these)

- `apps/web/**`
- `packages/ui/**` only to add a missing shadcn component with the shadcn CLI or to fix a house
  primitive bug you hit (report it); no redesigns.

## Contracts you must honor (read-only for you)

- `docs/testing/e1-selectors.md` and `docs/testing/e2-selectors.md` (every test id, attribute and
  behavior there; E1 ids must keep working — `e2e-basic` still runs).
- `packages/contracts` (`directory.home`, `channels.get` incl. the new optional
  `viewer.following`, `channels.follow/unfollow`, `chat.bans.*`, chat `ServerFrame`s `ban`,
  `delete`, `clear`, `notice`, `joined.me.canModerate`). The API unit is filling
  `channels.get.viewer` in parallel; until it lands, treat an absent `viewer` as "unknown" and
  fall back to `me.follows` only if needed for correctness (document which you chose).

## Build

1. `/` becomes the directory (SSR via the existing server-function pattern in `src/lib`):
   sections from `directory.home` in the order spotlight, new, live, following (following only when
   signed in, only when non-empty), each card the house `<StreamCard>` with the router `<Link>` as
   `render`, `data-testid="stream-card"` + `data-channel`. `<EmptyState>` with `directory-empty`
   when nothing is live; skeletons while loading on client navigation. Keep the E1 sign-up /
   sign-in / dashboard calls to action. Header link `nav-directory`.
2. Channel page: `follow-button` (optimistic toggle with rollback + toast on error, disabled while
   in flight, anonymous → link to `/signin`, hidden on your own channel) and `follower-count`
   (`data-count`, formatted number via the house formatter if one exists, else `Intl` in one
   helper).
3. Chat moderation for moderators (`joined.me.canModerate`): per-message `chat-message-actions`
   `<IconButton tooltip>` → menu (`dropdown-menu` from `@commonair/ui`) with `chat-mod-timeout`
   (600 s, immediate, toast) and `chat-mod-ban` (`<ConfirmDialog>`), both via `chat.bans.ban`.
   Not shown on your own messages. Keyboard accessible.
4. Chat state: handle `ban`, `delete`, `clear` frames by marking affected rows
   `data-deleted="true"` with a translated "message deleted" text; give every row `data-id`;
   render server notices inline as `chat-notice` rows with `data-code` (keep the toast only where
   it adds value).
5. All strings via the i18n catalog; dark + light themes; 320 px wide with no horizontal scroll;
   `prefers-reduced-motion` respected.

## Tests you must add

- Unit tests (`*.test.ts(x)`, the web package's existing setup): chat reducer for ban/delete/clear
  and notices; directory section ordering/empty logic; follow toggle rollback.
- A contract test in `apps/web` that greps the rendered components for every E2 test id in
  `docs/testing/e2-selectors.md` (or parses the doc and asserts each id appears in `src/`).

## Done means

- Do NOT run `bun run verify` (the user runs the gate). Run `cd apps/web && bun --bun vp test run`,
  `bunx tsc -p apps/web`, `vp build` for the web app, and `vp lint`/`vp fmt` on changed files.
- Do not run `podman compose`. If you want to look at the UI, run the web dev server against the
  already-running stack (API at the `.env` `API_INTERNAL_URL`), on a port other than 3000 and 3100.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits, `feat(web): …`), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: what you built, test counts, branch + commit sha, contract requests (exact
  changes needed in files you do not own), anything left undone. Note that the gate was not run.
