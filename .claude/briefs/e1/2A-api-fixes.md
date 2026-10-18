You are fixing **open API review findings (2A round two)** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, HANDOFF.md ("Open review findings" → API), PLAN.md and docs/architecture.md
first. Do not look outside the repository.

## You own (write only these)

- `services/api/**`

## Contracts you must honor (read-only for you)

- `packages/contracts`, `packages/db` schema, `packages/config` env schema, `services/chat`'s word
  filter (read it: it has its own shape check + 25 ms budget). Any change needed there is a
  contract request, not an edit.

## Fix (in priority order; each with tests)

1. **HIGH — ReDoS in word filters.** The API's "ReDoS check" accepts catastrophic patterns such as
   `((a+))+$`, `(a|a)*$`, `(a*)*b`, `(.*a){20}`. Replace it with a strict, linear-time-safe subset:
   refuse nested quantifiers, quantified groups containing alternation with overlapping branches,
   backreferences, lookaround, and bounded repeats above a small cap; cap pattern length. Prefer a
   whitelist grammar (literal text, character classes, `\b`, `^$`, single-level `?*+{m,n}` on atoms)
   over a blacklist. Exhaustive unit tests with a corpus of known-catastrophic patterns (must be
   refused) and realistic filter patterns (must pass). If chat should use the same validator,
   write it as a pure module and report a contract request to move it into a shared package.
2. **HIGH — minors can change `birthDate`.** better-auth `update-user` lets users write
   `birthDate`. Refuse it in `databaseHooks.user.update.before` (also `dateOfBirth`-like aliases
   and any other identity fields that must be immutable after sign-up: check `emailVerified`,
   `role`, `banned`, etc. are not user-writable). Integration test through the real auth endpoint.
3. MED — playback mature gate must also honour the category's mature flag.
4. MED — theme `avatarKey`/`bannerKey` and user `image` must be object-storage keys or same-
   instance URLs only; refuse third-party URLs (tracking, breaks the no-third-party rule).
5. MED — better-auth `admin` plugin endpoints bypass audit and safeguards: disable the plugin's
   HTTP endpoints or wrap them so every action writes `audit_log` and respects the same
   safeguards as our own admin procedures.
6. MED — rate-limit subjects: when no trusted proxy is configured but requests arrive with
   `x-forwarded-for` from a proxy, all users collapse to one subject — log a one-time warning; and
   bucket IPv6 by /64 for rate limiting.
7. MED-LOW — relay registration and simulcast target URLs: resolve DNS and refuse private,
   loopback, link-local, CGNAT, multicast and metadata ranges (IPv4 and IPv6, incl. mapped
   addresses); allow `rtmp`/`rtmps` (simulcast) and `https` (relay; `http` only when an explicit
   dev flag in the existing env allows it). Generic errors to clients.
8. LOW — presigned uploads sign `content-length` (or a content-length-range policy); per-recipient
   mail rate limit; interim viewer verification must not pass in under a few seconds of
   playback.
9. Also: publish `UserControlMessage` on `BUS.userControl` where the contract expects it (read the
   contract and chat service to see the consumer); implement `developer.tokens.list/revoke`;
   TOTP integration tests.

Do 1 and 2 first and make sure they are complete and tested even if you run out of time on the
rest; list what remains.

## Tests you must add

- Unit tests for every pure change (validator corpus, IP range checks incl. IPv6 edge cases,
  /64 bucketing). Integration tests (`*.int.test.ts`, `createTestDatabase()`) for the auth hook,
  category mature gate, theme key validation, admin audit, tokens list/revoke, TOTP.

## Done means

- `bun run verify --quick` passes plus `bun run --filter @commonair/api test:int` (infra is up:
  `bun scripts/infra.ts test`; never drop databases you did not create).
- No files outside `services/api/**` changed (`git status`).
- Commit in your worktree (small Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Final message: each finding → fixed / not fixed (why), test counts, contract requests.
