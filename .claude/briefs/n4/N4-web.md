<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N4-web: studio federation settings, follower list, admin domain blocks

You are implementing unit N4-web for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md (design rules and house primitives), PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (c), (ac), the path ownership and the shared rules
  are binding.
- `.claude/briefs/w3/contract-step.md`: §2.4 `federation.*`, `instance.info().features.federation`,
  and §6 (the studio settings mount and the `admin.federation` placeholder).
- `docs/decisions/0030-federation.md`, decisions 1, 6 and 7.
- `docs/testing/b7-selectors.md`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: use your own git worktree, on branch
`n4/web`, cut from `main` after wave 1 merged. N4-api implements the procedures beside you, so
build against the contract and stub the client in tests.

## Why

Streamers choose whether their channel federates and can see and remove remote followers. Admins
keep a domain block list. The UI must say plainly what federation does and does not do:

- posts go out;
- replies are not read;
- remote copies can be asked to delete but cannot be forced.

## You own (write only these)

- `apps/web/src/components/federation/**` (fill `settings.tsx`; add `followers.tsx`, `blocks.tsx`)
- `apps/web/src/routes/_admin/admin.federation.tsx` (content)
- `apps/web/src/i18n/locales/{en,es}/n4-federation.json`, `keys/n4-federation.gen.ts`
- `harness/src/n4/web.ts`, `apps/web/tests/n4-*`

Read-only: the rest of `apps/web/src`, `packages/ui/**` and `packages/contracts/**`. Anything
else is a **contract request**.

## Contracts you must honor

- `federation.settings.{get, update}`, `federation.followers.{list, remove}`,
  `federation.admin.blocks.{list, add, remove}` and `federation.admin.keys.rotate`.
- `instance.info().features.federation`: when it is false, the studio section is hidden and the
  admin page explains how to enable federation.
- The test ids in `docs/testing/b7-selectors.md` (`federation-enabled`, `federation-handle`,
  `federation-followers`, `federation-follower-remove`, `federation-block-add`, `federation-blocks`).

## Build

1. **Studio section (`settings.tsx`)**, mounted on the stream settings page by the contract step.
   - An on/off switch (`federation-enabled`).
   - The handle `@slug@domain` with a copy button (`federation-handle`).
   - The plain-language notes:
     - what is posted: go-live, public VODs and clips;
     - mature channels post without images;
     - replies are not read;
     - turning it off or a suspension sends a delete that remote servers may or may not honour;
     - remote followers who are lost must follow again.
   - Turning it off uses a `<ConfirmDialog>`.
2. **Followers (`followers.tsx`).** A list of handle and server, with `<RelativeTime>` for when
   they followed, paged, and `<EmptyState>` when there are none. "Remove" asks for confirmation.
   Handles are shown as text, never as links that load remote content. No remote avatars:
   AGENTS.md rule 4 forbids third-party client-side loads.
3. **Admin (`admin.federation.tsx`, `blocks.tsx`).**
   - The domain block list: add with domain validation and subdomain matching explained, and
     remove with confirmation.
   - "Rotate all keys", with confirmation and an explanation.
   - Every action shows a toast.
4. Use house primitives only (`<IconButton tooltip>`, `<ConfirmDialog>`, `toast.*`,
   `<EmptyState>`, `<Skeleton*>`). Colours come from tokens only. The layout works at 320 px
   with no horizontal scroll, and everything is keyboard reachable. Strings go in
   `n4-federation`, in `en` and `es`, in the same change.
5. **Harness `harness/src/n4/web.ts`.** These are web steps that `federation` uses when `via=web`:
   - turn federation on in the studio;
   - read the handle;
   - see a follower appear;
   - remove a follower;
   - add an admin block.

## Tests you must add

- Web unit tests:
  - the section is hidden when the instance flag is off;
  - the switch, with the confirm on off;
  - copying the handle;
  - the followers list (empty, paged, remove confirm);
  - the admin blocks (validation, add, remove);
  - the rotate confirm.
- An axe check for each component.
- The selectors test passes with your ids removed from `PENDING_B7_IDS`. Ask the orchestrator to
  remove them at merge.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run` in `apps/web` and `harness`;
- `vp build` in `apps/web`;
- `vp lint --deny-warnings` and `vp fmt`;
- the i18n check and `tests/i18n.test.ts`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to check the studio section and the admin page by hand under `en`, `es` and
`en-XA`, at 320 px, in dark and light, keyboard only. Also tell them to run
`bun harness/src/cli.ts run federation --set via=web` once all N4 units are merged.
