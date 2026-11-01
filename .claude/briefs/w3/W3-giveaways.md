<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3-giveaways: fair giveaways (commit-reveal draw, free entry, flag off)

You are implementing unit W3-giveaways for CommonAir (repo: /Users/joshe/Repos/bcon). Read these
first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (a), (h), (s), (t), (ac), the path ownership and
  the shared rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.1 `GIVEAWAY_*`;
  - §2.4 `interact.giveaways.*`;
  - §2.6 `channel.giveaway.*` and `GIVEAWAY_JOBS`;
  - §3.1–3.2 the tables and their protections;
  - §4.1 `packages/draw`;
  - §5.4 the plugin stub and the interact web state.
- `docs/product/feature-wins.md` §4.4 "Phase 2 (Wave 3), fair giveaways".
- ADR 0039 (written by the contract step).
- ADR 0015, for verified-watch standing.
- ADR 0026 decisions 3–4, because points and money stay separate.
- `docs/testing/b7-selectors.md` and `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, branch
`w3/giveaways`, cut from the contract step's sha. W3-fair-predictions and W3-surge-raids run
beside you in `packages/interact` and the interact web on other files.

## Why

Giveaway bots on other platforms are black boxes. Ours publishes a commitment before entries
open and reveals the seed after the draw, so anyone can re-run it. Entry is free for everyone
(no purchase, no subscription, no points), and bot accounts can't farm entries, because
eligibility uses verified watching. The feature ships **off** (`GIVEAWAYS_ENABLED=false`) and
stays off until the maintainer turns it on (decision (a)).

## You own (write only these)

- `packages/interact/src/giveaways.ts`, `services/api/src/interact/giveaways/**`,
  `services/api/src/routes/interact/giveaways.ts`, `services/worker/src/interact/giveaways/**`
- `services/chat/src/plugins/giveaway.ts`
- `apps/web/src/components/interact-studio/giveaway-panel.tsx`, `apps/web/src/chat/interact/giveaway-card.tsx`,
  `apps/web/src/routes/_app/$channel_.giveaways.$giveawayId.tsx` (content), `apps/web/src/components/giveaways/**`
- `apps/web/src/i18n/locales/{en,es}/w3-giveaways.json`, `keys/w3-giveaways.gen.ts`
- `harness/src/w3/giveaways.ts`, `harness/tests/w3/giveaways*`

**Read-only:**

- `packages/draw/**`, `packages/interact/src/{index,predictions,raids,polls}.ts`
- `services/api/src/interact/{polls,predictions}/**`, used as patterns
- `services/worker/src/integrity/verified-watch.ts`, `services/chat/src/plugins/**` (other plugins)
- `apps/web/src/chat/interact/{state,client,use-chat-interact}.ts`
- `packages/{contracts,db,config}/**`

Anything else is a **contract request**. That includes the official-rules and terms text, which
goes in `packages/db/src/legal/**` and is orchestrator-owned: send the draft text as a contract
request.

## Contracts you must honor

- **Procedures:** `interact.giveaways.{current,open,enter,close,draw,cancel,verify}`.
- **Tables:** `giveaways`, `giveaway_entries`, `giveaway_winners`, with their protections:
  - the commitment is immutable;
  - the seed must hash to the commitment;
  - winners are append-only;
  - no entry after close;
  - one open giveaway per channel.
- **Rules and flags:** `GIVEAWAY_RULES`; `GIVEAWAYS_ENABLED` and `instance.info().features.giveaways`.
- **Events and jobs:** `channel.giveaway.begin` / `.end` (outbox); `GIVEAWAY_JOBS.close`.
- **`packages/draw`:** `commit`, `verifyReveal`, `draw`, `pseudonym` (with its vectors).

## Build

1. **Logic (`packages/interact/src/giveaways.ts`, pure).**
   - Eligibility check: account age, follow age and verified-watch seconds only. The schema
     must make a subscription, points or payment criterion impossible to express.
   - Entry ordering is by pseudonym, for the draw.
   - Winner selection uses `draw`, with re-draw rules when a winner is ineligible at draw time
     (banned or deleted): draw the next index and record it.
2. **API.** Every procedure answers `FORBIDDEN` with a clear i18n code while `GIVEAWAYS_ENABLED`
   is false.
   - **`open`** (owner and editors):
     - takes the title, prize text (scrubbed, length cap), winner count ≤ 10, an optional chat
       keyword, an optional close time ≤ 24 h, and the eligibility settings;
     - generates `seed` (32 random bytes) and `salt`, stores `seed_commitment = commit(seed)`,
       and keeps the seed server-side (encrypted at rest, using `encryptSecret`) until the draw;
     - emits `channel.giveaway.begin`.
   - **`enter`:** one per account; refuses an ineligible entrant with a reason code; stores
     `pseudonym(salt, userId)`.
   - **`close`** (manual or by the timed job), then **`draw`:**
     - computes the winners, reveals `seed` and `salt`, writes `giveaway_winners`, emits
       `channel.giveaway.end`, and sends winners an in-app notification (existing notifications
       path);
     - writes audit rows at open, close, draw and cancel.
   - **`verify`** (public): returns the commitment, seed, salt, pseudonyms sorted and the winners'
     indices and pseudonyms. Usernames appear only for winners, and only if the winner allows it
     (default: the pseudonym only).
3. **Chat plugin (`plugins/giveaway.ts`).** If a giveaway with a keyword is open, a message that
   equals the keyword enters the sender through the same API logic (a shared function in
   `packages/interact` or an internal call; do not duplicate the rules). The bot reply is
   rate-limited and the plugin never echoes the entry list. It is a no-op while the flag is off.
4. **Web.**
   - **Studio `giveaway-panel.tsx`:** open, live entrant count, close, draw, cancel.
   - **Viewer `giveaway-card.tsx`:** enter button, eligibility reason, "no purchase necessary"
     line, a link to the official rules (instance legal document) and a link to verify.
   - **Public verify page `$channel_.giveaways.$giveawayId.tsx`:** shows the commitment, revealed
     seed and salt, and the entry and winner lists. It re-runs the draw in the browser with
     `packages/draw` and shows "matches" or "does not match".
   - Hide everything when the flag is off.
   - Strings go in `w3-giveaways`, `en` and `es`.

## Tests you must add

- **Unit:**
  - eligibility (each criterion at the edges);
  - the draw against `packages/draw` vectors;
  - re-draw on an ineligible winner;
  - no subscription, points or payment field in the schema;
  - the pseudonym is stable per salt.
- **API integration:**
  - the flag-off refusal;
  - one open per channel (the index);
  - a double entry is refused;
  - an entry after close is refused (by the trigger too);
  - the commitment can't be changed, and a wrong seed reveal is refused (by the trigger);
  - the draw is deterministic given the seed;
  - audit rows are written;
  - outbox events are written;
  - an unverified viewer is refused when verified-watch is required.
- **Chat integration:** keyword entry, and a no-op when the flag is off.
- **Web unit:** the card states, and the verify page's "matches" / "does not match".
- **Harness `interact` extension step `giveaway`** (in `harness/src/w3/giveaways.ts`):
  1. With `GIVEAWAYS_ENABLED=true` (the `w3` overlay), the streamer opens a giveaway with a
     keyword.
  2. Verified viewers enter by keyword and by button.
  3. A viewbot account is refused.
  4. Close and draw.
  5. The harness re-runs the draw from `verify` and matches the winners.
  6. The flag-off instance refuses `open`.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` / `test:int` in `packages/interact`, `services/api`, `services/worker` and
  `services/chat` (one at a time); `bunx tsc -p` each.
- `bun --bun vp test run` in `apps/web` and `harness`; `vp build` in `apps/web`.
- `vp lint --deny-warnings` and `vp fmt` on your files; the i18n check; `reuse lint`.
- `git status` shows only your paths. Commit with `git commit -s`.

Send the official-rules draft and the "no purchase necessary" terms clause as a contract request
(text, marked "not reviewed by counsel; none retained").

Then tell the user to run `bun harness/src/cli.ts run interact --set w3=giveaway`. After that,
they check the card, the studio panel and the verify page by hand, under `en`, `es` and `en-XA`, at
320 px, in dark and light themes, keyboard only.
