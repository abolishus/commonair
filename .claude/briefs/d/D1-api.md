<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D1-api: category live counts match the live directory

You are implementing unit D1-api for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md;
- `.claude/briefs/d/README.md`;
- `.claude/briefs/_done-means.md`;
- the design review, finding **F20**.

Do not look outside the repository. This is **wave 1**: work on branch `d/d1-api`, cut from D0's
sha.

## Why

On staging, `/api/categories` reported Art with `liveChannels: 0` while `demo_streamer1` was live
in Art: `/api/search` and `/api/directory/live?category=art` both found it. D1-web's directory
sorts by and shows these counts, so they must agree with the live directory before it ships.

## You own (write only these)

- `services/api/src/routes/directory.ts`: the code that computes `liveChannels` for
  `categories.list` and `categories.get` (`toCategory` at `:339`, and its callers).
- `services/api/tests/directory*`: new or extended tests.

**Read-only:** everything else, including `packages/contracts/**` and `packages/db/**`.

## Build

1. **Find the cause.** Candidates:
   - a cache with a long TTL;
   - a count that excludes mature channels while the directory includes them for the caller;
   - a join on the category id where the broadcast row carries the slug, or the reverse;
   - a count taken from a stale materialization.

   Write the cause in your final message, with the file and line.

2. **Fix it**, so that for any caller the count equals the number of channels that
   `directory.live` returns for that category under the same mature setting. If the API's rule is
   that counts are mature-exclusive on purpose, keep that rule. Say so in the procedure's summary
   comment, and make `directory.live`'s default agree.
3. **Keep it cheap.** One grouped query per list call, never one query per category. A cache is
   fine if its TTL is no longer than the directory's.

## Tests you must add

An integration test, with `createTestDatabase()`, covering:

- two categories, three live channels, one of them mature;
- the counts from `categories.list` and `categories.get` equal the length of `directory.live`
  for each category and mature setting;
- a channel that goes offline drops out of the count within the cache TTL.

## Done means

- The `_done-means.md` checks pass for `services/api`.
- The user's live check: on the seeded stack, for each category, `/api/categories` agrees with
  `/api/directory/live?category=<slug>`.
