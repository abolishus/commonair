<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit B: Quadlet, Caddy TLS, systemd and `selfhost.sh`

You are implementing unit B of Phase 5 for CommonAir (repo: /Users/joshe/Repos/bcon; you
work in your own git worktree of it). Read AGENTS.md, PLAN.md, docs/architecture.md,
`.claude/briefs/phase5/_common.md`, ADR 0023, docs/deploy/hetzner.md and infra/README.md
first. Do not look outside the repository.

## You own (write only these)

- `infra/quadlet/**`
- `infra/caddy/**`
- `infra/systemd/**`
- `infra/image-licenses.json`, for new images only
- `scripts/selfhost.sh`
- `scripts/selfhost/**`
- `scripts/tests/selfhost*.test.ts`
- `infra/tests/compose.test.ts`, only its "Quadlet mirror", "Caddyfile", "systemd timers" and
  "postgres runs under an init" blocks
- new `infra/tests/quadlet*.test.ts`, `infra/tests/caddy*.test.ts` and
  `infra/tests/selfhost*.ts`

## Contracts you must honor (read-only for you)

- `scripts/release/manifest.ts`: `parseManifest`, `imageRef`, `bundleAssetName`, etc.
- The CLI contracts in `_common.md`. Unit A's release workflow calls your `bundle.ts`, and its
  CI calls `e2e.ts` and runs shellcheck on `selfhost.sh`. Keep those interfaces exactly.
- `packages/config` `infraEnv`: `TLS_MODE`, `ACME_EMAIL`, `ACME_CA`, `PUBLIC_HOSTNAME`.
- `scripts/init-env.ts` (`--out`, `--merge`; it writes mode 0600).
- `scripts/fetch-model.ts`.
- `infra/postgres/*` (WAL-G backup/restore, `apply-app-role.ts`).
- `infra/irc/sync-cert.ts`.
- compose.yaml, which the units mirror.

## Build

1. **Release-ready Quadlet units**.
   - The repository units keep `localhost/commonair/<name>:latest` (ADR 0023 §6). Rendering
     replaces those Image lines with `imageRef(manifest, name, registry)`. Third-party images
     keep their digest pins.
   - `RunInit=true` on every container unit. If an image cannot run under catatonit, explain
     why in a comment and in the test's allowlist.
   - Restart:
     - `Restart=always` with `RestartSec=5`;
     - `[Unit] StartLimitIntervalSec=` / `StartLimitBurst=` chosen so a crash loop is
       throttled but never leaves a unit permanently failed;
     - `HealthOnFailure=kill`, so an unhealthy container is restarted.
       Find out why the worker did not come back after its crash (PROGRESS session ten). That
       happened under compose, where podman-compose `restart: unless-stopped` depends on
       `podman-restart.service`. Prove the Quadlet path restarts: a test that asserts the keys,
       plus a live check if you can run one (`systemctl --user` in the e2e).
   - Health checks on every long-running unit.
   - Upgrade path:
     - `commonair-migrate` is a oneshot that `api` and `worker` (and anything else touching the
       schema) `Requires=`/`After=`;
     - `selfhost.sh upgrade` must re-run it before they start again;
     - mind that stopping a `Requires=` dependency propagates to its dependents.
   - Config mounts: today the units mount `%h/commonair/infra/...` from a git clone. For
     releases, install each release into `~/.local/share/commonair/releases/<version>/`, and
     make `~/commonair` (or a new path, updated in every unit) a symlink to the current
     release, so a rollback is a symlink flip plus units.
2. **Caddy TLS** (`infra/caddy/Caddyfile`).
   - `TLS_MODE=acme` (default): automatic HTTPS for `{$PUBLIC_HOSTNAME}`, with `ACME_EMAIL`
     and `ACME_CA` optional.
   - `TLS_MODE=internal`: `tls internal`. Document where operators find the root
     certificate to trust (`/data/caddy/pki/authorities/local/root.crt` in the data volume).
   - Unset values must leave a valid config.
   - Add a test that runs the pinned Caddy image's `caddy validate` / `caddy adapt` against
     the Caddyfile in both modes, as an `*.int.test.ts` because it needs podman. Also add a
     pure unit test of the routing invariants that already exist.
   - The compose `tls` profile keeps working with the defaults (you cannot edit compose.yaml;
     if it needs to pass `TLS_MODE` through, file a contract request).
3. **`scripts/selfhost/` (Bun, typed, unit-tested)**:
   - `render.ts`: manifest + registry → rendered units. A pure function plus a CLI.
   - `bundle.ts`: the CLI contract. Builds the tarball with `selfhost.sh`, the manifest,
     rendered `quadlet/`, `systemd/`, and every config file a unit mounts. Derive that list
     from the units' `Volume=` lines and assert it in a test, so a new mount cannot be
     forgotten.
   - `e2e.ts`: see below.
