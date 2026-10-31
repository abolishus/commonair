<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# seed-social: accounts, channels, chat and the store every unit builds on

You are implementing unit seed-social for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md;
- `.claude/briefs/seed-full/README.md` and `.claude/briefs/seed-full/common.md`. common.md holds the
  shared rules, the read-only contract and the tests every unit adds; they apply in full here.

Do not look outside the repository. Branch: `seed/social`, from `main`.

**Wave 0.** You run alone. All six other units read what you leave in `ctx.store`, so the store
shape below is fixed: get it right first.

## You own (write only these)

- `harness/src/seed/social.ts`, `harness/src/seed/social/**`
- `harness/tests/seed/social*.test.ts`

## Contracts you must honor (read-only for you)

- `harness/src/seed/types.ts`: `SeedStore.users` (one `SeededUser` per account, `kind` set) and
  `SeedStore.channels` (one `SeededChannel` per streamer).
- `harness/src/seed/accounts.ts`:
  - `FIXED_ACCOUNTS`, `BOT_OWNER`;
  - `bulkStreamerHandle`, `bulkViewerHandle`.
- `harness/src/seed/routes.ts`: `channelOf` resolves to `store.channels` by `ownerHandle`.
- `packages/db/src/demo/`. Reuse:
  - `demoIdentity` and `hashPassword`;
  - the row shapes of `seedDemoRows`: better-auth credential accounts, hashed stream keys, and
    mod_actions with audit rows.

  Import these through `@commonair/db/demo`; don't copy them.

- `packages/db/src/schema/{auth,channels,chat,legal,consent,…}.ts`.
- `@commonair/contracts`: enums, emote and word-filter rules, the chat message limits.

## Build

1. **Accounts:**
   - every `FIXED_ACCOUNTS` entry, with its `platformRole`;
   - `scale.streamers` bulk streamers `s0001…` and `scale.viewers` bulk viewers `v00001…`;
   - the bot account (`bot1`, owned by `streamer1`), shaped the way the API marks a bot.

   All accounts are email-verified and have credential accounts with `hashPassword(ctx.password)`.
   Hashing is slow, so hash once and reuse the hash for every account. Set `banned`'s platform
   suspension flag only if it is a plain column. The suspension record itself is seed-safety's
   `account_actions`. Give `newbie` nothing beyond the account. Locales vary by PRNG across `en`,
   `es` and `en-XA`, with fixed logins on `en`.

2. **Sessions, 2FA and passkeys:**
   - one past session per fixed login and a few bulk sessions, plus an expired session, so
     `/settings/privacy` lists devices;
   - `two_factors` for `admin` and `viewer1`;
   - `passkeys` for `viewer1`. Use synthetic key material in the shape better-auth stores; these
     rows only have to display, not authenticate.
3. **Categories:** a realistic set, with some empty ones.
4. **Channels:** one per streamer (fixed and bulk), each with:
   - title, category, language and tags;
   - `channel_panels`: several for streamer1, none for streamer3;
   - `channel_sub_tiers`: tiers 1–3 for the fixed streamers, priced the way seed-money expects
     (read `@commonair/contracts` for the minimum);
   - `stream_keys`: hashed, as the demo seed does;
   - `emotes`: static assets bundled under `harness/fixtures`. If none exist, generate PNGs with
     `harness/src/png.ts`, so nothing is fetched;
   - `word_filters`: for streamer1, including a regex filter that passes the safe-regex rules.
5. **Channel roles:** as in `chanmod`'s purpose (moderator and VIP on streamer1, editor on
   streamer2), plus a few bulk moderators.
6. **Follows:** a power-law spread, so the fixed streamers have many followers and streamer3 has
   few; viewer1 follows many channels. Backdate them across `historyDays`.
7. **Blocks:** `user_blocks` for viewer1 and viewer2.
8. **Chat:** `scale.chatLines` across channels, weighted toward the fixed streamers.
   - Content: varied, deterministic templates with emotes, mentions and replies, plus a few lines
     that trip streamer1's word filters, recorded as the API would.
   - Backdate them across broadcast-shaped windows. seed-media owns broadcasts, so publish your
     windows as `store.extra.social.chatWindows` (`{ channelId, start, end }[]`) for it to align to.
9. **Moderation:** `chat_bans`, including a timeout for viewer2 on streamer1 and a permanent ban,
   with their `mod_actions` and `audit_log` rows, as in the demo seed.
10. **Legal and consent:** `legal_acceptances` of the current legal documents for every account.
    `legal_documents` is protected and already seeded by migrations, so read it, don't insert.
    Add `consent_records` with a mix of choices.
11. **Outbox:** no `events` rows from direct inserts. Table coverage counts `events` and
    `audit_log` as yours. Mark them covered once:
    - your audit rows exist;
    - the later units' API calls are known to write `events`.

    Note in `notes` that `events` comes from those units.

12. **Store:** fill `users` and `channels` completely. Also publish `store.extra.social`:
    - `chatWindows`;
    - `categoryIds`;
    - `botUserId`.

## Tests you must add

As in common.md, plus:

- Every fixed handle and the bulk counts exist, with the right roles.
- The anchors hold for every user.
- One password hash is shared.
- Follows are power-law.
- Chat totals equal `scale.chatLines`.
- `channelOf` resolves for every streamer handle in `SEED_ROUTES`.
- The int test checks:
  - better-auth can sign in with the seeded credential row (verify with `verifyPassword`);
  - the regex word filter passes the API's validation function, if that function lives in
    `packages/**`.

## Routes you fill

These routes must show data:

- `/` and `/$channel`: panels, chat history, follows;
- `/settings/privacy`: sessions, passkeys, blocks, consents;
- `/chat`: word filters, bans, emotes;
- the social parts of `/dashboard`.

## Done means

common.md "Done means".
