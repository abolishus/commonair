<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# OpenTofu for DigitalOcean

The droplets, cloud firewalls, VPCs, volumes, Spaces buckets and keys, reserved IP, managed
databases and load balancer for our own instance, in the stages of
[ADR 0032](../../docs/decisions/0032-scaling-and-availability.md), on the host chosen in
[ADR 0025](../../docs/decisions/0025-hosting-on-digitalocean.md). The deploy guide is
[docs/deploy/digitalocean.md](../../docs/deploy/digitalocean.md); everything after a droplet's
first boot is `selfhost.sh`, which stays provider-neutral.

The operator runs `tofu plan` and `tofu apply` with their own scoped token (ADR 0025 decision 5).
Agents write and test this code; they never apply it or hold the token.

## Layout

| Path                                           | What                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `digitalocean/modules/instance/`               | one instance: tags, project, VPCs, droplets, firewalls, backups, monitoring, stage 1 and stage 2 |
| `digitalocean/modules/instance/tests/`         | `tofu test` with `mock_provider "digitalocean"`: no token, no account                            |
| `digitalocean/envs/staging/`                   | staging root: one shared-vCPU droplet, stage 0 only                                              |
| `digitalocean/envs/production/`                | production root: stage 0 at launch; stage 1 and 2 behind variables                               |
| `check.sh`                                     | `fmt -check`, `validate` in every root and module, `tofu test`                                   |
| `provider-licenses.json`                       | the license of every provider in a `.terraform.lock.hcl` (ADR 0002)                              |
| `*/.terraform.lock.hcl`                        | provider hashes for linux_amd64, linux_arm64 and darwin_arm64                                    |
| `digitalocean/envs/*/terraform.tfvars.example` | the non-secret inputs; copy to `terraform.tfvars` (ignored by git)                               |

## Versions and supply chain (ADR 0022)

| What                                 | Pinned                          | Published  | License, evidence                                                                                                |
| ------------------------------------ | ------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| OpenTofu                             | `required_version = "= 1.13.1"` | 2026-10-01 | MPL-2.0: `LICENSE` at tag `v1.13.1`. 1.13.2 and 1.12.9 (2026-10-21) were inside the 7-day cooldown on 2026-10-26 |
| `digitalocean/digitalocean` provider | `version = "= 2.106.0"`         | 2026-10-12 | MPL-2.0: `LICENSE` at tag `v2.106.0` is the Mozilla Public License 2.0                                           |

The lock files hold `h1:` hashes for the three platforms we run on and `zh:` hashes for every
zip in the release's `SHA256SUMS`. The registry (`registry.opentofu.org`) serves the GitHub
release zips of the provider, with the same SHA-256 sums. `tofu init` verifies the provider's
signature and refuses a package whose hash is not in the lock file; check.sh runs it with
`-lockfile=readonly`, so a changed lock file never slips in. To upgrade the provider: vet the
new release (age, license at the tag, changelog), change the pins in every `versions.tf`/`main.tf`,
then in each root and the module:

```sh
tofu providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
```

### Installing OpenTofu

Download the release for your platform from
`https://github.com/opentofu/opentofu/releases/tag/v1.13.1`, with `tofu_1.13.1_SHA256SUMS` and
its `.sig` and `.pem`, and check both before unpacking:

```sh
cosign verify-blob \
  --certificate-identity 'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v1.13' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --signature tofu_1.13.1_SHA256SUMS.sig --certificate tofu_1.13.1_SHA256SUMS.pem \
  tofu_1.13.1_SHA256SUMS
grep " tofu_1.13.1_darwin_arm64.tar.gz$" tofu_1.13.1_SHA256SUMS | shasum -a 256 -c -
```

Keep the binary in `.cache/tools/` (ignored by git) or your own `PATH`; never `curl | sh`. CI
installs the same release with `bun scripts/release/tools.ts install --dir <bin dir> tofu`, which
checks the pinned SHA-256 of each platform's archive.

## Tests

```sh
bash infra/tofu/check.sh
```

`check.sh` skips with a message when `tofu` is missing, and fails under `REQUIRE_TOFU=1` (CI).
The tests in `modules/instance/tests/` plan against a mocked provider and check that:

- the app firewall opens exactly 22, 80, 443/tcp, 443/udp, 1935, 8189/udp and 6697 over IPv4
  and IPv6, 6667 only with `irc_plaintext`, and outbound stays open;
- SSH comes only from `operator_cidrs`, and `0.0.0.0/0` or `::/0` is rejected;
- stage 1 and stage 2 resources are absent by default;
- the database firewalls admit only the environment's app tag;
- `droplet_size` has no default, and a blank size is rejected;
- the backup buckets are private, abort incomplete multipart uploads, have one key each, and
  sit in another region from the droplet (the same region is rejected);
