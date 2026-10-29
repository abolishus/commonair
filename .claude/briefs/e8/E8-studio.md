<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8-studio: the `/interact` and `/bot` studio pages

You are implementing unit E8-studio for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md
(especially "Design rules (web)" and "House primitives"), PLAN.md and docs/architecture.md first,
then `.claude/briefs/next/E8-interactivity-bot.md`, `.claude/briefs/e8/contract-step.md` (§1.3,
§8, §10, §11, §14), `docs/decisions/0026-interactivity-policies.md`,
`docs/decisions/0029-i18n.md` and N2-core's catalog README/format as merged,
`docs/testing/e8-selectors.md` (Studio nav, Polls, Predictions, Raids, Goals, Channel bot;
scenario `interact` step 5 and `channel-bot` step 6), `docs/testing/e6-selectors.md` (the
`/overlays` studio page you mirror) and `.claude/briefs/_done-means.md`. Do not look outside the
repository. Work in your own git worktree on a branch named `e8/studio`, created from the commit
the orchestrator gives you: **wave 2**, after the E8 wave-1 units and N2-core merged (run `git
merge main` first if main moved).

## Why

Streamers need pages to run polls, predictions, raids and goals and to configure the channel bot.
The routes exist as placeholders (contract step §8) and every API they call is implemented by the
wave-1 units.

## You own (write only these)

- `apps/web/src/routes/_studio/interact.tsx`, `apps/web/src/routes/_studio/bot.tsx` (fill the
  placeholders; never add, rename or remove a route file)
- `apps/web/src/components/interact-studio/**`, `apps/web/src/components/bot-studio/**` (new)
- `apps/web/src/lib/interact-studio.ts`, `apps/web/src/lib/bot-studio.ts` (new: types from the
  `Api`, pure view helpers, error-code mapping)
- `packages/ui/src/blocks/interact-studio/**` (new block directory; exported by the existing
  `./blocks/*` wildcard) and `packages/ui/stories/InteractStudio*.stories.tsx`. Blocks take every
  string as a prop: no `UiMessages` keys (N2-core rule)
- i18n: `apps/web/src/i18n/locales/en/e8-studio.json` (keys `interact.*` and `bot.*`, ICU plurals
  for counts) and the regenerated `apps/web/src/i18n/keys/e8-studio.gen.ts` (`bun run i18n:gen`),
  following "How to add a namespace" in `.claude/briefs/n2/N2-core.md`. N2-core created the
  namespace empty (the orchestrator listed `e8-studio` in `.claude/briefs/batch3/README.md`); if
  it does not exist, stop and send a contract request, never create it.
  Layout follows rule 6 of that recipe: `apps/web/tests/logical-css.test.ts` fails on
  physical-direction classes in `apps/web/src` and in any new `packages/ui/src` file (yours are
  new), so use logical classes or a same-line `rtl-physical: <reason>` comment
- Tests: `apps/web/tests/e8-studio*.test.ts(x)`, `packages/ui/tests/interact-studio*.test.tsx`
- Harness: `harness/src/e8/studio.ts` (`stepInteractStudio`, `stepBotStudio`),
  `harness/tests/e8/studio.test.ts`

Read-only, in particular: `apps/web/src/routeTree.gen.ts`, `apps/web/src/lib/nav.ts`,
`apps/web/src/routes/_studio.tsx`, every other i18n namespace and N2-core's generator and loader,
`packages/ui/src/components/**` (add nothing there; a new shadcn component is a contract request
the orchestrator adds with the shadcn CLI), every other `packages/ui/src/blocks/*`,
`packages/contracts/**`, `services/**`, `harness/src/e8/{steps,kit,selectors}.ts`,
`harness/scenarios/*`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `docs/testing/e8-selectors.md`: every test id in Polls, Predictions, Raids, Goals and Channel bot,
  exactly (the orchestrator adds the e8 check to `apps/web/tests/selectors.test.ts` after you and
  E8-viewer merge; it fails on a missing id).
- API (`packages/contracts/src/api/router.ts`): `interact.polls.current|create|end`,
  `interact.predictions.current|create|lock|resolve|cancel`, `interact.raids.start|cancel|current|setPolicy`,
  `interact.goals.list|create|end`, `bot.settings|updateSettings`, `bot.commands.*`, `bot.timers.*`,
  `bot.variables.*`, `bot.songRequests.list|setStatus`, `bot.points.leaderboard|adjust`. Inputs and
  bounds as declared there (poll title ≤ 60, 2-5 choices, 15-1800 s; prediction 2-10 outcomes,
  30-1800 s; goal title ≤ 60; command response ≤ 500; timer `minChatLines` ≥ 1).
