# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Uptime checks and the status page, in a second region (ADR 0025 decision 3): monitoring must
# outlive the droplet it watches.

resource "digitalocean_droplet" "monitoring" {
  count = var.enable_monitoring_droplet ? 1 : 0

  name       = "${local.prefix}-monitoring"
  region     = var.monitoring_region
  size       = var.monitoring_size
  image      = var.droplet_image
  vpc_uuid   = digitalocean_vpc.monitoring[0].id
  ipv6       = true
  monitoring = true
  ssh_keys   = var.ssh_key_fingerprints
  tags       = [for t in local.monitoring_tags : digitalocean_tag.this[t].name]
  user_data  = var.cloud_init_updates ? local.user_data : null

  lifecycle {
    ignore_changes = [ssh_keys, image, user_data]

    precondition {
      condition     = var.monitoring_region != null && var.monitoring_region != var.region
      error_message = "monitoring_region must be set and differ from region."
    }
  }
}
