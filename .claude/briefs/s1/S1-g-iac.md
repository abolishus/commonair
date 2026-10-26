<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-g: OpenTofu for DigitalOcean, stages 0–2

You are implementing unit S1-g for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/S1-scaling.md`,
[ADR 0025](../../../docs/decisions/0025-hosting-on-digitalocean.md),
[ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md) (proposed),
[ADR 0022](../../../docs/decisions/0022-supply-chain.md), `docs/deploy/digitalocean.md` and
`.claude/briefs/next/L1-public-instance.md`. Do not look outside the repository, except the
provider's and OpenTofu's own documentation and source to vet versions and read resource
schemas. Work in your own git worktree on a branch named `s1/g-iac`.

## Why

ADR 0025 decision 4 puts droplets, cloud firewalls, volumes, Spaces buckets and reserved IPs in
OpenTofu; L1 checklist item 8 needs it before launch. Today the staging droplet
(`commonair-rc-test`) was made by hand, and nothing in the repository describes it. This unit
writes the definitions for stage 0 (launch), stage 1 (managed state) and stage 2 (app tier). You
write and test the code; **you never run `tofu apply` or touch a real account**. The operator
applies it with their own scoped token (ADR 0025 decision 5).

## You own (write only these)

- `infra/tofu/**` (new): `infra/tofu/digitalocean/` (modules and one root per environment),
  `infra/tofu/README.md`, `infra/tofu/provider-licenses.json`
- `docs/deploy/digitalocean.md`: only the "Infrastructure as code" section (:144-151) and links
  to it from "1. Create the droplet" (:36-49)

Changes to `scripts/check-licenses.ts`, `scripts/verify.ts`, `REUSE.toml`,
`.github/workflows/*` or `supply-chain.json` are **contract requests** with the exact diff.

## Supply chain first (non-negotiables 2 and 7, ADR 0022)

- **Provider**: `digitalocean/digitalocean`. The newest release on 2026-10-26 is v2.106.0
  (2026-10-12, MPL-2.0 per the repository's LICENSE: check it at the tag yourself). Pin an
  exact version (`version = "= 2.106.0"` or the newest one at least 7 days old when you start).
  Commit `.terraform.lock.hcl` with `h1:` and `zh:` hashes for linux_amd64, linux_arm64,
  darwin_arm64 (`tofu providers lock -platform=…`).
- **OpenTofu itself**: MPL-2.0. v1.13.2 came out on 2026-10-21, inside the 7-day cooldown, so pin
  the newest release that is at least 7 days old (`required_version = "= x.y.z"`) and say which.
- **Licenses**: `check-licenses.ts` checks npm, images and Go modules, and has no hook for tofu
  providers (:177-189). Write `infra/tofu/provider-licenses.json` (`{ "registry.opentofu.org/digitalocean/digitalocean": { "license": "MPL-2.0", "source": "…" } }`)
  and send a contract request with a fourth checker that reads every `.terraform.lock.hcl` under
  `infra/tofu` and requires each provider in that file.
- **Tooling**: if `tofu` is not installed, you may download the pinned OpenTofu release binary
  into `.cache/tools/` (not the system), verifying its SHA-256 against the release's signed
  checksums file. Never `curl | sh`. Say what you did.
- Run `bun scripts/vet-package.ts` only for npm packages, which you should not need.

## What the definitions hold

Facts are in ADR 0032's context table (checked 2026-10-26). Firewall rules and topology come from
`docs/deploy/digitalocean.md` (:18-34, :125-142).

- **Shared**: a `project`, a `vpc` per region, SSH keys looked up by fingerprint (never created
  from a private key), tags (`commonair`, `commonair-<env>`, `commonair-app`, …).
- **Stage 0**:
  - one droplet (Debian 13 image slug, size a variable with **no default**, so S1-a's numbers
    choose it; IPv6 on; monitoring agent on; in the VPC);
  - a `reserved_ip` assigned to it;
  - an optional `volume` for `MEDIA_WORK_DIR_*`;
  - the cloud `firewall` with exactly the documented ports for IPv4 and IPv6. SSH comes only from
    an operator CIDR variable. 6667 is behind a boolean;
  - Spaces buckets for WAL-G and object backups in **another region**, private, with lifecycle
    for incomplete multipart uploads, and a `spaces_key` limited to them if the provider's
    resource allows bucket-scoped grants (check, and say what it can and cannot scope);
  - the monitoring droplet in a second region.
- **Stage 1** (off by default, `enable_managed_state`):
  - `database_cluster` engine `pg` (version a variable, default 17 to match
    `infra/postgres/Containerfile:13`, `node_count = 2` for one standby, `private_network_uuid`
    set);
  - `database_cluster` engine `valkey` with eviction `noeviction` (BullMQ) and one standby;
  - `database_firewall` rules by **droplet tag** (there is no VPC rule type);
  - the instance's media, exports and evidence buckets in Spaces, with CORS on the media bucket
    for the instance's origin (`spaces_bucket_cors_configuration`).
  - The non-owner app role is created by the app's migrations (`infra/postgres/app-role.sql`),
    not by tofu. Say so in the README.
- **Stage 2** (off by default, `app_count > 1`): app droplets, plus a regional **network
  (layer 4)** load balancer forwarding 80, 443 TCP, 443 UDP, 1935 and 6697 to them with health
  checks. Check that the provider's `loadbalancer` resource can express a network load balancer
  and UDP, and if not, record the gap. The reserved IP then moves to the load balancer (or DNS
  points at the load balancer: say which, per the provider's model).
- **Environments**: `envs/staging` and `envs/production` roots that call the modules. Staging is
  shared-vCPU, stage 0 only.
- **State**: a remote backend in a Spaces bucket the operator creates by hand once (document the
  `doctl` commands), with OpenTofu state encryption on (a key from an environment variable, never
  in git). No state file, `.tfvars` with secrets or plan file is ever committed: add the
  ignore rules to `infra/tofu/.gitignore`.
- **What tofu does not do**: DNS (Cloudflare, DNS-only records, ADR 0025 decision 4). Output the
  A/AAAA values to set. Installing CommonAir (`selfhost.sh install` over SSH, documented). No
  secrets in `user_data`: droplet metadata is readable from the droplet. Use cloud-init only for
  package updates and the service user, or not at all.
- **Staging adoption**: document how the operator imports or replaces `commonair-rc-test`
  (`tofu import` blocks for the droplet, firewall and reserved IP if any, or recreate and
  restore). Do not run it.

## Tests you must add

- `tofu fmt -check -recursive infra/tofu` and `tofu validate` in each root.
- `tofu test` with `mock_provider "digitalocean"` (supported since OpenTofu 1.8), so tests run
  without a token:
  - the firewall allows exactly the documented ports;
  - SSH only from the operator CIDR;
  - stage 1 and stage 2 resources are absent by default;
  - the database firewall uses the app tag;
  - the size variable has no default;
  - the backup buckets are in a different region from the droplet.
- A contract request adding a `tofu` step to `scripts/verify.ts` (fmt, validate, test), skipped
  with a message when `tofu` is not installed, and the CI change to install the pinned OpenTofu
  with checksum verification.

## Done means

Follow `.claude/briefs/_done-means.md` where it applies: your `tofu fmt`/`validate`/`test` runs
pass, `vp fmt` on the Markdown, `reuse lint` passes for your new files (add SPDX headers, or a
`REUSE.toml` annotation request for `.terraform.lock.hcl`). Commit in your worktree. Final
message:

- the provider and OpenTofu versions pinned, with their ages and license evidence;
- the resource gaps you found (network load balancer, UDP, bucket-scoped keys, anything else);
- the contract requests (`check-licenses.ts`, `verify.ts`, CI, `REUSE.toml`);
- test counts, branch and sha;
- the exact operator commands, from creating the state bucket to `tofu plan` for staging, with no
  token in any file or command line (`DIGITALOCEAN_TOKEN` from the environment).
