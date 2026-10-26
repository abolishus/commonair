<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0-f: self-hosting docs after R0-a..e

You are implementing unit R0-f for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/R0-release.md`,
`.claude/briefs/r0/README.md` and every file in `docs/self-hosting/`. Do not look outside the
repository. **Wave 3:** start your worktree from the commit that has R0-a..e merged (the
orchestrator names it and passes you each unit's "doc changes for R0-f" list), on a branch named
`r0/f-docs`.

## Why

`v0.1.0`'s promise is that a stranger can install, upgrade, back up and restore following only
`docs/self-hosting/`. The rc droplet proved some limitations stale, R0-a..e changed behavior, and
fork upgrades need clearer guidance. One unit edits these docs at the end so they are consistent.

## You own (write only these)

- `docs/self-hosting/**` **except** `configuration.md` and `object-storage.md` (R0-b's) and
  `backups.md` (R0-c's), which are already merged; edit those only to fix a cross-reference or a
  contradiction with another page, and list each such edit.
- Not `docs/deploy/**` (ADR 0025's), not `infra/README.md` (R0-a's section is merged).

## Contracts you must honor (read-only for you)

- Every statement must match the code at your base commit. When a unit's doc request and the code
  disagree, the code wins: say so in your final message.
- User-facing names and domains come from `SITE` (`check-domains` fails on stray literals; use
  `example.org`-style placeholders as the docs already do).

## What is there today (verified at `8bbdb52`)

- IPv6 and real HTTPS client addresses are already described correctly (`requirements.md:45-48`,
  `:66-69`; `install.md:142`; `tls.md:27-28`; `README.md:71-73`). The plan's "IPv4-only" item is
  already done: confirm, do not rewrite.
- Shared-address statements that R0-a makes stale for IRC (RTMP stays shared, see
  `infra/README.md`): `README.md:71` ("IRC and RTMP clients share one address"), `:73-76`;
  `troubleshooting.md:178-179`.
- Drop-ins: `README.md:80-83` says operator drop-ins break install/upgrade and that no
  customization is supported; the code keeps drop-in directories (`selfhost.sh:787-790`, `:796`)
  and R0-d proves it with a test. Replace with the supported way (R0-d's report).
- Crash loop: `README.md:86-87` (R0-d's fix makes it stale or changes it).
- Forks: `COMMONAIR_REPOSITORY_URL` is in `install.md:116-118`, `upgrades.md:108-114` and the
  script's usage text (`selfhost.sh:106-107`). Resolution order (`resolve_repository_url`
  :187-194): the environment, then `release.env` of the installed release, then upstream. The
  trap (`upgrades.md:112-114`): a fork that has not changed its code records the upstream URL,
  so it must set the variable on every upgrade.
- `scaling.md` describes the limits of one server; S1 will change it, not you, beyond links.

## Build

1. Apply each unit's doc-change list (IRC addresses, drop-ins, crash loop, external S3 and object
   backups cross-links).
2. **Fork upgrades**: one section in `upgrades.md` (linked from `install.md`) that walks a fork
   through its first install, its own signed releases (what `verifying.md` checks and how the
   identity regexp follows the repository URL), and upgrades; the trap above, stated once, with
   the fix (set it in the service user's environment, e.g. `~/.config/environment.d/` or the shell
   profile: check which one `selfhost.sh` sees when run with `runuser`, :369-389).
3. **A reading path**: README.md's first screen tells a stranger the order
   (requirements → install → configuration → object storage if external → backups → upgrades →
   troubleshooting) and what "done" looks like after each.
4. Check every relative link and every command flag in `docs/self-hosting/` against the code at
   your base (a short script is fine; do not commit it unless it is a test someone owns).

## Tests you must add

None required beyond the docs' own checks; if `docs/` has link or snippet tests (look for them),
run them and keep them green.

## Done means

`vp fmt` on your files, `bun scripts/check-domains.ts` (or the verify step that runs it), `reuse
lint`. Commit in your worktree. Final message: each change by file, statements you found that
contradict the code and how you resolved them, and edits to R0-b's or R0-c's pages.
