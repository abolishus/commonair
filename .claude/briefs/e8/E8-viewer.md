<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8-viewer: chat poll and prediction cards, points chip, raid follow, goals and chat overlays

You are implementing unit E8-viewer for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md
(especially "Design rules (web)" and "House primitives"), PLAN.md and docs/architecture.md first,
then `.claude/briefs/next/E8-interactivity-bot.md`, `.claude/briefs/e8/contract-step.md` (§1.3,
§1.4, §1.6, §10, §11, §13, §14), `docs/decisions/0026-interactivity-policies.md`,
`docs/decisions/0021-e6-operations-policies.md` (overlay tokens), `docs/decisions/0029-i18n.md`
and N2-core's catalog format as merged, `docs/testing/e8-selectors.md` (Viewer, Overlays,
scenario `interact` step 6), `docs/testing/e6-selectors.md` ("Overlays and alerts") and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on a branch named `e8/viewer`, created from the commit the orchestrator gives you: **wave 2**,
after the E8 wave-1 units and N2-core merged (run `git merge main` first if main moved).

## Why

Viewers can only take part in polls and predictions if chat shows them; a raid only moves an
audience if the viewers' pages follow it; the goals and chat overlay URLs streamers already put in
OBS (E6) still show placeholders.

## You own (write only these)

- `apps/web/src/chat/interact/**` (new: poll card, prediction card, points chip, raid banner,
  their state), and in existing chat files only what wiring needs:
  `apps/web/src/chat/connection.ts` (an `onRaid` handler for the `raid` frame),
  `apps/web/src/chat/chat-panel.tsx` (mount the cards, chip and banner; route `channel.poll.*` and
  `channel.prediction.*` event frames to the cards), `apps/web/src/chat/events.ts` and
  `chat-event-row.tsx` (the incoming `channel.raid` row)
- `apps/web/src/routes/_app/$channel.tsx` only if the raid follow cannot live in the chat panel
  (prefer the panel: it already has the connection)
- `apps/web/src/routes/overlay.goals.tsx`, `apps/web/src/routes/overlay.chat.tsx` (fill them;
  never add, rename or remove a route file), `apps/web/src/components/overlay-goals-page.tsx`,
  `apps/web/src/components/overlay-chat-page.tsx` (new), `apps/web/src/lib/overlay-connection.ts`
  (handle the `goal` SSE event next to `alert`), and delete
  `apps/web/src/components/overlay-placeholder.tsx` once nothing uses it
- `packages/ui/src/blocks/interact-viewer/**` (new: poll card, prediction card, goal bar; every
  string a prop, no `UiMessages` keys) and `packages/ui/stories/InteractViewer*.stories.tsx`
  (E8-studio owns `blocks/interact-studio/**` and `InteractStudio*`: keep your names distinct)
- i18n: `apps/web/src/i18n/locales/en/e8-viewer.json` (keys `chatPoll.*`, `chatPrediction.*`,
  `chatPoints.*`, `chatRaid.*`, `raid.*`, `overlayGoals.*`, `overlayChat.*`; ICU plurals) and the
  regenerated `apps/web/src/i18n/keys/e8-viewer.gen.ts`, following "How to add a namespace" in
  `.claude/briefs/n2/N2-core.md` (N2-core created the namespace empty; if it does not exist, stop
  and send a contract request). Also delete exactly the keys `overlay.goalsLater` and
  `overlay.chatLater` from the namespace N2-core moved them to (`locales/en/ops.json` if it kept
  the file name) and regenerate that namespace's `keys/<it>.gen.ts`: an explicit exception to
  N2-core's rule 5 (contract step §10), since N2's i18n test fails on unused keys. Layout follows
  rule 6 of that recipe: `apps/web/tests/logical-css.test.ts` fails on physical-direction classes
  in `apps/web/src` and in any new `packages/ui/src` file (yours are new); the goal bar's fill is
  physical, so it carries a same-line `rtl-physical: <reason>` comment
- Tests: `apps/web/tests/e8-viewer*.test.ts(x)`, the cases you add to
  `apps/web/tests/chat-events.test.ts`, `apps/web/tests/overlay-connection.test.ts`, and the goals
  and chat cases of `apps/web/tests/e6-overlay-root.test.tsx` (they assert the placeholder today, :95-97);
  `packages/ui/tests/interact-viewer*.test.tsx`
- Harness: `harness/src/e8/viewer.ts` (`stepViewer`), `harness/tests/e8/viewer.test.ts`

Read-only, in particular: `apps/web/src/routeTree.gen.ts`, `apps/web/src/lib/nav.ts`, every
other i18n namespace and N2-core's generator and loader, `apps/web/src/player/**`,
`apps/web/src/components/overlay-alerts-page.tsx` (read it as the pattern),
`packages/ui/src/components/**` (a new shadcn component is a contract request), other
`packages/ui/src/blocks/*`, `packages/contracts/**`, `services/**`,
`harness/src/e8/{steps,kit,selectors}.ts`, `harness/scenarios/*`. Anything else is a **contract
request** with the exact diff.

## Contracts you must honor (read-only for you)

- `docs/testing/e8-selectors.md` Viewer and Overlays ids, exactly (the orchestrator adds the e8
  check to `apps/web/tests/selectors.test.ts` after you and E8-studio merge).
