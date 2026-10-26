# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Off-host backups (docs/deploy/digitalocean.md §4): WAL-G and object backups in Spaces in a
# region other than the droplet's. Private and CDN off. Versioning recovers from an accidental
# overwrite or delete by the backup tools; it does not stop a stolen readwrite key, which can
# delete noncurrent versions too (README, "Gaps": residual risk and the options).

locals {
  backup_buckets = {
    walg           = "${local.prefix}-walg"
    object_backups = "${local.prefix}-object-backups"
  }
}

resource "digitalocean_spaces_bucket" "walg" {
  name   = local.backup_buckets.walg
  region = var.backup_region
  acl    = "private"

  versioning {
    enabled = true
  }

  # A rule with only the abort action is unconfirmed on Spaces: if the first apply rejects it,
  # move abort_incomplete_multipart_upload_days into expire-noncurrent (README, "Gaps").
  lifecycle_rule {
    id                                     = "abort-incomplete-multipart"
    enabled                                = true
    abort_incomplete_multipart_upload_days = var.multipart_abort_days
  }

  lifecycle_rule {
    id      = "expire-noncurrent"
    enabled = true
    noncurrent_version_expiration {
      days = var.backup_noncurrent_days
    }
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.backup_region != var.region
      error_message = "backup_region must differ from region: a backup in the droplet's region is not a backup."
    }
  }
}

resource "digitalocean_spaces_bucket" "object_backups" {
  name   = local.backup_buckets.object_backups
  region = var.backup_region
  acl    = "private"

  versioning {
    enabled = true
  }

  # A rule with only the abort action is unconfirmed on Spaces: if the first apply rejects it,
  # move abort_incomplete_multipart_upload_days into expire-noncurrent (README, "Gaps").
  lifecycle_rule {
    id                                     = "abort-incomplete-multipart"
    enabled                                = true
    abort_incomplete_multipart_upload_days = var.multipart_abort_days
  }

  lifecycle_rule {
    id      = "expire-noncurrent"
    enabled = true
    noncurrent_version_expiration {
      days = var.backup_noncurrent_days
    }
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.backup_region != var.region
      error_message = "backup_region must differ from region: a backup in the droplet's region is not a backup."
    }
  }
}

# One key per bucket, readwrite on that bucket only. Spaces grants are per bucket: they cannot
# narrow to a prefix, a source address or write-without-delete (see README, "Gaps").
resource "digitalocean_spaces_key" "walg" {
  name = "${local.prefix}-walg"

  grant {
    bucket     = digitalocean_spaces_bucket.walg.name
    permission = "readwrite"
  }
}

resource "digitalocean_spaces_key" "object_backups" {
  name = "${local.prefix}-object-backups"

  grant {
    bucket     = digitalocean_spaces_bucket.object_backups.name
    permission = "readwrite"
  }
}
