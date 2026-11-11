<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-n roles: `selfhost.sh` installs one role per host

You are implementing unit S1-n for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- [ADR 0041](../../../docs/decisions/0041-launch-scale.md) decisions 2, 3 and 7, and
  [ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md) §3.
- `.claude/briefs/s1/launch-contract-step.md`: the new env keys (§2), node join (§3.7) and
  internal addressing (§4).
- `.claude/briefs/s1/S1-b-external.md`, the unit that added `--database-url` and `--valkey-url`.
  Follow its patterns for flags, modes, refusals and the e2e variant.
- `docs/self-hosting/scaling.md`, which today says steps 2 and 3 "are not scripted yet:
  `selfhost.sh` manages one host". You make that sentence untrue.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`s1/n-roles`, cut from the contract step's sha. S1-j, S1-e and S1-f run beside you.

## Why

The launch runs three pools of hosts: app, media and moderation. `selfhost.sh` has no `--role`
and no notion of a second host. `unit_in_mode` (`scripts/selfhost.sh:1165-1180`) already skips
units by mode (external state, external storage, captions, seed mode), and `install_units`
(`:2058-2127`) installs whatever that predicate allows from the release's `quadlet/` directory.
A role is one more input to that predicate, plus the wiring that lets hosts find each other.

**The single-host install stays the default, with full support.** `--role all` is the default
and must leave install, upgrade, `status`, backup and rollback exactly as today.

## You own (write only these)

- `scripts/selfhost.sh`, except the backup section (`parse_backup_flags` through `cmd_backup`,
  about `:2833-3751`): touch it only where a role must refuse or skip a backup.
