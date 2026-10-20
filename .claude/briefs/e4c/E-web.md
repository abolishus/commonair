<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4c unit E, web trust & safety** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md (all of it: design rules, house primitives), PLAN.md, docs/architecture.md and
`.claude/briefs/e4c/_common.md` first (especially the SAFETY RULES and "Web rules"), then
`docs/testing/e4c-selectors.md` in full ("Routes" and "Test ids" are your spec), the e1–e4b
selector docs for the ids you must keep, `packages/ui/stories/pages/TrustSafety.stories.tsx` (+
its fixtures) for the intended composition, and the E4b web work as the pattern
(`src/routes/_admin.tsx`, `src/routes/_admin/treasury.tsx`, `src/components/money/**`,
`src/i18n/money.ts`, `tests/money*.test.ts(x)`, `tests/composition-ids.ts`,
`tests/selectors-render.test.tsx`). Do not look outside the repository.

**SAFETY RULES (repeated; absolute):** never obtain, generate, download, describe or handle real
CSAM, NCII or other illegal material, and never search for it. Stories, tests and fixtures use
synthetic patterns or neutral placeholders only. Never log or send to analytics anything (there
is no analytics). **T0 material appears only on `/admin/legal`, only for the `legal` role, only
after `legal-evidence-view`, blurred and grayscale until `legal-evidence-reveal`, never cached by
the client (no query persistence, cleared on unmount).** Flagged T1/T2 frames in the mod queue are
**blurred and grayscale by default**, revealed one at a time per page view, never autoplay audio.

## You own (write only these)

- apps/web: `src/routes/_app/takedown.tsx` (new), `src/routes/_app/settings.appeals.tsx` (new),
  `src/routes/_admin/moderation.tsx`, `src/routes/_admin/appeals.tsx`, `src/routes/_admin/legal.tsx`
  (new; non-`legal` users get the not-found page), `src/routes/_app/$channel.tsx` (report button and
  dialog, `mature-gate`, `stream-restricted`; keep every e1–e4b id), `src/routes/_studio/dashboard.tsx`
  (only `moderation-label-notice`), `src/routes/_admin.tsx` (nav entries), `src/components/safety/**`
  (new), `src/components/site-chrome.tsx` (footer `footer-takedown-link`, account-menu links
  `account-appeals-link`, `account-moderation-link`, `account-legal-link`), `src/lib/nav.ts`,
  every upload call site (call `channels.commitUpload` after the presigned PUT and use its key; show
  the generic rejection), `src/i18n/safety.ts` (your catalog, spread into `en.ts`),
  `tests/safety*.test.ts(x)`, `tests/nav.test.ts`, your rows in `tests/composition-ids.ts` and
  `tests/selectors-render.test.tsx`, and in `tests/selectors.test.ts`/`tests/i18n.test.ts` the
  wiring that parses `docs/testing/e4c-selectors.md` like the e1–e4b docs.
- packages/ui: new compositions the pages need that do not exist (e.g. a blurred, grayscale,
  click-to-reveal frame tile with `prefers-reduced-motion` respected; a deadline/SLA countdown on
  `<RelativeTime>`), under `src/blocks/**` with stories and tests, additive prop changes to existing
  blocks (`data-*` passthrough), and `stories/pages/TrustSafety.stories.tsx` updates to show them.
  Report anything else in packages/ui as a contract request.

## Contracts you must honor (read-only for you)

- The procedures and entities listed in `_common.md`; `MATURE_GATE` (`FORBIDDEN`,
  `data.reason = "mature_gate"`) on `playback.start`; `UPLOAD_REJECTED`; `BroadcastSummary.restricted`;
  `Me.role` (`legal`), `me.labels`, `me.confirmMature`; `REPORT_REASONS`, `NCII_RELATIONSHIPS`,
  `MODERATION_REVIEW_DECISIONS`; the ALTCHA field component used by DMCA/sign-up.
- The API is being built in parallel (unit D). Code against the contract types; test the pages
  with mocked clients as the E4b tests do.

## Build

Every route and test id in the spec, nothing more:

1. `/$channel`: `report-open` (signed out → `/signin`), `report-dialog` with `report-reason`,
   `report-details`, `report-submit` (toast, `data-report-id`); `mature-gate` with
   `mature-gate-confirm` / `mature-gate-signin` (also when `playback.start` returns `mature_gate`);
   `stream-restricted` interstitial over a blurred, muted player, `stream-restricted-reveal` only
   for signed-in 18+-confirmed viewers (shows it blurred-off, still no autoplay audio).
2. `/takedown`: `ncii-form` with every field id, ALTCHA, `ncii-submit`, `ncii-receipt` with
   `data-request-id` and `data-deadline-at`; plain-language copy (TAKE IT DOWN Act) and a link from
   `/legal` pages and the footer.
3. `/settings/appeals`: `appeals`, `appeals-empty`, `appeal-row`, `moderation-label-notice`,
   `label-appeal-dialog` (`label-appeal-body` 10–5000, `label-appeal-submit`); the same notice on
   `/dashboard`.
4. `/admin/moderation` (moderators, admins, legal): `modq` with tabs, `modq-item` data attributes,
   `modq-detail`, `modq-frame` (loaded via `moderation.frame`, blurred/grayscale, `data-revealed`),
   `modq-frame-reveal`, `modq-not-scored`, `modq-history` rows, `modq-decision` (`ChoiceToggle`),
   `modq-duration`, `modq-note` (required), `modq-submit` (`ConfirmDialog` for suspend and end
   stream); NCII rows with `data-deadline-at` and `ncii-decision`.
5. `/admin/appeals`: `appealq-item`, `appealq-resolve`.
6. `/admin/legal` (`legal` only): `legal-case`, `legal-evidence` (+ view and reveal),
   `legal-confirm`, `legal-dismiss` (disabled for the first reviewer with the reason shown),
   `legal-ncmec` (+ open, report id, filed at, file), `legal-hold` (never a release control).
7. The account-menu and footer links, nav entries, i18n for every string (`t("key")`), and the
   e4c doc wired into `selectors.test.ts`/`i18n.test.ts`.

## Tests you must add

- Unit/render: every e4c id present in the right state (signed out, signed in, legal vs moderator),
  frames blurred by default and revealed one at a time, evidence not fetched before "view", the
  legal page not-found for non-legal, the mature gate on the `mature_gate` error, the upload flow
  calls `commitUpload` and shows one generic rejection, source policy passes.

## Done means

See `_common.md` "Done means". Your packages: `apps/web` (`bun run test`, `tsc`, `vp build`),
`packages/ui` (`bun run test`, `tsc`, `build-storybook`), lint/fmt on changed paths.
