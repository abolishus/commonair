# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Stage 1 (ADR 0032): Postgres and Valkey off the host, each with one standby, reachable only
# from the app droplets over the VPC; the instance's objects in Spaces.
#
# Tofu creates the clusters only. The non-owner app role comes from the app's migrations
# (infra/postgres/app-role.sql), run by selfhost.sh with the doadmin owner role.

locals {
  managed = var.enable_managed_state ? 1 : 0

  instance_buckets = var.enable_managed_state ? {
    media    = "${local.prefix}-media"
    exports  = "${local.prefix}-exports"
    evidence = "${local.prefix}-evidence"
  } : {}
}

resource "digitalocean_database_cluster" "pg" {
  count = local.managed

  name                 = "${local.prefix}-pg"
  engine               = "pg"
  version              = var.pg_version
  size                 = var.pg_size
  region               = var.region
  node_count           = 2 # primary + one standby: 99.95% SLA, failover in 5-10 s
  private_network_uuid = digitalocean_vpc.app.id
  tags                 = [digitalocean_tag.this[local.tag_all].name, digitalocean_tag.this[local.tag_env].name]
}

resource "digitalocean_database_firewall" "pg" {
  count      = local.managed
  cluster_id = digitalocean_database_cluster.pg[0].id

  # Database firewalls have no VPC rule type; the environment's app tag is the narrowest
  # selector that still follows droplets as stage 2 adds them.
  rule {
    type  = "tag"
    value = digitalocean_tag.this[local.tag_app].name
  }
}

resource "digitalocean_database_cluster" "valkey" {
  count = local.managed

  name                 = "${local.prefix}-valkey"
  engine               = "valkey"
  version              = var.valkey_version
  size                 = var.valkey_size
  region               = var.region
  node_count           = 2 # primary + one standby
  private_network_uuid = digitalocean_vpc.app.id
  tags                 = [digitalocean_tag.this[local.tag_all].name, digitalocean_tag.this[local.tag_env].name]
}

resource "digitalocean_database_valkey_config" "valkey" {
  count      = local.managed
  cluster_id = digitalocean_database_cluster.valkey[0].id

  # BullMQ requires noeviction; persistence keeps queued jobs across a restart (ADR 0032 §3).
  valkey_maxmemory_policy = "noeviction"
  persistence             = "rdb"
  ssl                     = true
}

resource "digitalocean_database_firewall" "valkey" {
  count      = local.managed
  cluster_id = digitalocean_database_cluster.valkey[0].id

  rule {
    type  = "tag"
    value = digitalocean_tag.this[local.tag_app].name
  }
}

# Media, exports and evidence (R0-b). Same region as the app, so traffic stays unbilled
# through the VPC resolver.
resource "digitalocean_spaces_bucket" "instance" {
  for_each = local.instance_buckets

  name   = each.value
  region = var.region
  acl    = "private"

  lifecycle_rule {
    id                                     = "abort-incomplete-multipart"
    enabled                                = true
    abort_incomplete_multipart_upload_days = var.multipart_abort_days
  }

  lifecycle {
    precondition {
      condition     = var.instance_origin != null
      error_message = "enable_managed_state needs instance_origin for the media bucket's CORS."
    }
  }
}

# Browsers upload and fetch media with presigned PUT and GET from the instance's origin.
resource "digitalocean_spaces_bucket_cors_configuration" "media" {
  count = local.managed

  bucket = digitalocean_spaces_bucket.instance["media"].name
  region = var.region

  cors_rule {
    id              = "instance-origin"
    allowed_origins = [var.instance_origin]
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "digitalocean_spaces_key" "instance" {
  count = local.managed
  name  = "${local.prefix}-instance"

  dynamic "grant" {
    for_each = local.instance_buckets
    content {
      bucket     = digitalocean_spaces_bucket.instance[grant.key].name
      permission = "readwrite"
    }
  }
}
