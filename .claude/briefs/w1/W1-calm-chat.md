<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1-calm-chat: Calm Chat reading mode, wave reports and user blocks

You are implementing unit W1-calm-chat for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W1-quick-wins.md`,
`.claude/briefs/w1/contract-step.md` (all of it; §0, §1.3 `me.blocks` and `safety.report`, §2.2
`user_blocks`, §3.3, §4.1, §8.1, §8.2, §10 especially), `docs/product/feature-wins.md` §4.2,
`docs/decisions/0012-media-clock.md` amendment 1 decisions 3, 7, 8 and 9,
`docs/testing/w1-selectors.md` (Calm Chat ids, `e2e-social` extensions),
`apps/web/src/i18n/README.md` and `.claude/briefs/_done-means.md`. Do not look outside the
repository. Work in your own git worktree on a branch named `w1/calm-chat`, created from the commit
the orchestrator gives you (after the W1 and N1 contract steps; run `git merge main` first if main
moved). Wave 1, beside W1-player (which fills `presentation.ts` while you code against its stub).
Checked against `a43aa6b`; recheck line numbers against your base.

**User blocks ship in W1** (decided 2026-10-30: ADR 0012 decision 8 puts them here; ADR 0017's
"W3" line carries a note that it is superseded). Build every "Blocks" item below.

**Surge state on join** (decided 2026-10-30): the chat `joined` frame now carries `surge` (contract
step §1.4), and the contract step's `connection.ts` calls `onSurge` with it, so a viewer who joins
mid-surge sees the `<SurgeBanner/>` hint at once. Keep that wiring in `chat-panel.tsx`: `surge` is
set from the `joined` frame on every (re)join, then follows `surge` frames. Add a `chat-state`
test for a mid-surge join.

**Chat replay UI is deferred to W2** (decided 2026-10-30); this unit builds no replay panel.

## Why

Large chats are unreadable, and nearly unusable with a screen reader; Twitch has no per-viewer
reading mode (feature-wins §4.2). Calm Chat is client-side: it collapses waves of identical
messages, limits how many distinct lines appear per second, announces a short digest instead of
every line, and never hides what matters (mentions of you, moderators, the broadcaster). Replay
promises that people you block stay hidden (ADR 0012 decision 7), which needs a block feature
viewers can actually use (decision 8): that ships here.

## You own (write only these)

- `apps/web/src/chat/calm/**` (new: `reducer.ts`, `governor.ts`, `digest.ts`, `normalize.ts`,
  `settings.ts`, components), `apps/web/src/chat/{chat-panel.tsx,state.ts,view.ts,mod-menu.tsx}`
  (keep the `<SurgeBanner/>` mount, the `settings`/`surge`/`gateDenied` state that feeds its props
  and the `chat-replay-disclosure` line the contract step put in `chat-panel.tsx`)
- Blocks: `services/api/src/routes/me-blocks.ts` (stub: `meBlocks`), `services/api/src/blocks/**`
  (new, if you need helpers), `apps/web/src/components/blocks/**` (stub `blocked-users.tsx`),
  `apps/web/src/chat/blocks.ts` (new: the live-chat block set)
- Stories: `packages/ui/src/blocks/media/**` is **not** yours; put Calm Chat stories under
  `apps/web` tests or, if a story needs `packages/ui`, send a contract request. Wave rows render
  with the existing `ChatMessage` composition plus your own small component in `apps/web/src/chat/calm/`.
- i18n: `apps/web/src/i18n/locales/en/w1-calm-chat.json`, `keys/w1-calm-chat.gen.ts` (prefixes
  `calmChat.`, `blocks.`)
- Tests: `apps/web/tests/calm-*.test.ts(x)` and `apps/web/tests/chat-panel*.test.tsx` (new), the
  existing `chat-state.test.ts`, `chat-events.test.ts`, `chat.test.ts` and `e7-chat.test.tsx` where
  your changes require it, `services/api/tests/me-blocks*.test.ts`. Not yours: new
  `chat-connection*` tests (W1-player) and `chat-gate*`/`surge-banner*` tests (W1-watch-gate)
- Harness: `harness/src/w1/calm.ts` (`stepFlood`, `stepBlock`), `harness/tests/w1/calm.test.ts`
- Docs: `docs/viewers/calm-chat.md` (new: what it collapses, what it never hides, blocks)

Read-only, in particular: `apps/web/src/chat/{connection.ts,presentation.ts,messages.ts,events.ts,interact/**,surge-banner.tsx}`,
`apps/web/src/player/**`, `apps/web/src/components/safety/report-dialog.tsx` (the contract step
added `messageIds`), `apps/web/src/components/mod/**`, `packages/contracts/**`, `packages/db/**`,
`services/api/src/routes/{me,safety}.ts`, `services/chat/**`, `harness/src/w1/{steps,kit,selectors}.ts`,
`harness/scenarios/e2e-social.ts`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `ServerFrame` `message` (`ChatMessage` now has `mediaTs`), `delete`, `clear`, `ban`, `surge`
  (watch-gate's banner handles it, not you), `NOTICE_CODES`.
- `safety.report` with `subjectType: "message_set"`, `subjectId` (one of them) and `messageIds`
  (2–50, one channel); `MESSAGE_SET_RULES`.
- `me.blocks.{list, ids, add, remove}` (session callers only), `BlockedUser`, `BLOCK_RULES.maxPerUser`
  (1000), table `user_blocks (user_id, blocked_user_id, created_at)` with the self-block check.
- `presentationQueue({ channel, creatorView })` from `apps/web/src/chat/presentation.ts`
  (`present(item, show)`, `syncChat`), ADR 0012 decision 3: chat lines are not held by default,
  own messages never.
- Core keys `chat.replayDisclosure` and `chat.replayDisclosureLink`: the contract step already
  renders them in the chat input area (an unused key would fail `i18n.test.ts`); keep that line.
- Account export `blocks.json` and account-deletion of `user_blocks` rows: done by the contract step.
- Test ids in `docs/testing/w1-selectors.md`; the existing `chat-message`, `chat-message-actions`,
  `chat-mod-timeout`, `chat-mod-ban` ids stay.

## What is there today (verified at `a43aa6b`; recheck against your base)

- `chatReducer` (`apps/web/src/chat/state.ts:41-57`): rows of messages, notices and events, capped
  at `MAX_MESSAGES` (200, `connection.ts:52`); moderation marks rows deleted.
- `ChatPanel` (`apps/web/src/chat/chat-panel.tsx`, 304 lines): connection handlers dispatch into
  the reducer (:97-125); rows render with `ChatMessage` from `@commonair/ui/blocks/media`
  (:245-290); moderators get `ModMenu` per message (`mod-menu.tsx`, timeout and ban). No block
  action, no per-viewer reading mode, no `aria-live` region for messages.
- Reports: `components/safety/report-dialog.tsx` takes `subjectType`/`subjectId` (+ `messageIds`
  after the contract step).
- `me.ts` composes `meEnforcement` from its own file (`routes/me.ts:35`, `:264`): `me-blocks.ts`
  follows the same pattern.

## Build

1. **Normalization (`calm/normalize.ts`, pure).** Key = NFKC, zero-width and bidi-control
   characters stripped, whitespace collapsed, case-folded. **Never merge messages that differ by a
   word**: compare token sequences, so "you are great" and "you are [slur]" never share a key
   (feature-wins §4.2: hashing must not merge messages that differ by a slur token). Emote-only
   bodies key on their emote ids.
2. **Wave reducer (`calm/reducer.ts`, pure).** Groups messages with the same key in a 5 s window
   into one wave row (`count`, distinct `senders`, first and latest message); a wave expands to its
   messages; it never contains a held message, a message mentioning the viewer, or one from the
   broadcaster or a moderator. Harassment waves show the sender count. Deleted and banned messages
   leave the wave (and the count drops).
3. **Rate governor (`calm/governor.ts`, pure, clock injected).** At most N distinct rows per second
   (default 3, user setting 1–10); priority: mentions of me, broadcaster, moderators, replies to
   me, first-time chatters (first message this session), then the rest; subscriber priority off by
   default (setting). Overflow is dropped from view (not from the log) and counted in the digest.
   Mentions of the viewer are never dropped.
4. **Digest (`calm/digest.ts`).** One `aria-live="polite"` region updated at most every ~5 s:
   "12 new messages, 2 waves (PogChamp ×312), 1 mention of you". The digest interval stays fixed
   (feature-wins open question: not user-tunable in v1).
5. **Settings** in `localStorage` inside try/catch (render correctly without it): on/off (default
   off; on by default when `prefers-reduced-motion` is set is **not** done: off for everyone),
   rows per second, subscriber priority. j/k moves focus between rows, a shortcut jumps to the next
   mention (documented in the panel's keyboard help), `prefers-reduced-motion` turns off row
   animations. **Moderators always see raw chat** (Calm Chat is hidden for `canModerate`).
6. **State integration.** `state.ts` keeps the raw log; Calm Chat is a view over it (the reducer
   reads the log, never mutates it), so turning it off shows every line. Route chat lines and
   inline events through `presentationQueue` (alerts and events `kind: "alert"`, chat lines
   `kind: "chat"`, own messages `own: true`); with the stub it shows everything at once.
7. **Report wave.** On a wave row, `chat-report-wave` opens the report dialog with
   `subjectType: "message_set"`, `subjectId` = the first message, `messageIds` = the wave's
   messages (cap 50, newest first).
8. **Blocks.**
   - API (`routes/me-blocks.ts`): `list` keyset by (`created_at` desc, blocked user id) with
     `UserPublic` picks; `ids` returns every id (≤ 1000); `add` by username: unknown or deleted →
     `NOT_FOUND`, yourself → `BAD_REQUEST`, already blocked → returns the row (idempotent), at the
     limit → `PRECONDITION_FAILED` `block_limit`; `remove` idempotent. Blocking a moderator or the
     broadcaster is allowed (it only changes what you see). No audit row (not a moderator action),
     no event (nothing else consumes it).
   - Live chat (`chat/blocks.ts` + the panel): load `me.blocks.ids` when signed in; messages from
     blocked users are not rendered (not just collapsed), never counted in waves or the digest,
     and replies quoting them show "a blocked user". Update the set at once after a block or
     unblock in this tab.
   - The per-message menu (`mod-menu.tsx`, keep the file): shown to every signed-in viewer on
     others' messages; "Block <name>" (`chat-user-block`, a `ConfirmDialog`) for everyone,
     timeout and ban as today for moderators.
   - `/settings/privacy` section (`components/blocks/blocked-users.tsx`): the list with unblock,
     `EmptyState` when empty, paged.
9. **Disclosure and media time on rows.** The contract step renders `chat-replay-disclosure` in the
   chat input area (ADR 0012 decision 9); keep it visible in Calm Chat and raw mode, small text, not
   a modal. Render `data-media-ts={message.mediaTs ?? ""}` on every `chat-message` row (the selectors
   doc lists it; `timeline-sync` reads it).
10. **Harness.** `stepFlood(run: SocialExtension)`: bots (signed-in API chat clients) send 50 msg/s
    for 10 s, mixing a repeated body, varied bodies and mentions of the fan; the fan's page has Calm
    Chat on; assert at most 3 distinct rows appear per second (sample the DOM each 250 ms), every
    mention row appears, the digest updates at most every 5 s, and the chat panel has no
    accessibility violations. axe-core is **not** a dependency anywhere in the repo (checked at
    `a43aa6b`). Decided 2026-10-30: `@axe-core/playwright` is allowed **only** through a contract
    request to add it to `harness`, carrying the full `bun scripts/vet-package.ts
    @axe-core/playwright` output; verify its license from its repository at the version you vet (it
    must be OSI-approved and pass `bun scripts/check-licenses.ts`). If the license check or the
    vetting fails, drop axe: the check uses the in-repo approach instead (the panel's roles, names
    and live region through Playwright's `page.accessibility.snapshot()` / `getByRole`), and you say
    so in your final message. Until the orchestrator lands the dependency, write the in-repo check
    and leave the axe call behind a clearly marked `TODO(axe)`. `stepBlock(run)`: as the
    selectors doc.

## Tests you must add

- Unit, exhaustive: normalization (NFKC, zero-width, bidi, case, a slur-token pair never merged,
  emote-only); reducer (empty window, window boundary at exactly 5 s, mention/held/broadcaster
  never collapsed, delete and ban shrink a wave, expand); governor (priority order, overflow
  counted, mentions never dropped, rows-per-second setting, subscriber priority toggle); digest
  text and cadence; settings with `localStorage` throwing.
- Component: wave row in dark and light at 320 px (render tests standing in for stories), the
  block menu for a viewer vs a moderator, the disclosure line, blocked users hidden.
- API integration: `me.blocks` add/list/ids/remove, self-block, unknown user, idempotency, the limit
  (seed 1000 rows), app tokens refused, pseudonymized (deleted) target refused.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` in `apps/web` and `harness`; `bun --bun vp test run` and `bun run
test:int` in `services/api`; `bunx tsc
-p` for each; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run
i18n:check` in `apps/web`; `reuse lint`). Never run `bun run verify`, `verify:full`, a harness
scenario against a stack, `podman compose` or `scripts/infra.ts`. `git status` shows only your
paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts per package, branch and sha, contract requests (exact diffs), proposed PROGRESS text,
anything left undone, and the commands the user runs live: `bun harness/src/cli.ts run e2e-social
--set w1=flood,block` on the harness stack, plus a manual check with VoiceOver or NVDA on a busy
chat.
