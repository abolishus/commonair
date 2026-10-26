# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Stage 0 runs the whole stack on app[0]. Stage 2 adds app[1..] behind the load balancer
# (app_tier.tf). Everything after first boot is `selfhost.sh install` over SSH.

resource "digitalocean_droplet" "app" {
  count = var.app_count

  # app[0] keeps the stage 0/1 name at every stage, so raising app_count never renames the
  # host that runs the stack; only the droplets stage 2 adds get a suffix.
  name       = count.index == 0 ? local.prefix : "${local.prefix}-app-${count.index + 1}"
  region     = var.region
  size       = var.droplet_size
  image      = var.droplet_image
  vpc_uuid   = digitalocean_vpc.app.id
  ipv6       = true
  monitoring = true
  ssh_keys   = var.ssh_key_fingerprints
  tags       = [for t in local.app_tags : digitalocean_tag.this[t].name]
  user_data  = var.cloud_init_updates ? local.user_data : null

  graceful_shutdown = true

  lifecycle {
    # Operators manage their own keys in authorized_keys after first boot (deploy guide, §3),
    # image slugs move with point releases, and user data only matters at creation: none of
    # these should ever replace a running host.
    ignore_changes = [ssh_keys, image, user_data]

    precondition {
      condition     = !local.stage2 || var.enable_managed_state
      error_message = "app_count > 1 (stage 2) needs enable_managed_state (stage 1): app droplets cannot share an on-host Postgres."
    }
  }
}

# The stable IPv4 for DNS at stages 0 and 1. At stage 2 DNS points at the load balancer instead
# (a reserved IP can only be assigned to a droplet), and this stays on app[0] for SSH and ICE.
resource "digitalocean_reserved_ip" "app" {
  region = var.region
}

resource "digitalocean_reserved_ip_assignment" "app" {
  ip_address = digitalocean_reserved_ip.app.ip_address
  droplet_id = digitalocean_droplet.app[0].id
}

resource "digitalocean_volume" "media" {
  count = var.media_volume_size_gb > 0 ? 1 : 0

  name                    = "${local.prefix}-media-work"
  region                  = var.region
  size                    = var.media_volume_size_gb
  initial_filesystem_type = "ext4"
  description             = "MEDIA_WORK_DIR_* scratch space (VOD recording)"
  tags                    = [digitalocean_tag.this[local.tag_all].name, digitalocean_tag.this[local.tag_env].name]
}

resource "digitalocean_volume_attachment" "media" {
  count      = var.media_volume_size_gb > 0 ? 1 : 0
  droplet_id = digitalocean_droplet.app[0].id
  volume_id  = digitalocean_volume.media[0].id
}
