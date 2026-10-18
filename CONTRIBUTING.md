<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Contributing to CommonAir

Thank you for helping build CommonAir, a member-owned cooperative live
streaming platform. This guide covers how to set up, how to get a change
merged, and the rules every contribution follows.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems go to the process in [SECURITY.md](SECURITY.md), never a
public issue.

## Getting set up

You need [Bun](https://bun.sh) 1.4.3, [Go](https://go.dev) (for the relay
node), [Podman](https://podman.io) with `podman compose`, and the
[`reuse`](https://reuse.software) tool. The README covers installing Podman and
bringing up the stack.

```sh
git clone https://github.com/abolishus/commonair.git
cd commonair
bun install
podman compose up      # the whole stack, see README
bun run verify         # the single gate; must be green before you open a PR
```

`bun run verify` runs, in order: format check, lint, typecheck, unit tests,
integration tests, the dependency license allowlist, the stray-domain check,
`reuse lint`, and `go vet` / `go test` for the relay. For a faster inner loop,
`bun run verify --quick` skips integration tests. `bun run verify:full` adds the
full harness scenario (simulated streamers, viewers, bots and load); run it
when you touch ingest, delivery, chat, or anything performance-sensitive.

Formatting, linting, and tests use Vite+ (`vp fmt`, `vp lint`, `vp test`).

## Repository layout

| Path         | What lives there                                                   |
| ------------ | ------------------------------------------------------------------ |
| `apps/web`   | The web app (TanStack Start)                                       |
| `services/*` | Bun services: `api`, `chat`, `irc`, `worker`, `origin`, `media`    |
| `packages/*` | Shared libraries: config, contracts, db, ui, sdk, ledger, and more |
| `relay/`     | The Go member relay node                                           |
| `harness/`   | Local simulation harness: streamers, viewers, bots, load tests     |
| `infra/`     | Compose configurations                                             |
| `docs/`      | ADRs, runbooks, self-hosting, architecture                         |

## Developer Certificate of Origin (DCO)

Every commit must be signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). The
sign-off certifies that you wrote the change, or otherwise have the right to
submit it under the project's licenses. Add it with `-s`:

```sh
git commit -s -m "fix(chat): drop messages from banned users"
```

This appends a trailer matching your Git name and email:

```
Signed-off-by: Your Name <you@example.org>
```

**Why a DCO and not a CLA.** A contributor license agreement usually grants
one party the right to relicense everyone's work. We do not want anyone,
including the cooperative itself, to hold that power. With the DCO, each
contributor keeps their copyright and licenses their work under
AGPL-3.0-or-later. Because the copyright is spread across all contributors,
the code can never be relocked or relicensed as proprietary software.

**Fixing a missing sign-off.** CI rejects commits without one.

```sh
# Last commit only
git commit --amend --no-edit -s

# Every commit on your branch
git rebase --signoff main

git push --force-with-lease
```

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, for example `feat(irc): support CAP LS 302` or
`docs(self-hosting): document relay ports`. Common types are `feat`, `fix`,
`docs`, `test`, `refactor`, `perf`, `build`, `ci`, and `chore`. Mark breaking
changes with `!` after the type or a `BREAKING CHANGE:` footer. The PR title
follows the same format, since it becomes the squash commit message.

## Pull request flow

1. For anything larger than a small fix, open or comment on an issue first so
   we can agree on the approach.
2. Fork the repository and create a branch from `main`.
3. Make one focused change. Small PRs get reviewed faster; split unrelated
   changes into separate PRs.
4. Run `bun run verify` locally.
5. Open a PR using the template. Fill in the checklist.
6. CI must be green. A maintainer reviews it; expect questions and requested
   changes. Once approved, a maintainer merges it.

See [GOVERNANCE.md](GOVERNANCE.md) for how review and decisions work.

## Engineering rules

[AGENTS.md](AGENTS.md) holds the engineering rules that apply to every change,
human or machine written: code style, module boundaries, error handling, and
testing conventions. Read it before your first PR. TypeScript runs in strict
mode; do not weaken it to make a change compile.

### Tests are mandatory

Every behavior change ships with tests. Bug fixes include a test that fails
without the fix. Changes to services also need integration coverage; changes
to streaming paths should be exercised by a harness scenario.

### Adding a dependency

Prefer the standard library and existing dependencies. If you need a new one:

- Its license must be OSI-approved and on the allowlist: MIT, Apache-2.0, the
  BSD family, ISC, MPL-2.0, LGPL, GPL, AGPL, and OFL (fonts only). The license
  check in `bun run verify` fails on anything else, including source-available
  licenses (BUSL, SSPL, Elastic, RSAL, Commons Clause).
- Proprietary services (payment processors, CDNs, OAuth providers, commercial
  object storage) may only be optional adapters. The platform must run fully
  without them.
- No third-party analytics, trackers, font CDNs, or remote scripts.
- If adding it involved a judgment call (an unusual license, a large transitive
  tree, an alternative you rejected), record it in an ADR under
  [`docs/decisions/`](docs/decisions/).

### License headers

Every file carries an SPDX header naming its copyright and license:
AGPL-3.0-or-later for code, CC-BY-SA-4.0 for documentation, CC0-1.0 for small
configuration files. Files that cannot hold a comment (JSON, lockfiles,
binaries) are covered in `REUSE.toml`. Use:

```
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: AGPL-3.0-or-later
```

`reuse lint` runs as part of `bun run verify` and must pass.

### Never commit secrets

Do not commit credentials, tokens, keys, or real `.env` files. Only
`.env.example`, with placeholder values, belongs in the repository. If you
commit a secret by accident, tell a maintainer immediately so it can be
rotated; rewriting history alone is not enough.

### Names and domains

The project name, domain, and contact addresses live only in
`packages/config/src/site.ts`. Import `SITE` from `@commonair/config/site`;
the stray-domain check fails the build on hard-coded copies outside Markdown.

## Finding something to work on

- Issues labeled **`good first issue`** are scoped, mentored tasks. A
  maintainer has described the approach and will help you through it.
- Issues labeled **`help wanted`** are open for anyone to pick up.

Comment on the issue to claim it so work is not duplicated.

## Where decisions are recorded

Significant technical decisions are recorded as Architecture Decision Records
in [`docs/decisions/`](docs/decisions/). Read the relevant ADRs before
proposing a change in that area. If your PR makes a significant decision,
include a new ADR. The [ROADMAP](ROADMAP.md) lists what is planned and what is
out of scope.

## Questions

Open a GitHub Discussion, or write to hello@commonair.tv.