- API: `interact.polls.current|vote` (`extraVotes` 0-100; `insufficient_points`),
  `interact.predictions.current|bet` (`points` 1-250,000; the owner, editors and moderators get
  `FORBIDDEN`), precondition codes in `error.data.requirement` (`insufficient_points`), `bot.points.balance` (`LoyaltyBalance` with `enabled` and `pointsName`),
  `interact.overlays.state` (overlay token: `channelSlug`, `alerts`, `goals`, `eventsUrl`).
- Chat frames (`packages/contracts/src/chat.ts`): `{ op: "event", type: "channel.poll.*" |
  "channel.prediction.*" | "channel.raid", data }` with the §1.4 payloads (validate with
  `EVENTS[type].payload`, drop anything that fails); the new `{ op: "raid", raidId, status, to,
  toDisplayName, executeAt }` control frame on the source channel (`pending` → banner;
  `completed` → navigate to `/<to>`; `canceled` → banner gone).
- SSE `OVERLAY_EVENTS_PATH`: events `alert`, `goal` (data `Goal`), `ping`, `revoked`.
- ADR 0026: the count shown is the verified count (render `viewers` as given); points have no cash
  value (no wording that suggests money); song requests are not shown to viewers.

## What is there today (verified at `c0c16fd`; recheck against your base)

- `apps/web/src/chat/connection.ts:143-186` dispatches frames; `default` ignores unknown ops, so
  the `raid` frame is dropped until you handle it. `chat-panel.tsx:90` turns event frames into
  rows through `chatEventView` (`events.ts:12-…`: only subscribe, gift, tip today; poll and
  prediction frames return `null` and vanish).
- `overlay.goals.tsx` and `overlay.chat.tsx` render `OverlayPlaceholder`
  (`components/overlay-placeholder.tsx`); `components/overlay-alerts-page.tsx` and
  `lib/overlay-connection.ts` are the token, state, `EventSource` and `revoked` handling to reuse
  (transparent page, no chrome, `no-referrer`, `data-state="refused"`).
- The chat WebSocket accepts anonymous readers (sending needs sign-in), so the chat overlay joins
  `channelSlug` from `overlays.state` without a user token.

## Build

1. **Poll card** (`chat-poll`, pinned above the log): load `interact.polls.current` on join;
   update counts from `channel.poll.progress` frames and switch to results on `end`; signed-in
   viewers vote with one click (`chat-poll-choice`), then see `chat-poll-voted`; when
   `pointsPerExtraVote > 0` and the channel's points are on, an extra-votes input with the cost
   shown in points (`chat-poll-extra`); errors (`insufficient_points`, ended) inline. Signed-out
   viewers see counts and a sign-in hint. Collapsible; keyboard reachable; counts announced
   politely (`aria-live="polite"`, throttled).
2. **Prediction card** (`chat-prediction`): outcomes with points and users from events, an amount
   input bounded by the viewer's balance and 250,000, one bet button per outcome, then
   `chat-prediction-my-bet`; locked → no betting; ended → refetch `current` and show the payout
   or the refund. Hidden controls for the owner, editors and moderators.
3. **Points chip** (`chat-points`): signed-in viewers when `enabled`; `bot.points.balance` on join,
   after own votes and bets, and every 60 s; `pointsName` from the response.
4. **Raid follow.** `onRaid`: `pending` → `raid-banner` with a countdown to `executeAt`
   (`<RelativeTime>`); `completed` → navigate to `/<to>` with the router (not a full reload); the
   source broadcaster's own page does not navigate. `canceled` → remove the banner. Incoming raid
   in the target's chat: a `chat-event` row with `data-type="channel.raid"`, `data-user` (raider
   login) and `data-viewers`.
5. **Goals overlay** (`/overlay/goals?token=`): `overlay-goals` with `data-state`; bars for the
   open goals from `state.goals`, updated by `goal` events; an achieved goal shows its full bar
   briefly, then leaves; tips goals format with `formatMoney()`; `prefers-reduced-motion` → no
   animation; transparent and chrome-less like the alerts overlay; `revoked`/401 → `refused`.
6. **Chat overlay** (`/overlay/chat?token=`): read-only chat of `channelSlug` (`overlay-chat`,
   `overlay-chat-message`), emotes rendered like the panel, honours `delete`, `clear` and `ban`
   frames, never shows held messages, keeps the last 30 messages, each fading after 60 s
   (reduced motion: no fade), no input, no avatars fetched from third parties.
7. Remove `OverlayPlaceholder` and its two keys; keep `overlay.goalsTitle`/`overlay.chatTitle`
   (the heads use them).
8. **Harness.** `stepViewer(run)` exactly as e8-selectors.md `interact` step 6 (`WebSession`,
   `byTestId`; two browser contexts: the viewer on the source channel, the overlay page).

## Tests you must add

- Web: event-frame routing (poll/prediction frames to cards, malformed frames dropped, raid row
  view), poll card vote and extra-vote flows with the API mocked, prediction bounds and locked
  state, chip visibility by `enabled` and sign-in, raid banner countdown and navigation (and none
  for the broadcaster), goals overlay from state plus `goal` events and `refused`, chat overlay
  applying delete/clear/ban and the 30-message cap, reduced motion; every selector id present.
- `packages/ui` block tests for the cards and the goal bar.

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
interact --set steps=6`, plus the pages to look at (a channel during a poll, a prediction and a
raid; `/overlay/goals` and `/overlay/chat` in OBS or a browser; light and dark; 320 px).
