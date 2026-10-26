# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Shared pieces: names, tags, the project, a VPC per region and the SSH key lookup.

locals {
  prefix = coalesce(var.name_prefix, "commonair-${var.environment}")

  # Firewalls and the database firewall select droplets by tag. The app tag carries the
  # environment so a staging droplet can never match production's database firewall.
  tag_all        = "commonair"
  tag_env        = "commonair-${var.environment}"
  tag_role_app   = "commonair-app"
  tag_app        = "commonair-${var.environment}-app"
  tag_monitoring = "commonair-${var.environment}-monitoring"

  app_tags        = [local.tag_all, local.tag_env, local.tag_role_app, local.tag_app]
  monitoring_tags = [local.tag_all, local.tag_env, local.tag_monitoring]

  stage2 = var.app_count > 1

  # Package updates and nothing else: user data is readable from inside the droplet, so it
  # never carries secrets. selfhost.sh creates the service user and installs the stack.
  user_data = <<-EOT
    #cloud-config
    package_update: true
    package_upgrade: true
  EOT
}

resource "digitalocean_tag" "this" {
  for_each = toset(distinct(concat(local.app_tags, local.monitoring_tags)))
  name     = each.value
}

resource "digitalocean_vpc" "app" {
  name        = "${local.prefix}-${var.region}"
  region      = var.region
  ip_range    = var.vpc_ip_range
  description = "CommonAir ${var.environment}: app droplets and managed databases"
}

# Gated on monitoring_region too, so a missing region reaches the monitoring droplet's
# precondition (a readable message) instead of a provider error on a VPC without a region.
resource "digitalocean_vpc" "monitoring" {
  count       = var.enable_monitoring_droplet && var.monitoring_region != null ? 1 : 0
  name        = "${local.prefix}-${var.monitoring_region}"
  region      = var.monitoring_region
  description = "CommonAir ${var.environment}: monitoring"
}

# Keys are uploaded once by each operator (`doctl compute ssh-key import`); tofu only looks them
# up, so no private or public key material lives in this repository or in state.
data "digitalocean_ssh_keys" "operators" {
  filter {
    key    = "fingerprint"
    values = var.ssh_key_fingerprints
  }

  lifecycle {
    postcondition {
      condition     = length(self.ssh_keys) == length(distinct(var.ssh_key_fingerprints))
      error_message = "Every fingerprint in ssh_key_fingerprints must match an SSH key already on the account."
    }
  }
}

resource "digitalocean_project" "this" {
  name        = local.prefix
  description = "CommonAir ${var.environment} (infra/tofu/digitalocean)"
  purpose     = "Web Application"
  environment = title(var.environment)

  resources = concat(
    digitalocean_droplet.app[*].urn,
    digitalocean_droplet.monitoring[*].urn,
    [digitalocean_reserved_ip.app.urn],
    digitalocean_volume.media[*].urn,
    [digitalocean_spaces_bucket.walg.urn, digitalocean_spaces_bucket.object_backups.urn],
    [for b in digitalocean_spaces_bucket.instance : b.urn],
    digitalocean_database_cluster.pg[*].urn,
    digitalocean_database_cluster.valkey[*].urn,
    digitalocean_loadbalancer.app[*].urn,
  )
}