- the monitoring droplet is in a region of its own;
- stage 1 runs Postgres 17 and Valkey with a standby each, Valkey `noeviction`, CORS for the
  instance's origin only; stage 2 is a `REGIONAL_NETWORK` load balancer passing 80, 443 TCP and
  UDP, 1935 and 6697, and refuses to exist without stage 1.

## What it creates

**Every stage**: a project per environment; a VPC in the app region (and one in the monitoring
region); tags `commonair`, `commonair-<env>`, `commonair-app` and `commonair-<env>-app`. Firewalls
and database firewalls select on `commonair-<env>-app`, so a staging droplet never matches
production's database firewall. SSH keys are looked up by fingerprint among the keys already on
the account; tofu never creates one, and a missing fingerprint fails the plan.

**Stage 0 (launch)**:

- one droplet: Debian 13 (`debian-13-x64`), `droplet_size` with no default (S1-a chooses it),
  IPv6 on, the monitoring agent on, in the VPC;
- a reserved IPv4 assigned to it;
- optionally a block storage volume for `MEDIA_WORK_DIR_*` (`media_volume_size_gb`);
- the cloud firewall from the deploy guide's [firewall table](../../docs/deploy/digitalocean.md#firewall);
- Spaces buckets for WAL-G and object backups in `backup_region` (another region), private,
  versioned, with incomplete multipart uploads aborted after 2 days and old versions expired after
  `backup_noncurrent_days`, and one Spaces key per bucket;
- the monitoring droplet in `monitoring_region`, with a firewall for SSH and the status page.

**Stage 1** (`enable_managed_state = true`): managed PostgreSQL (`pg_version`, default 17 to
match `infra/postgres/Containerfile`) and managed Valkey (`noeviction`, RDB persistence, TLS),
each with `node_count = 2` (one standby) in the VPC; a database firewall per cluster that admits
the app tag; the media, exports and evidence buckets in the app region with CORS on media for
`instance_origin`; one Spaces key limited to those three buckets. Tofu creates the clusters and
nothing inside them: **the non-owner app role is created by the app's migrations**
(`infra/postgres/app-role.sql`) when `selfhost.sh` runs them as the `doadmin` owner.

**Stage 2** (`app_count > 1`, needs stage 1): `app_count` app droplets and a regional network
(layer 4) load balancer, dual-stack, in the VPC, selecting droplets by the app tag, forwarding
80/tcp, 443/tcp, 443/udp, 1935/tcp and 6697/tcp to the same ports with a TCP health check on 443.
DNS then points at the load balancer's addresses: a DigitalOcean load balancer cannot take a
reserved IP (its `ip` argument accepts only a BYOIP address), so the reserved IP stays on the
first app droplet for SSH. WebRTC ICE (8189/udp) is not balanced: each droplet advertises its own
address.

## What tofu does not do

- **DNS.** The domain's records stay in Cloudflare as DNS-only records (ADR 0025 decision 4).
  `tofu output dns_records` prints the A and AAAA values to set.
