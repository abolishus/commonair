<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0033: SeaweedFS as the bundled object store (replaces Garage)

- Status: proposed; the maintainer answered the open questions on 2026-10-27 (see
  [Answers before phase 0](#answers-before-phase-0-2026-10-27)). Acceptance waits for the
  phase 0 gate.
- Date: 2026-10-27 (SeaweedFS facts checked on 2026-10-27, against its wiki and releases)

## Context

`selfhost.sh` runs Garage v2.4.1 on the host unless the operator points it at an external S3
store (`S3_MODE=external`, R0-b). Garage has worked, but three earlier decisions had to work around
features it does not have:

1. **No object lock, versioning or bucket policies** ([ADR 0006](0006-automated-moderation.md)
   Q4). A key gets only `read`, `write` and `owner`, and `write` includes delete and overwrite.
   Its object-lock pull request (#1479) was closed unmerged in 2026-09. So a compromised worker
   can delete large evidence objects. The daily hash check _detects_ that loss but cannot
   _prevent_ it. A media object deleted or overwritten by mistake also cannot be recovered on
   the host: the only remedy is the offsite rclone copy (R0-c), which may already have synced
   the deletion.
2. **No anonymous reads, no prefix policies** ([ADR 0009](0009-public-media-route.md)). Public
   media is served through a filtering proxy in the origin. That design is good on its own merits
   and stays.
3. **Signature is the only authorization** ([ADR 0024](0024-browser-object-storage-route.md)), so
   Caddy narrows the browser route to two presigned shapes. That also stays.

Point 1 is the reason for this ADR. On every store that supports it, the evidence guidance in
the operator guide already recommends Object Lock in COMPLIANCE mode plus a policy denying
delete to the app principal. Bundled installs, the default for self-hosters, cannot have it.

### SeaweedFS (checked 2026-10-27)

- **License:** Apache-2.0 (OSI, passes ADR 0002). Container images (`chrislusf/seaweedfs`) are
  signed with Cosign.
- **S3 surface (wiki "Amazon S3 API"):** SigV4 and presigned URLs, multipart (including
  `UploadPartCopy`), `ListObjectsV2`, CORS, versioning, Object Lock (retention and legal hold),
  and bucket policies. Not supported: replication, notifications, website hosting, lifecycle
  _transitions_.
- **Object Lock (wiki):** COMPLIANCE and GOVERNANCE modes and legal hold. It requires versioning
  and **can only be enabled when a bucket is created**.
- **Identities:** `Read`, `Write`, `List`, `Tagging` and `Admin`, scoped per bucket (`Write:bucket`),
  managed through an embedded IAM API or `weed shell`. The identity actions have **no separate
  delete action**. Bucket policies accept `Deny` with a principal, but the wiki does not say how
  a per-principal `Deny s3:DeleteObject` combines with an identity's `Write`. **Unverified;
  phase 0 must prove it.**
- **Releases are frequent:** 4.49, 4.50 and 4.51 shipped between 2026-10-23 and 2026-10-25. The
  newest release past our 7-day cooldown (ADR 0022) is **4.48** (2026-09-28). Fast churn means
  re-running the conformance suite on every bump.
- **Shape:** one `weed server -filer -s3` process runs master, volume, filer and S3 gateway on
  a single node. The filer keeps metadata in its own store (embedded LevelDB by default), so that
  store has to be backed up and restored with the data.

Other candidates were not evaluated in depth: MinIO's community edition has been scaled back by
its vendor (check its current state before reconsidering it), and Ceph RGW is far too heavy for
one host.

## Decision (proposed)

1. **SeaweedFS replaces Garage as the bundled store,** only if phase 0 proves every guarantee
   listed below. If phase 0 fails, this ADR is rejected or amended and Garage stays.
2. **On SeaweedFS, the evidence bucket is created with Object Lock in COMPLIANCE mode**, plus a
   policy denying the worker key `s3:DeleteObject*`, `s3:PutObjectRetention` and
   `s3:BypassGovernanceRetention`. ADR 0006 Q4's sentence "on Garage, loss of a large object by a
   compromised worker is detected, not prevented" no longer describes the default install. The
   append-only Postgres evidence table, the seal and the daily hash check all stay: the database is
   still the lowest layer for evidence (AGENTS.md non-negotiable 9), and external stores without
   lock still rely on them.
3. **Media, exports and backups buckets get versioning with a noncurrent-version expiry** (if
   the spike shows SeaweedFS expires noncurrent versions; otherwise versioning stays off and this
   point is dropped). That makes an accidental delete recoverable on the host.
4. **External S3 stays exactly as R0-b built it.** `S3_MODE` gains `seaweedfs`; `external`
   is unchanged.
5. **SeaweedFS replaces Garage outright, with no migration tool.** There are no self-hosted
   instances and no public instance yet; the only Garage deployment is our own staging droplet,
   which is reinstalled fresh (or copied by hand with `rclone sync` and `check`). Garage is
   deleted in the same change that makes SeaweedFS the bundled store.

## Plan

Each phase is one unit with its own brief, merged and verified before the next starts.

### Phase 0: proof (spike, nothing merged to the product)

A throwaway compose file and a conformance script (`infra/tests/s3-conformance.int.test.ts`, kept
afterwards to run against any store) run against SeaweedFS 4.48 under Podman. The script proves:

- everything in [object-storage.md](../self-hosting/object-storage.md) "What the store must
  support": SigV4 header and presigned, `Range`, `response-content-disposition`, multipart,
  `ListObjectsV2`, path style, CORS on the media bucket;
- the presigned PUT and GET through the real Caddy route with `Host` and path kept (ADR 0024);
- key scoping: the main key cannot list, get or put on evidence; the evidence key cannot touch
  other buckets (the same proof `stack.int.test.ts` makes for Garage);
- **the evidence guarantees:** COMPLIANCE retention blocks delete and overwrite for the evidence
  key and for an admin; a per-principal policy denies `DeleteObject` to the worker key while
  `PutObject` still works;
- versioning and, if supported, noncurrent-version expiry;
- WAL-G `backup-push`, `wal-push` and restore; `rclone sync` and `check` for R0-c's backup;
- a health check that works with the image as shipped (Garage's lack of a shell cost a whole e2e
  run, `562f8c9`);
- idle memory and disk footprint on the smallest droplet `requirements.md` allows, compared with
  Garage;
- backing up and restoring the filer metadata store together with the volumes.

**Gate:** all pass, results recorded in this ADR, and the maintainers accept it.

### Phase 1: SeaweedFS replaces Garage

One unit, merged only with the gate green:

- `infra/seaweedfs/`: its config, plus `storage-init` support for creating buckets (evidence with
  lock at creation), identities, policies and CORS through the IAM and S3 APIs. Same idempotent
  "creates or checks" behavior as Garage's, with unit tests against a fake API.
- `S3_MODE=seaweedfs` replaces `garage` in `selfhost.sh install` and local compose; the Caddy
  snippet `s3-seaweedfs` (`reverse_proxy seaweedfs:8333`, same two shapes), a Quadlet unit, the
  compose service, the image pinned by digest (`pin-images.ts`) and listed in
  `infra/image-licenses.json`, firewall and Prometheus scrape config.
- Garage's unit, config, image pin, license entry, Caddy snippet and tests are deleted; its tests
  are rewritten for SeaweedFS (bootstrap, CORS, Caddy S3 mode, quadlet, compose), and the phase 0
  conformance suite joins the gate.
- `selfhost.sh backup --objects` and `--restore-objects` cover the filer metadata.
- ADR 0006 Q4 and the operator guide's evidence section are amended per decision 2; docs
  (object-storage.md, backups.md) describe SeaweedFS only.

### Phase 2: staging

Staging is reinstalled fresh on a release candidate with SeaweedFS and run through the full
harness and the trust-safety scenario.

## Consequences

- The bundled install gets the evidence guarantee that ADR 0006 could only recommend for
  external stores, and accidental deletes become recoverable on the host.
- More moving parts than Garage: a filer metadata store to back up, more S3 surface to keep
  narrowed behind Caddy, and a release cadence that makes the cooldown and conformance suite do
  real work on every bump.
- Our own instance may never run it: ADR 0032 stage 1 moves our objects to Spaces. Until then
  staging and production run what self-hosters run, and the e2e variants keep it tested after.
  The parity rule (anything we run managed, `selfhost.sh` offers every operator) is unaffected.
- The phase 0 conformance suite outlives this decision: it becomes the documented way to check
  any external store against object-storage.md.

## Answers before phase 0 (2026-10-27)

- **Delete markers if a per-principal `Deny` does not work:** acceptable. With versioning and
  COMPLIANCE retention, a delete marker hides an object but cannot destroy the locked version,
  so evidence stays recoverable. The stack alerts on any delete marker in the evidence bucket.
- **Garage as a permanent option:** no. With no outside deployments there is no one to migrate,
  so the dual-backend phase, the migration tool and the deprecation window are dropped (decision
  5, phases 1 and 2). Two bundled stores would double the storage test matrix for little gain.
  Garage stays only as the fallback if phase 0 fails.
- **Priority:** run the phase 0 spike soon; it is cheap and decides the rest. Phase 1 lands after
  batch 3 and before L1: evidence that cannot be deleted matters before strangers can upload.

Still open:

- Evidence retention period under COMPLIANCE (ADR 0006 suggests at least one year; legal review
  per jurisdiction, on the L1 counsel list).

Sources (2026-10-27): SeaweedFS wiki pages "Amazon S3 API", "S3 Object Lock and Retention",
"S3 Configuration" and "S3 Bucket Policies"; SeaweedFS GitHub releases (4.46–4.51) and LICENSE;
Docker Hub `chrislusf/seaweedfs` tags; Garage PR #1479 as recorded in ADR 0006 Q4.
