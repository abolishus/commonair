<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# B8-web: channel panels and banner, jury flag links, grace betting, replay span, giveaway CR9

You are implementing unit B8-web for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md: the design rules and the house primitives.
- PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U6, (n) and (r), the follow-ups table, the path
  ownership and the shared rules are binding.
- `.claude/briefs/b8/contract-step.md`:
  - §3.4 (`verify.me` for CR9);
  - §3.8 (the `channel` prop on the prediction card);
  - §4.3–§4.4 (your steps and test ids).
- The ADRs: ADR 0039 §2 and §3 (accepted 2026-11-02, with the "measured only" standing rule),
  ADR 0038 (the jury), and ADR 0012 amendment 1 (replay).
- `docs/testing/b8-selectors.md` and `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`b8/web`, cut from the contract step's sha. B8-server runs beside you, in other files.

## Why

Five web gaps from batches 6 and 7, each with evidence in the README's follow-ups table:

1. The channel page shows neither panels nor the banner (`apps/web/src/routes/_app/$channel.tsx`,
   167 lines, has no match for either), although `Channel.panels` and `Channel.bannerUrl` are in
   the API answer (`packages/contracts/src/api/entities.ts:109`, `:113`).
2. A jury flag cannot open its case. `ModQueue` keeps its selection in local state
   (`apps/web/src/components/safety/mod-queue.tsx:55-57`), and the flag list only carries
   `data-case-id` (`components/jury/jury-page.tsx:190-192`).
3. The web cannot bet during the 30 s grace after a lock. The card bets only while `active`
   (`apps/web/src/chat/interact/prediction-card.tsx:142`, `:204`), although the server accepts grace
   bets (ADR 0039 §3).
4. A deep seek in the replay starts a fresh span and drops what was loaded
   (`apps/web/src/chat/replay/model.ts:10-13`).
5. Giveaway CR9: the verify page marks your own entry on any giveaway, not only the current one.

## You own (write only these)

- `apps/web/src/routes/_app/$channel.tsx`.
- `apps/web/src/components/channel/{panels,banner}*` (new).
- `apps/web/src/chat/interact/prediction-card.tsx`.
- `apps/web/src/routes/_admin/admin.moderation.tsx` and `apps/web/src/components/safety/mod-queue.tsx`.
- `apps/web/src/components/jury/**`.
- `apps/web/src/chat/replay/**`.
- `apps/web/src/components/giveaways/**`, and the `verify.me` lines of
  `services/api/src/interact/giveaways/service.ts`.
- The namespaces `w3-jury`, `w3-giveaways`, `w3-predictions`, `w2-replay` and `b8-channel` (the
  contract step creates it empty), each in `en` and `es`, with their `keys/*.gen.ts`.
- `harness/src/b8/web.ts`.
- Tests named after these files.

**Read-only:** `apps/web/src/chat/chat-panel.tsx`, `apps/web/src/chat/interact/{state,client,use-chat-interact}.ts`,
`packages/ui/**`, `packages/contracts/**`, and the rest of `services/api`. Anything else is a
**contract request**.

## Build

1. **Panels and banner on the channel page.**
   - **The banner:** `bannerUrl`, when set, shows above the header. It has a fixed aspect ratio, so
     it causes no layout shift (reserve the space), uses `alt=""` because it is decorative, and
     loads lazily. It comes from the instance's own media origin only: the URL is already ours, so
     never rewrite it to a third party.
   - **Panels:** below the player and chat on narrow screens, and beside or below them on wide
     ones. Each panel has its title, its body and an optional image and link.
     - The body is **text**: line breaks are kept, and nothing is parsed as HTML or markdown. If
       the studio's panel editor already renders a safe subset, reuse that renderer and nothing
       else.
     - Links are `rel="noopener noreferrer nofollow ugc"` and `target="_blank"`, with a visible
       external-link icon and its label through `t()`.
     - Images come from our media origin, at a fixed size, lazy, with `alt` from the title.
   - **States:** `<EmptyState>` is not needed (no panels means no section). `<Skeleton*>` while the
     channel loads.
   - **Test ids:** `channel-banner`, `channel-panels`, `channel-panel`. Strings go in `b8-channel`.
2. **Jury flag → case.**
   - `admin.moderation.tsx` gains search params `?tab=<tab>&case=<id>` (TanStack Router
     `validateSearch`), and `ModQueue` reads its initial tab and selection from them.
   - Selecting updates the URL without a navigation (`replace`), so back and forward work.
   - The jury flag list renders a link (`jury-flag-case-link`) to `/admin/moderation?tab=cases&case=<caseId>`
     for a moderation case, or to the report tab for a report.
   - A case id that is not in the loaded page is fetched by id, using the existing case
     procedure. If that answers not-found, the page shows a toast and a cleared selection.
3. **Grace betting.**
   - The card uses the `channel` prop to know the stream is live.
   - After `locked`, for 30 s of wall clock from `lockedAt`, it shows the bet form with a countdown
     (`prediction-grace`), only when the player's `playbackMode` is `live` and its
     `playheadWallclock` is before the lock.
   - It sends `mediaTs` and `playbackMode` as it does today.
   - The server is the judge: a refusal shows its i18n reason and closes the form. Never assume
     acceptance.
   - Offline predictions show no grace (ADR 0039 §3).
4. **Replay deep seek keeps its span.**
   - A seek far past what is loaded starts a second span at the target, and **keeps** the first.
   - Spans merge when they meet. Lines are shown from whichever span covers the playhead.
   - Seeking back into the first span needs no request.
   - Memory is capped: drop the span farthest from the playhead past a total of, say, 5,000 lines.
     Pick and document the number.
   - The model stays free of React and is tested with fake time, as today. The test id
     `replay-span-kept` goes on the panel's root as a data attribute for the harness.
5. **Giveaway CR9.** The verify page (`components/giveaways/verify-page.tsx`) marks the signed-in
   caller's pseudonym (`giveaway-verify-mine`) on any giveaway, from `verify.me`. The API returns
   `me` only for an entrant of that giveaway, read from `giveaway_entries`, and never the salt.
   CR10 stays declined (decision (n)): no usernames.
6. **Everywhere:**
   - house primitives;
   - colours from tokens;
   - 320 px with a 16 px gutter and no horizontal scroll;
   - keyboard reachable, with visible focus;
   - `prefers-reduced-motion` on the countdown;
   - every string in `en` and `es` in the same change.

## Edge cases

- **A channel with 20 panels:** fine on a phone, with no horizontal scroll.
- **A panel with only an image, or only a link:** no empty title box.
- **A suspended channel:** the page already hides content. Panels and the banner are hidden too.
- **A mature channel** before confirmation: the banner is hidden until the viewer confirms 18+, as
  the player is.
- **Grace:** the lock arrives while the form is open, the clock is skewed, or a tab is hidden and
  shown again (recompute from `lockedAt`, never from a local timer start).
- **A stale case link:** a `?case=` for a closed case still opens it read-only.

## Tests you must add

- **Web unit:**
  - the panel rendering: HTML in the body stays text; link `rel`; image lazy and alt; no output
    when there are no panels;
  - the banner's reserved space, and that it is hidden on a mature or suspended channel;
  - the search params round-trip and the selection from the URL;
  - the jury flag link target per subject kind;
  - grace: shown, counting down, hidden after 30 s, hidden offline and in `dvr` mode, and a
    refusal shown;
  - the replay model: two spans, merge, the cap, seek back with no fetch;
  - verify-page "mine" marking.
- **API integration:** `verify.me` for an entrant, null for a non-entrant and anonymous caller, and
  never the salt.
- **axe** on the channel page sections, the mod queue with a selection, the card in grace, and the
  verify page.
- **Harness** `harness/src/b8/web.ts`:
  - `interact`: `grace-bet-web` (a viewer bets within the grace from the web, and the server
    accepts it), `giveaway-verify-mine`;
  - `twitch-import`: `channel-panels-banner` (after the import applies panels, the channel page
    shows them and the banner).
  - The jury link is covered by web unit tests, because the jury steps run in `e5-coop` with
    `jury.enabled` turned on by the step.

## Reviewer focus

- The house primitives are used.
- 320 px works.
- `en` and `es` are both written.
- No remote content or HTML from panel text, and the links are `nofollow ugc`.
- The grace bet is still refused server side outside its rules. The web only offers it.
- The replay cap bounds memory.
- No username appears on the verify page (decision (n)).

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run` in `apps/web` and `harness`;
- `bun run test:int` in `services/api`, for `verify.me`;
- `vp build` in `apps/web`;
- `vp lint --deny-warnings` and `vp fmt`;
- the i18n check and `tests/i18n.test.ts`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run:

```bash
bun harness/src/cli.ts run interact --set b8=grace-bet-web,giveaway-verify-mine
```

They should also check the channel page with panels and a banner, the mod queue link, the grace
countdown and the replay by hand, under `en`, `es` and `en-XA`, at 320 px, in dark and light
themes, keyboard only.