- `scripts/selfhost/**`.
- `infra/selfhost/**`, except `infra/selfhost/env/commonair-pgbouncer.keys` (S1-f's).
- `infra/quadlet/**`, except `commonair-pgbouncer.container` (S1-f's). You install that unit by
  the rule S1-f sends.
- `infra/systemd/**`.
- `infra/tests/selfhost-roles*` (new).
- `docs/self-hosting/{scaling,install,upgrades,configuration,requirements}.md`.

**Read-only:** `infra/tofu/**`, `infra/caddy/**`, `infra/mediamtx/**`, every service and
package, `.github/**`, `compose.yaml`. The CI matrix row for the roles e2e is a contract request
with the exact diff.

## Contracts you must honor

- A role other than `all` requires external Postgres, Valkey and S3 (the `STATE_MODE=external`
  and `STORAGE_MODE=external` paths). Refuse otherwise, with the reason and the doc link.
- `NODE_NAME`, `NODE_INTERNAL_HOST`, `MEDIA_NODE_PUBLIC_HOST`, `MEDIA_NODE_MAX_STREAMS` and
  `WORKER_QUEUES` are written to `commonair.env` and reach units through
  `infra/selfhost/env/*.keys`, as every key does.
- Passwords and tokens are never flags (`ps` shows them): files, the environment or a prompt.
- Switching a host's role in place is refused, like switching state mode (`refuse_repoint`).
- No provider is special-cased.

## Build

1. **`--role all|app|media|moderation`** on `install`, kept in `commonair.env` and honored by
   `upgrade`, `status` and `images_of` (so a host pulls only its role's images).

   | Role         | Units                                                                                     |
   | ------------ | ----------------------------------------------------------------------------------------- |
   | `all`        | today's set                                                                               |
   | `app`        | caddy, api, chat, irc, web, worker, origin, otel-collector; the tracker on one named host |
   | `media`      | mediamtx, media, otel-collector, coturn when TURN is on, the internal forwarder (below)   |
   | `moderation` | worker with `WORKER_QUEUES=moderation` and the classifier model, otel-collector           |
   - The tracker runs on exactly one app host: `--with-tracker` on that host, and the others
     get its internal address.
   - The observability stack (prometheus, loki, tempo, grafana) runs on one host: decide between
     the first app host and a dedicated flag, record it in `scaling.md`, and make every other
     host's otel-collector ship to it over the internal network.
   - `After=`/`Requires=` edges on units a role does not install are stripped, as
     `install_unit_file` (`:1921-1953`) does for external state.

2. **Internal addressing**, as the contract step's §4 decided. If it is the local forwarder, the
   media and moderation roles install it and render its upstream list from the node registry.
   Internal ports bind to the internal interface, never to a public one. Add a preflight that
   refuses an install whose internal address is public.
3. **Joining.** `selfhost.sh install --role <r> --join <app internal URL> --token-file <file>`
   fetches the role's env through `nodeJoin` and installs with it, so a new host needs one
   short-lived token and no copied secrets. `selfhost.sh node token --role <r>` on an app host
   mints one (10 minutes, single use). A join without a token still works when the operator
   passes the URLs and secrets the way `install` takes them today.
4. **Media role specifics.** MediaMTX sends `node` on its auth and hook calls (S1-e's
   `mediamtx.yml`), reaches the api through the internal address, and advertises
   `MEDIA_NODE_PUBLIC_HOST` for WebRTC. RTMP 1935 and ICE 8189/udp are published, and the
   node's health port is published for the load balancer only.
5. **`status`** shows the role, the node's row and state from `cluster_nodes`, and for a media
   node its live streams against its limit. `selfhost.sh node cordon|uncordon|drain` changes the
   state through the tools image, with the audit row the contract step requires. `drain` waits
   for the node's streams to end, up to `--timeout`, and says how many remain.
6. **Upgrades across hosts.**
   - `upgrade` on any host runs `migrate` only if the schema is behind, under a lock, so the
     first upgraded host migrates and the rest skip (`start_migrate`, `:2217`).
   - A rolling upgrade runs old code against the new schema for a while. Write the rule this
     needs (each release's migrations must be readable by the previous release's code, with
     removals a release later) into `upgrades.md` as proposed, and send it to the orchestrator
     as a contract request for an ADR note. Do not enforce it in code.
   - `upgrade` on a media host cordons and drains first unless `--no-drain`, and uncordons after
     health.
   - `upgrade` on an app host relies on S1-f's drain on SIGTERM: stop with the unit's stop
     timeout long enough for the drain window. Never SIGKILL chat on a planned stop.
7. **Backups** run on one host: the app host that holds the timers. Other roles install no
   backup timer and `backup` refuses there with the reason.
8. **The roles e2e** (`scripts/selfhost/e2e.ts --roles`): an app host, a media host and a
   moderation host as three systemd containers on one network, with external Postgres, Valkey
   and Garage as S1-b's variant starts them. It checks install with a join token, a publish to
   the media host playing through the app host, a classifier verdict from the moderation host,
   `status` on each, cordon and drain, an upgrade that migrates once, and that no host has a
   unit outside its role.
9. **Docs.** `scaling.md` becomes the real procedure: single host first, then roles, with the
   static pool (hosts you list) as the default and the autoscaler as optional. `install.md`,
   `upgrades.md`, `configuration.md` and `requirements.md` gain the role material. The docs test
   (`self-hosting-docs.test.ts`) keeps every documented command real.

## Edge cases

- A token that is expired, already used, or for another role.
- The app host unreachable during a join: fail before anything is installed.
- Two hosts given the same `NODE_NAME`.
- `--role media` with bundled state, or `--role all` with `--join`: refused.
- An upgrade started on two hosts at once: one migrates, the other waits.
- A drain that times out with streams still live: the upgrade stops and says so, and nothing is
  killed.
- A host re-installed with the name of a node already marked `gone`.

## Tests you must add

- Shell unit tests (`scripts/selfhost/selfhost-roles.test.ts`, in the style of
  `selfhost-external.test.ts`): each role's unit set, the refusals, the env and secret writes,
  role kept across `upgrade`, token handling, the internal-address preflight, cordon and drain.
- `infra/tests/selfhost-roles.test.ts`: rendered units per role have no edge to a unit that role
  lacks, and `--role all` renders byte-identical units to `main`'s apart from the new keys.
- The existing e2e variants pass unchanged. The roles e2e runs locally only if it is fast enough
  to be a targeted check.

## Reviewer focus

- `--role all` is today's install, byte for byte where it can be.
- No secret on a command line, in a unit file or in `status` output.
- Internal ports are never public.
- Migrate runs once, and a planned stop never kills a live stream or SIGKILLs chat.
- No provider is special-cased.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun --bun vp test run scripts/selfhost infra/tests`,
`shellcheck scripts/selfhost.sh` as CI runs it, lint, format and `reuse lint`. `git status`
shows only your paths. Commit with `git commit -s`.

Your final message lists: what you built, test counts, the CI matrix diff, the rolling-upgrade
rule for the ADR, what you need from S1-f (the pooler unit rule) and S1-e (`mediamtx.yml` env
names), and the command for the user to run the roles e2e.
