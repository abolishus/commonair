<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E5 unit C, co-op compositions and page boards in `packages/ui`** for
CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md (especially "Design rules (web)" and
"House primitives"), `.claude/briefs/e5/_common.md` (all of it), `docs/testing/e5-selectors.md`
in full (the routes and test ids are what the boards must make possible), `packages/ui/README.md`,
`packages/ui/tests/source-policy.test.ts`, `packages/ui/tests/pages.test.tsx`, and the existing
co-op boards `packages/ui/stories/pages/Coop.stories.tsx`, `Proposal.stories.tsx`,
`Transparency.stories.tsx` with their fixtures, plus `TrustSafety.stories.tsx` and
`Support.stories.tsx` as recent examples. Do not look outside the repository.

The web unit (D, next batch) builds every E5 page **only** from what you ship. Anything a page
needs that is not in `packages/ui` becomes page-local styling, which the source policy forbids.
So the boards are the design, and the compositions are the contract with unit D.

## You own (write only these)

- `packages/ui/src/**` (new compositions in the right `blocks/*` folder and their exports),
  `packages/ui/stories/**` (new boards, updates to `Coop`, `Proposal`, `Transparency`, their
  fixtures, and composition stories), `packages/ui/tests/**`, `packages/ui/README.md`.
- Nothing else. No new dependencies; add shadcn primitives only with the pinned shadcn CLI (as
  the README describes) if a board genuinely needs one.

## Build

**Compositions** (names are suggestions; reuse and extend existing blocks first:
`BreakdownTally`/`BreakdownBar`, `Timeline`, `ProposalCard`, `CommentItem`/`CommentList`,
`CommentComposer`, `OptionGroup`, `ChoiceToggle`, `SelectField`, `SwitchField`, `FormSection`,
`DataTable`, `StatCard`, `ListPanel`, `KeyValueList`, `ProgressRow`, `AlertCallout`, `PageTabs`,
`EmptyState`, `MoneyAmount`, `RelativeTime`, `ConfirmDialog`, `ChannelAvatar`). Every composition
that renders a spec test id's element must let the page set `data-testid` and `data-*` on that
element (spread rest props onto the root, or per-item `itemProps`/`data` props as `PageTabs` and
`StreamGrid` do). Typical needs:

- **Tally table**: rows per scope (member-wide, streamer, viewer, worker) with yes/no/abstain/
  eligible, turnout and pass/fail per check with its threshold text; decided state only. A
  separate **participation** display (voted of eligible) for open votes, with no yes/no split.
- **Vote panel**: choices yes/no/abstain, current vote, can't-vote state with the reason, submit.
- **Council response**: the published response (stance badge + body), the "no response in time"
  callout, and a respond form (stance + body + submit) for council members.
- **Proposal change editor**: rows of (setting key select, JSON value textarea, protected badge,
  remove), add row, and the derived kind badge; plus a read-only change summary (key, from → to,
  protected).
- **Eligibility list**: per class: eligible or not, basis, progress meter (have / need, hours or
  money), detail text.
- **Share card**: status (none, pending, held, refund pending, refunded, cancelled), amount,
  buy action, manual payment instructions with the reference (copyable), exit actions per class.
- **Statement**: header totals, one line per component (explanation, member value / pool, share,
  amount, cap badge), inputs summary; and a statements list with status and amount.
- **Governance settings list**: key, protected badge, value (pretty JSON or key-value), "set by
  proposal #…" link or "seeded".
- **Patronage admin**: run form (start, end, optional surplus), result summary, periods table
  with status, totals, who ran/approved, an approve action that can be disabled with a reason.
- **Share refunds table** for the treasury, and an **appoint worker** form.

**Boards** (one story per board, `Default` / `Light` / `Mobile320`, fixtures in integer cents,
registered in `tests/pages.test.tsx`): `Pages/Co-op/Membership`, `Pages/Co-op/Proposals` (list
with status filter and empty state), `Pages/Co-op/ProposalForm`, `Pages/Co-op/Council` (council,
method, board seats, elections read-only), `Pages/Co-op/Settings`, `Pages/Co-op/Statements` (list
and one statement), `Pages/Platform/TreasuryCoop` (the treasury's shares and patronage tabs),
`Pages/Platform/AdminCoop`. Update `Pages/Co-op/Proposal` so it shows the E5 states: discussion
(comments, author actions), council review (respond form / response), voting (vote panel +
participation, **no live tally**), decided (tally table per class, reason), and `Coop` /
`Transparency` (governance outcomes with passed/kind, patronage per month). Use stories' args or
separate named stories for the states.

Rules: base-lyra on Base UI, Hugeicons, Rubik, tokens only (no hex), dark first with a full light
theme, accessible (keyboard, focus, WCAG AA, `prefers-reduced-motion`), responsive to 320 px
with a 16 px gutter and no horizontal scroll, i18n-ready (compositions take labels as props; no
inline English in `src/`), `<IconButton tooltip>` for icon-only controls, no native `title`.

## Tests you must add

- A render test per new composition (props → DOM, `data-testid`/`data-*` pass-through, disabled
  states, the no-tally-while-voting rule in the vote/participation pieces).
- `tests/pages.test.tsx` renders every new board; `tests/source-policy.test.ts` passes without new
  allowlist entries (if one is unavoidable, explain it).
- `bun run build-storybook` succeeds.

## Done means

See `_common.md` "Done means". Your package: `packages/ui` (`bun run test`, `tsc`,
`build-storybook`), lint/fmt on changed paths. In your final message, list every new composition
with its props and how a page sets the spec's test ids through it (unit D's brief is written from
that list).