- Raid precondition codes the API returns in `error.data.requirement` (`raid_source_offline`,
  `raid_target_offline`, `raid_suspended`, `raid_refused`, `raid_cooldown`), plus `CONFLICT` for a
  pending raid, which you show as `data-code="raid_pending"`: `raid-error` carries the code in
  `data-code` and a translated message (`apps/web/src/lib/coop.ts:598-604` reads `requirement`
  the same way).
- Enums for option items: `RAID_POLICIES`, `GOAL_TYPES`, `USER_LEVELS`, `POINTS_ADJUST_REASONS`.
- Money: a tips goal target is entered in major units and sent in minor units with the
  instance currency (`formatMoney()` / `<MoneyAmount>`, never `toFixed`).

## What is there today (verify against your base)

- `/overlays` (`apps/web/src/routes/_studio/overlays.tsx`, `components/overlays-studio.tsx`) is
  the pattern for a studio page: session guard, `PageContainer`, `PageHeader`, a component keyed
  by channel, load error with retry, toasts on save.
- Studio nav entries `studio-interact-link` and `studio-bot-link` exist (contract step).
- Chat already shows poll and prediction events inline; the viewer cards are E8-viewer's.

## Build

1. **`/interact`.** Sections (cards or tabs; responsive to 320 px): **Poll** (form → live card with
   counts refreshed every 2 s while active, end with `ConfirmDialog`, archive an ended poll),
   **Prediction** (form → live card; lock; resolve per outcome with `ConfirmDialog` naming the
   outcome; cancel with `ConfirmDialog`; after resolve show payouts per outcome from the view),
   **Raid** (target slug input with the live check left to the API, countdown from `executeAt`
   with `<RelativeTime>`, cancel, last raid with status and verified viewers, cooldown, the
   `raid-policy` select saved on change), **Goals** (form, rows with progress (`Progress`
   component), end). Loading states with `<Skeleton*>`, empty states with `<EmptyState>`,
   errors with `interact-load-error` + `interact-retry`.
2. **`/bot`.** **Settings** (switch on/off; on first enable show the created bot account; display
   name; filters; points on/off and name; song requests on/off and queue size; one save), **Commands**
   (table with name, level, cooldown, cost, uses, enabled; create/edit in a `Dialog`; remove with
   `ConfirmDialog`; a short help listing the template variables from
   `docs/streamers/channel-bot.md`), **Timers**, **Variables**, **Song requests** (queue with
   played/skip; links shown as text with `rel="noopener noreferrer nofollow"` when linked, never
   fetched or embedded), **Points** (leaderboard, adjust dialog with reason select; the
   `insufficient_points` error shown inline).
3. Only the owner/editor sees owner-only controls (bot settings, raids and the raid policy,
   goals create/end); moderators see what the API allows them (polls, predictions, commands,
   timers, variables, song requests, points adjust).
   The API is the authority; the UI hides what would be refused.
4. Every string through `t()` from your namespace; plurals in ICU; no inline literals; Hugeicons;
   colors as tokens; keyboard and focus as AGENTS.md requires; `prefers-reduced-motion` for any
   animation.
5. **Harness.** `stepInteractStudio(run)` and `stepBotStudio(run)` exactly as e8-selectors.md
   `interact` step 5 and `channel-bot` step 6 (`harness/src/web/session.ts` `WebSession`,
   `byTestId`), asserting the same outcomes as the API steps through the database or API.

## Tests you must add

- Web (`apps/web/tests/e8-studio*.test.tsx`, Testing Library with mocked `Api`): each form's
  validation bounds and submit payload (tips goal minor units), error-code → message mapping for
  raids, poll/prediction state transitions in the live cards, confirm dialogs before end, resolve,
  cancel and remove, visibility by role, every selector id from the doc present.
- `packages/ui` block tests for any block you add.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` in `apps/web`, `packages/ui` and `harness`; `bunx tsc -p` for each;
`vp lint --deny-warnings` and `vp fmt` on your paths; `vp build` in `apps/web` and confirm `git
diff apps/web/src/routeTree.gen.ts` is empty). Never run `bun run verify`, `verify:full`, a harness
scenario against a stack, dev servers, `podman compose` or `scripts/infra.ts`; the user does every
browser and visual check. `git status` shows only your paths. Commit in your worktree (`git commit
-s`, Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
Final message: what you built, test counts per package, branch and sha, contract requests (exact
diffs), anything left undone, and the commands the user runs live: `bun harness/src/cli.ts run
interact --set steps=5` and `bun harness/src/cli.ts run channel-bot --set steps=6`, plus the pages
to look at (`/interact`, `/bot`, light and dark, 320 px).