- **Installing CommonAir.** After apply, install over SSH with `selfhost.sh install` as the
  deploy guide says ([§2–3](../../docs/deploy/digitalocean.md#2-prepare-the-host)).
- **Secrets on the droplet.** User data is readable from inside the droplet, so it carries only
  `package_update`/`package_upgrade` (`cloud_init_updates = false` drops even that). The service
  user, the env file and its secrets come from `selfhost.sh`. Spaces keys and database URIs are
  sensitive outputs that the operator copies into `commonair.env`.

## State

State is in a Spaces bucket the operator creates once by hand, encrypted client-side by OpenTofu
(`encryption` block, AES-GCM with a PBKDF2 key from `TF_VAR_state_passphrase`, enforced for state
and plans), and locked with an S3 lock file (`use_lockfile`). State contains Spaces secret keys
and database URIs, so the passphrase lives only in the operator's password manager. No state,
plan or `.tfvars` file is ever committed (`infra/tofu/.gitignore`).

`doctl` manages Spaces keys but not buckets, so the bucket itself comes from the control panel
or any S3 client. Once, with the operator's own token in the environment:

```sh
# 1. A full-access Spaces key for the operator: tofu needs it to create buckets
#    (SPACES_ACCESS_KEY_ID / SPACES_SECRET_ACCESS_KEY). Store the secret it prints, then clear the screen.
doctl spaces keys create commonair-operator --grants 'bucket=;permission=fullaccess'

# 2. The state bucket, private, CDN off, versioned. Control panel: Spaces > Create, nyc3,
#    commonair-tofu-state. Or with the AWS CLI and the key from step 1 in AWS_* variables:
aws s3api create-bucket --bucket commonair-tofu-state --endpoint-url https://nyc3.digitaloceanspaces.com
aws s3api put-bucket-versioning --bucket commonair-tofu-state \
  --versioning-configuration Status=Enabled --endpoint-url https://nyc3.digitaloceanspaces.com

# 3. A key limited to the state bucket, for the backend (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
doctl spaces keys create commonair-tofu-state --grants 'bucket=commonair-tofu-state;permission=readwrite'
```

If you choose another bucket name or region, change the `backend "s3"` block in both roots.

## Running it (operator)

Tokens never go on a command line or in a file. Read them into the shell from your password
manager, for example with `read -rs`:

```sh
read -rs DIGITALOCEAN_TOKEN && export DIGITALOCEAN_TOKEN            # scoped API token
read -rs SPACES_ACCESS_KEY_ID && export SPACES_ACCESS_KEY_ID        # key from step 1
read -rs SPACES_SECRET_ACCESS_KEY && export SPACES_SECRET_ACCESS_KEY
read -rs AWS_ACCESS_KEY_ID && export AWS_ACCESS_KEY_ID              # state key from step 3
read -rs AWS_SECRET_ACCESS_KEY && export AWS_SECRET_ACCESS_KEY
read -rs TF_VAR_state_passphrase && export TF_VAR_state_passphrase  # 16+ characters

cd infra/tofu/digitalocean/envs/staging
cp terraform.tfvars.example terraform.tfvars   # fingerprints and your CIDRs
tofu init
tofu plan -out staging.tfplan                  # encrypted; ignored by git
tofu apply staging.tfplan
tofu output dns_records
```

The token needs the custom scopes for what the plan touches: droplet, firewall, vpc,
reserved_ip, block_storage, tag, project, ssh_key (read), regions and sizes (read) and
spaces_key; database at stage 1 and load_balancer at stage 2. Production is the same with
`envs/production`, after the region (ADR 0025) and size (S1-a) are decided.

## Adopting the staging droplet

`commonair-rc-test` was made by hand. **Recreate and restore** is the supported path, as ADR 0025
expects ("recreated from them"):

1. `tofu apply` in `envs/staging`. It creates `commonair-staging` next to the old droplet (the
   names do not collide) with its own firewall and reserved IP.
2. Install the current release candidate with `selfhost.sh install`, then restore the old
   host's latest base backup and objects, or start empty: staging data is disposable.
3. Point the staging A/AAAA records at `tofu output dns_records`; Caddy gets a new certificate.
4. Once it serves, delete `commonair-rc-test` and its hand-made firewall in the control panel.

Importing instead is possible but buys little. The definitions differ from the hand-made host in
attributes that force replacement (`vpc_uuid`: ours is a new VPC, the old droplet is in the
region's default one; `monitoring` if the agent was off), so a plan after import replaces the
droplet anyway. If you want the firewall's history kept, import it with blocks like these in a
scratch `imports.tf` in `envs/staging` (ids from `doctl compute droplet list` and
`doctl compute firewall list`), plan, and delete the file after apply:

```hcl
import {
  to = module.instance.digitalocean_droplet.app[0]
  id = "<droplet id>"
}

import {
  to = module.instance.digitalocean_firewall.app
  id = "<firewall id>"
}
```

The hand-made host has no reserved IP; if one is added by hand first, import it with
`to = module.instance.digitalocean_reserved_ip.app` and `id = "<ip>"`.

## Gaps in the provider and platform

- **Bucket-scoped Spaces keys work, with limits.** `digitalocean_spaces_key` takes `grant`
  blocks of `bucket` + `read`/`readwrite`/`fullaccess`. It cannot narrow to a prefix, a source
  address or write-without-delete, so a WAL-G key can delete backups. Versioning with a
  noncurrent-version expiry is the mitigation. The secret key is stored in state, hence state
  encryption.
- **Network load balancer: expressible.** `type = "REGIONAL_NETWORK"` exists, with `tcp` and
  `udp` forwarding rules and `network_stack = "DUALSTACK"`. Health checks are only `http`,
  `https` or `tcp`, so 443/udp has no health check of its own. Whether the droplets see client
  addresses for UDP as they do for TCP is for S1-f's rehearsal to confirm (ADR 0032 §5).
- **Reserved IPs cannot move to a load balancer.** The load balancer's `ip` accepts only a BYOIP
  address; DNS points at the load balancer at stage 2.
- **IPv6 is not reserved.** The AAAA record is the droplet's own IPv6 and changes if the droplet
  is recreated. `digitalocean_reserved_ipv6` exists but needs the address configured on the
  droplet by hand; not used yet.
- **Database firewalls have no VPC rule type** (and no IPv6), so they admit the app tag.
- **Spaces resources need Spaces keys, not the API token**: the provider reads
  `SPACES_ACCESS_KEY_ID` and `SPACES_SECRET_ACCESS_KEY`, and that key has to be full-access to
  create buckets.
- **S3 locking on Spaces.** `use_lockfile` relies on conditional writes; if Spaces rejects them,
  `plan` fails at the lock and the operator removes `use_lockfile` (one operator at a time).
- **The provider's `h1:` hashes in the lock files were computed from the release zips, not by
  `tofu providers lock`** (OpenTofu was not run while writing this). `tofu init -lockfile=readonly`
  fails on a mismatch, so the first `check.sh` run confirms them.
