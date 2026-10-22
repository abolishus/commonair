<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0024: Browser access to object storage on a self-hosted instance

- Status: accepted (2026-10-22)
- Date: 2026-10-22

## Context

Two features hand a browser a presigned S3 URL:

- avatar, banner and panel uploads: `channels.uploadUrl` presigns a `PUT` to
  `S3_BUCKET_MEDIA/incoming/<channel>/…` (ADR 0006 Q6; at most 10 MB, valid 10 minutes);
- data exports: the API and the export mail presign a `GET` of `S3_BUCKET_EXPORTS/<key>` with a
  `response-content-disposition`.

`@commonair/storage` builds those URLs path-style on `S3_PUBLIC_ENDPOINT` (falling back to
`S3_ENDPOINT`). A self-hosted instance (ADR 0023) never set it, and Caddy had no route to
Garage, so both URLs pointed at `http://garage:3900` and failed in every browser. Public media
reads already go through the origin's `/media` route (ADR 0009); this ADR is only about the
presigned writes and private downloads.

Constraints:

- A SigV4 presigned URL signs the host and the full path. Garage verifies against the `Host`
  header and path it receives.
- Caddy sends `Content-Security-Policy: … connect-src 'self'` on every page, and the upload is a
  `fetch` from the web app.
- Garage has no bucket or prefix policies (ADR 0009). The signature is the only authorization;
  the private prefixes (`incoming/`, `moderation/`, the evidence bucket) must not become readable.
- One-command install: no extra DNS record or certificate unless it buys something.

## Options

1. **A path prefix stripped by Caddy** (`https://<host>/s3/<bucket>/<key>` →
   `garage:3900/<bucket>/<key>`). The signed path includes `/s3`, Garage sees it without, and
   every signature fails. Rejected.
2. **A dedicated hostname** (`https://s3.<host>`, a second Caddy site proxying `garage:3900` with
   the `Host` header kept). Signatures verify. It needs a second DNS record and certificate, CORS
   on Garage for the upload, and a `connect-src` exception in the CSP. It also exposes the whole
   S3 API (list, multipart, every bucket) to the internet, guarded only by keys.
3. **The bucket path on the main host, unstripped**: `S3_PUBLIC_ENDPOINT=https://<host>`, so a
   presigned URL is `https://<host>/<bucket>/<key>?X-Amz-…`. Caddy forwards only the two
   presigned shapes to `garage:3900` with the path and `Host` unchanged; everything else under
   those paths falls through to the web app as before.
4. **Proxy the bytes through the API.** Every upload and export download would pass through a
   Bun service, and the storage port would gain a streaming code path. Rejected: more code, and
   the API would hold 10 MB bodies.

## Decision

Option 3.

- `selfhost.sh install` writes `S3_PUBLIC_ENDPOINT=https://<host>` (with `MEDIA_PUBLIC_URL` and
  the other public URLs). Upgrades backfill it into an existing env file when it is missing.
- Caddy (in the `PUBLIC_HOSTNAME` site, before the web fallback) proxies to `garage:3900`, with
  the `Host` header and path untouched, only:
  - `PUT /{$S3_BUCKET_MEDIA}/incoming/*` carrying an `X-Amz-Signature` query parameter, with the
    request body capped at the contract's 10 MB upload limit;
  - `GET` and `HEAD /{$S3_BUCKET_EXPORTS}/*` carrying an `X-Amz-Signature` query parameter.
- Every other method, bucket, prefix or unsigned request on those paths reaches the web app (a
  404), so the rest of the S3 API — listing, multipart, deletes, the media bucket's private
  prefixes, the evidence and backup buckets — stays unreachable from outside. The bucket names
  come from the instance env, so Caddy gets `S3_BUCKET_MEDIA` and `S3_BUCKET_EXPORTS`.
- The upload is same-origin, so no CORS configuration and no CSP change are needed.
- Development and compose keep `S3_PUBLIC_ENDPOINT=http://localhost:${GARAGE_S3_PORT}`; the
  compose `tls` profile documents setting it to `https://<host>` like a self-hosted instance.

## Consequences

- No new DNS record, certificate or install flag.
- A signed URL is still a bearer credential for one object and one method until it expires, as
  before; Caddy's allowlist only narrows what an unsigned or mis-scoped request can reach.
- Bucket names become path segments on the public host. A channel or page route equal to a
  bucket name is unaffected unless the request also carries `X-Amz-Signature`.
- An operator using an external S3 store with its own public endpoint sets `S3_PUBLIC_ENDPOINT`
  to it instead, and needs CORS on that store and a CSP `connect-src` for its origin.
- The self-host e2e proves both paths through Caddy and the internal CA: a presigned `PUT` into
  `incoming/` succeeds and an unsigned or out-of-prefix request is refused, and a presigned export
  `GET` returns the object.
