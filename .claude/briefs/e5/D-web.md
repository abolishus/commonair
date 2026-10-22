<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E5 unit D, the co-op web pages** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md (especially "Design rules (web)" and "House
primitives"), `.claude/briefs/e5/_common.md` (all of it), `docs/testing/e5-selectors.md` in full
(routes and test ids are the contract with the harness), ADR 0020, `apps/web/README.md`, and the
patterns in `apps/web/src/routes/_app/transparency.tsx`, `_admin/treasury.tsx`,
`_admin/admin.moderation.tsx`, `src/lib/nav.ts`, `src/components/site-chrome.tsx`,
`src/components/money/**`, `src/i18n/**`, `tests/selectors.test.ts`, `tests/composition-ids.ts`,
`tests/selectors-render.test.tsx`, `tests/source-policy.test.ts`, `tests/i18n.test.ts`. Then the
co-op boards in `packages/ui/stories/pages/` (`Coop`, `Proposal`, `Proposals`, `ProposalForm`,
`Membership`, `Council`, `Settings`, `Statements`, `Transparency`, `TreasuryCoop`, `AdminCoop`):
each page is that board, wired to the API. Do not look outside the repository.

## You own (write only these)

- `apps/web/src/routes/_app/coop*.tsx` (and nested `coop.*` route files per TanStack Start's file
  routing), `apps/web/src/routes/_admin/admin.coop.tsx`, `apps/web/src/routes/_admin/treasury.tsx`
  (the new `shares` and `patronage` tabs only), `apps/web/src/routes/_app/transparency.tsx` and
  `src/components/money/transparency.tsx` (governance and patronage rows), new
  `apps/web/src/components/coop/**`, `apps/web/src/lib/coop.ts`, `src/lib/nav.ts` and
  `src/components/site-chrome.tsx` (the co-op entries only), new `src/i18n/coop.ts` and its
  registration, `apps/web/tests/**` (add the e5 doc to `selectors.test.ts`, composition ids,
  render tests, i18n, source policy), and the generated route tree.

## Contracts you must honor (read-only for you)

- The `coop.*` procedures and entities, `money.treasurer.confirm` (share payments now confirm
  through it), the spec's routes and **every** test id with its `data-*` attributes.
- `packages/ui` compositions as unit C shipped them (`@commonair/ui/blocks/coop` and the
  extensions listed there): **read `.claude/briefs/e5/C-compositions.md`**, which says how a page
  sets each spec test id through them. A missing piece is a contract request, never page-local
  styling.
- Secret ballot in the UI: never show a running yes/no tally before the decision; show
  `participation` only; show the caller's own `myVote`.

## Build

The pages in the spec's "Routes" table, each from its board. Specifics:

- `/coop/membership`: buy share → the manual instructions (`membership-share-instructions` with
  reference, payment id, cents); exit per class through `ConfirmDialog`, saying whether the share
  will be refunded (`shareRefundableOnExit` from `coop.settings`).
- `/coop/proposals/new` (and edit): the change editor offers the setting keys from
  `coop.settings`, marks protected ones, derives the kind (`protected` if any protected key) and
  forces "affects creators" on for protected; JSON values validated client-side, the API decides.
- `/coop/proposals/$id`: all states from the board (draft, discussion, council review, voting,
  decided, applied, withdrawn) with the spec's ids; poll while the status can change (no stale
  vote panel after the window closes; `voting_closed` from the API shows a clear message and
  refreshes).
- `/treasury`: `shares` tab (refund_pending rows → refund dialog) and `patronage` tab (run form,
  result, periods table, approve disabled with the reason for the person who ran it; the API's
  `second_approver` error shows the same reason). Share payments appear in the existing payments
  tab with `data-kind="membership_share"` and confirm as before.
- `/admin/coop`: appoint worker (admins only; others get the not-found page).
- `/transparency`: `transparency-governance` and `transparency-patronage` rows.
- Navigation: `nav-coop`, `account-coop-link`, `account-admin-coop-link` (admins).

## Tests you must add

- `tests/selectors.test.ts` parses `docs/testing/e5-selectors.md` (templated ids like
  `membership-exit-<class>`, `proposal-timeline-<status>`, `vote-choice-<choice>` included) and
  finds every id; composition-delivered ids listed in `tests/composition-ids.ts` and proven by
  `selectors-render.test.tsx`.
- Render tests for each page state that matters (vote panel never shows a split before the
  decision; approve disabled for the runner; drafts editable only by the author; non-admins get
  the not-found page on `/admin/coop`).
- i18n: every new string in `src/i18n/coop.ts`, catalogs disjoint.

## Done means

See `_common.md` "Done means". Your package: `apps/web` (`bun run test`, `tsc`, `vp build`),
lint/fmt on changed paths.
