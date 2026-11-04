# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Uptime checks and the status page, in a second region (ADR 0025 decision 3): monitoring must
# outlive the droplet it watches. Its cloud-init installs the probes, the page and the outside-in
# alerts from infra/status (docs/operators/status-page.md), so a down app droplet still pages.

locals {
  status_src = "${path.module}/../../../../status"

  status_host   = var.instance_origin == null ? null : trimprefix(var.instance_origin, "https://")
  status_domain = coalesce(var.status_domain, local.status_host == null ? "status.invalid" : "status.${local.status_host}")

  # Without an origin there is nothing to probe: the droplet gets package updates only
  # (status-page.md, "Bringing it up"). No check block warns about it: the stage tests plan
  # without an origin, and a failed check fails a tofu test run.
  status_enabled = var.enable_monitoring_droplet && var.monitoring_cloud_init && var.instance_origin != null

  # render.ts validates this (parseConfig); names and the domain come from here, never literals.
  status_config = jsonencode({
    siteName        = var.status_site_name
    locale          = var.status_locale
    origin          = var.instance_origin
    statusDomain    = local.status_domain
    rtmp            = var.status_rtmp
    canaries        = var.status_canaries
    extraComponents = var.status_extra_components
  })

  status_files = local.status_enabled ? concat(
    [
      { path = "/etc/commonair-status/status.json", content = base64gzip(local.status_config) },
      { path = "/etc/commonair-status/caddy.env", content = base64gzip("STATUS_DOMAIN=${local.status_domain}\n") },
    ],
    [
      for f in ["render.ts", "blackbox.yml", "prometheus.yml", "rules.yml", "Caddyfile"] :
      { path = "/etc/commonair-status/${f}", content = base64gzip(file("${local.status_src}/${f}")) }
    ],
    [
      for f in sort(fileset("${local.status_src}/units", "*.{container,network,volume}")) :
      { path = "/etc/containers/systemd/${f}", content = base64gzip(file("${local.status_src}/units/${f}")) }
    ],
    [
      {
        path    = "/etc/systemd/system/commonair-status-render.timer"
        content = base64gzip(file("${local.status_src}/units/commonair-status-render.timer"))
      },
    ],
  ) : []

  monitoring_user_data = (
    local.status_enabled
    ? templatefile("${path.module}/monitoring-cloud-init.yaml.tftpl", { updates = var.cloud_init_updates, files = local.status_files })
    : (var.cloud_init_updates ? local.user_data : null)
  )
}

resource "digitalocean_droplet" "monitoring" {
  count = var.enable_monitoring_droplet ? 1 : 0

  name       = "${local.prefix}-monitoring"
  region     = var.monitoring_region
  size       = var.monitoring_size
  image      = var.droplet_image
  vpc_uuid   = one(digitalocean_vpc.monitoring[*].id)
  ipv6       = true
  monitoring = true
  ssh_keys   = var.ssh_key_fingerprints
  tags       = [for t in local.monitoring_tags : digitalocean_tag.this[t].name]
  user_data  = local.monitoring_user_data

  lifecycle {
    # A changed config means re-provisioning the droplet (`tofu apply -replace`): it holds no
    # state but probe history and the page's daily figures (docs/operators/status-page.md).
    ignore_changes = [ssh_keys, image, user_data]

    precondition {
      condition     = var.monitoring_region != null && var.monitoring_region != var.region
      error_message = "enable_monitoring_droplet needs monitoring_region, set to a region other than region (or set enable_monitoring_droplet = false)."
    }

    precondition {
      condition     = local.monitoring_user_data == null || length(coalesce(local.monitoring_user_data, "")) <= 65535
      error_message = "The monitoring droplet's cloud-init exceeds DigitalOcean's 64 KiB user data limit."
    }
  }
}