4. **`scripts/selfhost.sh`**. POSIX `sh`, `set -eu`, shellcheck-clean, idempotent, with
   `--help`.
   - **`install`**:
     - Flags: `--version vX.Y.Z` | `--bundle <path>` (local/offline), `--domain`, `--email`,
       `--tls acme|internal`, `--registry <mirror>`, `--public-ip <addr>`,
       `--require-signature`, `--yes`.
     - Host checks, each with a clear fix message:
       - distro: Debian 13 or Fedora ≥ 42 from `/etc/os-release`; anything else is refused
         unless `--unsupported-distro`;
       - Podman ≥ 5.0;
       - rootless prerequisites: `/etc/subuid`/`/etc/subgid` entries, a running user
         systemd;
       - linger;
       - `net.ipv4.ip_unprivileged_port_start` ≤ 80;
       - nothing already listening on 80/443 TCP, 443/1935/6667/6697 TCP and 8189 UDP
         (`ss`);
       - firewall hints (nftables/firewalld) for those ports.
     - If run as root, it may do the root-only preparation: install podman via apt/dnf,
       create a `commonair` user, enable linger, set the sysctl. Then it continues as that
       user (e.g. `runuser`/`systemd-run --user --machine=commonair@`), or prints the exact
       single command to continue. Decide which, and justify it.
     - Download over HTTPS from the release URL, built from `SITE.repository` via the
       manifest/bundle and never hardcoded in more than one place. Verify `SHA256SUMS`
       before extracting anything. Verify `SHA256SUMS.sigstore.json` with cosign when it is
       installed; `--require-signature` makes that mandatory. Use cosign's keyless identity
       flags from ADR 0023 §3.
     - Install the release into its versioned directory.
     - Write `~/.config/commonair/commonair.env`:
       - run `init-env` inside the release's `tools` image (`--merge` on re-runs);
       - set `PUBLIC_HOSTNAME`, the public URLs, `TLS_MODE`, `ACME_EMAIL`, `NODE_ENV`,
         `IRC_PUBLIC_HOST` and `MTX_WEBRTCADDITIONALHOSTS` (from `--public-ip` or local
         interface addresses; never a third-party "what is my IP" service);
       - mode 0600 in a 0700 directory.
     - Create the podman secrets from it, idempotently (replace).
     - Set up the moderation model and hash-list files the units mount. Run
       `fetch-model.ts` in the tools image. Create empty hash lists if none are configured,
       and say so loudly.
     - Install units and timers, `daemon-reload`, and start.
     - Wait for health with a timeout.
     - Do the first-run IRC certificate sync.
     - Print the URL and next steps.
   - **`upgrade [--version …|--bundle …]`**: the ADR 0023 §9 order (verify, pull by digest,
     backup, install units, migrate first, restart, health), with **rollback** to the
     previous release on failed health. Keep the last two releases on disk.
   - **`backup`**: runs `commonair-backup.service` and shows `wal-g backup-list`.
   - **`status`**: installed version, every unit's state and health, the TLS mode and
     certificate expiry if cheap, the last backup, and disk usage of the volumes.
   - Security:
     - never `curl | sh`;
     - quote everything;
     - `umask 077` around secrets;
     - never print secrets;
     - refuse to run `install` over an existing instance without `--yes`, so an accidental
       re-run cannot rotate secrets (`--merge` semantics keep them).
5. **End-to-end test `scripts/selfhost/e2e.ts`** (the CLI contract):
   - build the 14 images locally (or reuse ones already built with the same commit label);
   - push them to a local registry container, e.g. Zot, digest-pinned with an
     image-licenses entry;
   - write a manifest with the real digests and build the bundle;
   - start a privileged systemd container from a digest-pinned Debian 13 image (`--distro
     fedora` uses Fedora 42) with podman installed, and run `selfhost.sh install --bundle …
     --tls internal --domain selfhost.test --registry <local>` as a non-root user inside it;
   - wait for health, and check `https://selfhost.test/` through the internal CA (`curl
     --cacert`) and `/api/healthz` (or what the API serves);
   - then build a second release (version `0.0.0-e2e.2`, images re-tagged with a changed
     label so the digests differ) and run `selfhost.sh upgrade`;
   - assert migrate ran before api and worker restarted (journal timestamps), and that
     `status` reports the new version;
   - then an upgrade to a deliberately broken release (an image whose health check fails)
     must roll back to `e2e.2` and stay healthy;
   - write logs to `.cache/selfhost-e2e/`; `--keep` leaves the container for debugging.
     Run it yourself if your machine can (podman machine with `--privileged`), and report
     timings. If it cannot, run every piece you can (render, bundle, install against stubs) and
     say exactly what is unproven.

## Tests you must add

- `scripts/tests/selfhost-render.test.ts`: every own image is replaced by `imageRef`;
  third-party images are untouched; a mirror registry works; a manifest without an image
  fails.
- `scripts/tests/selfhost-bundle.test.ts`: the tarball contents equal the expected set, every
  `Volume=` source from the units is included, `selfhost.sh` is executable, and building
  twice gives byte-identical output (fixed mtimes and ordering).
- `scripts/tests/selfhost-sh.test.ts`: run `selfhost.sh` under `sh` with PATH stubs for
  podman, systemctl, loginctl, ss, curl, sha256sum and cosign. Cover:
  - arg parsing and `--help`;
  - each host check failing with its message;
  - checksum mismatch aborts before extraction;
  - `--require-signature` without cosign aborts;
  - idempotent re-install keeps secrets;
  - the upgrade order (migrate before api/worker, from the stub call log);
  - rollback on failed health;
  - `.env` mode 0600.
    Run shellcheck in the test via the binary if present, or a digest-pinned
    `koalaman/shellcheck` image. Fail rather than skip in CI (`CI=true`).
- Quadlet tests: `RunInit`, restart keys and `HealthOnFailure` on every unit; health on every
  long-running unit; migrate ordering for every schema-touching unit.
- Caddy tests as above.

## Done means

See `.claude/briefs/_done-means.md`, plus:

- shellcheck is clean (paste the version);
- `bun --bun vp test run` in `scripts/` and `infra/` passes (with counts), and
  `bun run --filter @commonair/infra test:int` for your new int tests if the infra package
  has that script;
- the e2e result, or a precise list of what is unproven.

Report any contract request with the exact change, e.g.:

- the tools image lacks `scripts/init-env.ts`, `.env.example` or `scripts/fetch-model.ts`
  (`infra/containers/service.Containerfile` is not yours);
- compose needs `TLS_MODE` passed to Caddy;
- release workflow needs.
