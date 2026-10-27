<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Object storage

CommonAir keeps four kinds of objects in S3 buckets: public media (avatars, panels, thumbnails,
clips, VODs), members' data exports, WAL-G's Postgres backups, and sealed moderation evidence.
By default they live in [Garage](https://garagehq.deuxfleurs.fr/), which `selfhost.sh` runs on
the same host. That needs nothing from you, but the objects share the server's disk: if the disk
dies, they go with it, unless you copy them off the server with `selfhost.sh backup --objects`
([backups.md](backups.md#objects)).

Instead, `install` can point the instance at any S3-compatible store: DigitalOcean Spaces, AWS
S3, Hetzner Object Storage, MinIO, a Garage cluster on other hosts. No provider is special-cased;
the requirements below are all that matters. Then no Garage runs on the host at all.

Choose at the first install. An instance never switches store: `install` refuses `--s3-*` on an
instance that uses Garage, because nothing would move the objects already stored. To move one,
copy all its buckets with rclone by hand (as in [backups.md](backups.md#without-the-script)) and
install a new instance against the new store.

## What the store must support

- **The S3 API with Signature Version 4**, both as an `Authorization` header (the services and
  WAL-G) and in presigned URLs (`X-Amz-Signature` in the query, which browsers use).
- **Object operations**: `PutObject`, `GetObject` (with `Range`, and the
  `response-content-disposition` override, which export downloads use for their file name),
  `HeadObject`, `DeleteObject` and `ListObjectsV2`. WAL-G also uploads large files with
  **multipart uploads**.
- **Path-style** (`https://<endpoint>/<bucket>/<key>`) or **virtual-hosted** URLs
  (`https://<bucket>.<endpoint>/<key>`), whichever the store supports: `--s3-path-style true`
  or `false`.
- **CORS on the media bucket**: browsers upload avatars and the like straight to the store with
  presigned `PUT`s from your instance's origin. Export downloads are plain links and need no
  CORS.
- **HTTPS.** `install` refuses an `http://` endpoint unless you pass `--s3-allow-http`, meant for
  a store on a trusted LAN or a test host.

Nothing else is used: no bucket policies, no ACLs (every object is private), no server-side
encryption settings, no lifecycle rules, no object lock, no public buckets. Public media reaches
browsers through the instance's own `/media` route, not from the store.

## Buckets and keys

Create four private buckets. Their names are yours; the defaults are below.

| Bucket   | Flag                   | Default              | Holds                                       |
| -------- | ---------------------- | -------------------- | ------------------------------------------- |
| media    | `--s3-bucket-media`    | `commonair-media`    | public media and moderation frames          |
| exports  | `--s3-bucket-exports`  | `commonair-exports`  | members' data exports (presigned downloads) |
| backups  | `--s3-bucket-backups`  | `commonair-backups`  | WAL-G's Postgres backups, under `wal/`      |
| evidence | `--s3-bucket-evidence` | `commonair-evidence` | sealed moderation evidence                  |

Bucket names are often global to a provider or a region: pick ones tied to your instance, such
as `stream-example-org-media`.

Create **two keys**, as narrow as the store allows:

- the **main key** (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`): read, write, list and delete on
  media, exports and backups, and nothing on evidence. The API, media, origin and worker
  services and WAL-G use it.
- the **evidence key** (`S3_EVIDENCE_ACCESS_KEY_ID`, `S3_EVIDENCE_SECRET_ACCESS_KEY`): read,
  write, list and delete on the evidence bucket only. Only the worker holds it. Services that
  hold the main key must not even list the evidence (ADR 0006).

If your store cannot limit a key to some buckets, the instance still works, but anyone who gets
the main key can read the evidence too. `commonair-storage-init` warns about it on every start.

CORS on the media bucket allows `PUT` (and `GET`) from `https://<your domain>`, with any request
header. In the S3 API's XML (`PutBucketCors`, or your provider's console):

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://stream.example.org</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

## Install against it

The keys never go on the command line, where every user on the host can read them. Run
`install` from a terminal and it asks for each key it is missing (secrets without echo), or
export them in its environment first. In bash, `read -rs NAME && export NAME` reads one
without showing it or keeping it in the shell history. Then:

```sh
sh selfhost.sh install --version vX.Y.Z --domain stream.example.org --email ops@example.org \
  --s3-endpoint https://s3.example.net --s3-region eu-central-1 --s3-path-style false \
  --s3-bucket-media stream-example-org-media --s3-bucket-exports stream-example-org-exports \
  --s3-bucket-backups stream-example-org-backups --s3-bucket-evidence stream-example-org-evidence
```

As root on a fresh server (`--yes`), the keys pass through to the `commonair` user's run in the
environment, as the flags do on its command line.

`install` writes the store's settings and the keys to `~/.config/commonair/commonair.env` (mode
0600), with `S3_MODE=external`, and installs every unit but Garage's. Before any service starts,
`commonair-storage-init` writes, reads back and deletes a small object under
`.commonair-storage-check/` in each bucket, with the key that uses it. If a bucket is missing or a
key may not use it, the unit fails, the services do not start, and the journal says what to fix:

```sh
journalctl --user -u commonair-storage-init
```

The unit retries six times an hour, then fails for good, and the services that need it fail
with it. Fix it at the store, then run `sh ~/commonair/selfhost.sh install --reinstall`: it
clears the failed state, starts the stack again and waits for it to be healthy.

`--s3-public-endpoint` is where browsers reach the store, if not at `--s3-endpoint` (a CDN
hostname in front of it, say). The presigned URLs use it.

### The page's Content-Security-Policy

Uploads go from the browser to the store's origin, so Caddy's `Content-Security-Policy` allows
that origin in `connect-src`. `install` works it out (`S3_CONNECT_SRC` in the env file): the
public endpoint with path-style URLs, or `https://<media bucket>.<public endpoint host>` with
virtual-hosted ones.

### Afterwards

- `sh ~/commonair/selfhost.sh status` shows the store and lists each bucket with the instance's
  keys (it prints no key).
- `install --reinstall` keeps the store's settings and keys unless you pass a flag or a key pair
  again. That is how you rotate a key: create the new one at the store, export it, reinstall,
  then delete the old one. It refuses a different `--s3-endpoint` or bucket name, which would
  leave the objects already stored behind; copy them first and install a new instance instead.
- `upgrade` keeps the store as it is and takes no `--s3-*` flag.
- WAL-G writes to the backups bucket of the same store. To keep backups in another region or
  provider, set `AWS_*` and `WALG_S3_PREFIX` as [backups.md](backups.md#off-host-s3) describes;
  `commonair-storage-init` then skips the backups bucket.

## DigitalOcean Spaces

A worked example, for an instance at `stream.example.org` on a droplet in Amsterdam, with its
objects in Spaces in the same region.

1. **Buckets.** In the control panel, create four Spaces buckets in `AMS3`, with file listing
   restricted and no CDN: `stream-example-org-media`, `-exports`, `-backups` and `-evidence`.
   Other Spaces users share the namespace, so names tied to your instance avoid clashes.
2. **Keys.** Under Spaces Object Storage, Access Keys, create two keys with limited access:
   one with read, write and delete on the media, exports and backups buckets; another with read,
   write and delete on the evidence bucket only. Each secret is shown once.
3. **CORS.** In the media bucket's settings, add a CORS rule: origin
   `https://stream.example.org`, methods `PUT` and `GET`, allowed header `*`, max age 3600.
   Spaces keeps CORS per bucket; the other three need none.
4. **Install.**

   ```sh
   sh selfhost.sh install --version vX.Y.Z --domain stream.example.org --email ops@example.org \
     --s3-endpoint https://ams3.digitaloceanspaces.com --s3-region ams3 --s3-path-style false \
     --s3-bucket-media stream-example-org-media --s3-bucket-exports stream-example-org-exports \
     --s3-bucket-backups stream-example-org-backups --s3-bucket-evidence stream-example-org-evidence
   ```

   The endpoint is `https://<region>.digitaloceanspaces.com` and the region its slug (`nyc3`,
   `sfo3`, `ams3`, `fra1`, `sgp1`, `syd1`, ...). With `--s3-path-style false`, presigned URLs
   look like `https://stream-example-org-media.ams3.digitaloceanspaces.com/...`, which is also
   what `install` allows in the page's `connect-src`.

What to know about Spaces:

- It supports only the `private` and `public-read` canned ACLs. CommonAir sets no ACL, so every
  object is private.
- Its only server-side encryption is SSE-C (keys supplied with each request), which CommonAir
  does not use. The evidence is sealed before it is stored. `selfhost.sh backup --objects` does
  not encrypt its copy; a copy by hand through an rclone crypt remote can
  ([backups.md](backups.md#without-the-script)).
- A droplet that resolves the Spaces endpoint through the VPC's resolver reaches Spaces over
  DigitalOcean's internal network, and that transfer is not billed. Check the droplet's resolver
  (`resolvectl status`) if you rely on it.
- Keep backups in another region: set `AWS_*` and `WALG_S3_PREFIX` for a bucket in, say,
  `fra1` ([backups.md](backups.md#off-host-s3)), and copy the media and evidence there with
  `selfhost.sh backup --objects` ([backups.md](backups.md#set-it-up-digitalocean-spaces)).
- Turn on versioning, with an expiry rule, on the instance's buckets, the offsite one, or both:
  it is what brings back objects deleted or overwritten by mistake
  ([backups.md](backups.md#guards-against-emptying-the-copy)).

## Other stores

- **AWS S3**: endpoint `https://s3.<region>.amazonaws.com`, region as in its name, path style
  `false`. Limit each key with an IAM policy on its buckets (`s3:GetObject`, `s3:PutObject`,
  `s3:DeleteObject`, `s3:ListBucket`, and the multipart actions for backups).
- **Hetzner Object Storage**: endpoint `https://<location>.your-objectstorage.com`, region the
  location (`fsn1`, `nbg1`, `hel1`), path style `true` or `false`.
- **MinIO or a Garage cluster** you run elsewhere: its endpoint and region (`garage` for Garage
  unless you changed `s3_region`), path style `true`. Over plain HTTP on a LAN, add
  `--s3-allow-http`.

Check the endpoint form against your provider's documentation; these change more often than
the S3 API does.
