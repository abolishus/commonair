# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# The monitoring droplet's cloud-init (monitoring.tf, infra/status) with a mocked provider.

mock_provider "digitalocean" {
  mock_resource "digitalocean_droplet" {
    defaults = {
      id = "100001"
    }
  }
  mock_resource "digitalocean_reserved_ip" {
    defaults = {
      ip_address = "192.0.2.10"
    }
  }
  mock_data "digitalocean_ssh_keys" {
    defaults = {
      ssh_keys = [{
        id          = 1
        name        = "operator"
        public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMock operator"
        fingerprint = "3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa"
      }]
    }
  }
}

variables {
  environment          = "production"
  region               = "nyc3"
  backup_region        = "ams3"
  monitoring_region    = "fra1"
  droplet_size         = "g-4vcpu-16gb"
  instance_origin      = "https://stream.example.org"
  ssh_key_fingerprints = ["3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa"]
  operator_cidrs       = ["203.0.113.7/32"]
}

run "status_cloud_init_installs_the_stack" {
  command = plan

  assert {
    condition     = startswith(local.monitoring_user_data, "#cloud-config\n")
    error_message = "The user data is cloud-config."
  }

  assert {
    condition     = strcontains(local.monitoring_user_data, "  - podman\n") && strcontains(local.monitoring_user_data, "commonair-status-render.timer")
    error_message = "Cloud-init installs Podman and enables the renderer's timer."
  }

  assert {
    condition = toset([for f in local.status_files : f.path]) == toset([
      "/etc/commonair-status/status.json",
      "/etc/commonair-status/caddy.env",
      "/etc/commonair-status/render.ts",
      "/etc/commonair-status/blackbox.yml",
      "/etc/commonair-status/prometheus.yml",
      "/etc/commonair-status/rules.yml",
      "/etc/commonair-status/Caddyfile",
      "/etc/containers/systemd/commonair-status.network",
      "/etc/containers/systemd/commonair-status-prometheus.volume",
      "/etc/containers/systemd/commonair-status-caddy.volume",
      "/etc/containers/systemd/commonair-status-blackbox.container",
      "/etc/containers/systemd/commonair-status-prometheus.container",
      "/etc/containers/systemd/commonair-status-caddy.container",
      "/etc/containers/systemd/commonair-status-render.container",
      "/etc/systemd/system/commonair-status-render.timer",
    ])
    error_message = "Cloud-init writes the renderer, the configs and every unit from infra/status."
  }

  assert {
    condition     = jsondecode(local.status_config).origin == "https://stream.example.org" && jsondecode(local.status_config).statusDomain == "status.stream.example.org"
    error_message = "The status page probes instance_origin and defaults to status.<host>."
  }

  assert {
    condition     = jsondecode(local.status_config).siteName == null && jsondecode(local.status_config).locale == "en"
    error_message = "No name literal: with status_site_name unset the page shows the origin's host; the page is English by default."
  }

  assert {
    condition     = jsondecode(local.status_config).canaries == ["9.9.9.9:53", "1.1.1.1:53"]
    error_message = "The blind-monitor canaries default to two anycast resolvers."
  }

  assert {
    condition     = !strcontains(local.monitoring_user_data, "SMTP_PASSWORD") && !strcontains(local.monitoring_user_data, "alert.env")
    error_message = "No alert credential, and no alert.env, is in user data (it is placed over SSH)."
  }

  assert {
    condition     = length(local.monitoring_user_data) <= 65535
    error_message = "The user data fits DigitalOcean's 64 KiB limit."
  }

  assert {
    condition     = strcontains(local.monitoring_user_data, "package_upgrade: true")
    error_message = "cloud_init_updates still applies package updates on first boot."
  }

  assert {
    condition     = output.status_page_url == "https://status.stream.example.org"
    error_message = "status_page_url is the status page's origin, for STATUS_PAGE_URL."
  }
}

run "status_state_survives_the_droplet" {
  command = plan

  assert {
    condition = (
      length(digitalocean_volume.status_state) == 1 &&
      digitalocean_volume.status_state[0].region == "fra1" &&
      digitalocean_volume.status_state[0].size == 1 &&
      digitalocean_volume.status_state[0].initial_filesystem_type == "ext4" &&
      digitalocean_volume.status_state[0].name == "commonair-production-status-state"
    )
    error_message = "A 1 GiB ext4 volume in the monitoring region holds the status page's state."
  }

  assert {
    condition     = strcontains(local.monitoring_user_data, "mounts:\n  - [\"/dev/disk/by-id/scsi-0DO_Volume_commonair-production-status-state\", \"/var/lib/commonair-status\", \"ext4\", \"defaults,nofail,discard,noatime\", \"0\", \"2\"]\n")
    error_message = "Cloud-init mounts the volume at /var/lib/commonair-status, nofail."
  }

  assert {
    condition     = strcontains(local.monitoring_user_data, "mounts:") && strcontains(local.monitoring_user_data, "runcmd:") && index(split("\n", local.monitoring_user_data), "mounts:") < index(split("\n", local.monitoring_user_data), "runcmd:")
    error_message = "The mount comes before runcmd creates the directories."
  }

  assert {
    condition     = can(yamldecode(local.monitoring_user_data))
    error_message = "The user data is valid YAML with the mount."
  }
}

run "status_state_volume_is_attached_at_creation" {
  command = plan

  # The volume's id is known only once it exists; the plan shows one attachment.
  assert {
    condition     = length(digitalocean_droplet.monitoring[0].volume_ids) == 1
    error_message = "The monitoring droplet is created with the state volume attached, so cloud-init's mount finds it."
  }

  assert {
    condition     = toset(digitalocean_volume.status_state[0].tags) == toset(digitalocean_droplet.monitoring[0].tags)
    error_message = "The volume carries the monitoring droplet's tags."
  }
}

run "status_state_volume_in_the_app_region_is_rejected" {
  command = plan

  variables {
    monitoring_region = "nyc3"
  }

  # The volume checks the region as the droplet does. It is planned first (the droplet attaches
  # it), so a plan with the status stack stops there, before a volume is ever created.
  expect_failures = [digitalocean_volume.status_state]
}

run "status_state_volume_can_be_turned_off" {
  command = plan

  variables {
    monitoring_state_volume = false
  }

  assert {
    condition     = length(digitalocean_volume.status_state) == 0 && !strcontains(local.monitoring_user_data, "mounts:")
    error_message = "monitoring_state_volume = false: no volume and no mount."
  }

  assert {
    condition     = length(digitalocean_droplet.monitoring[0].volume_ids) == 0 && can(yamldecode(local.monitoring_user_data))
    error_message = "Without the volume nothing is attached, and the user data is still valid YAML."
  }
}

run "status_domain_override" {
  command = plan

  variables {
    status_domain = "status.example.net"
    status_rtmp   = "ingest.example.org:1935"
  }

  assert {
    condition     = jsondecode(local.status_config).statusDomain == "status.example.net" && jsondecode(local.status_config).rtmp == "ingest.example.org:1935"
    error_message = "status_domain and status_rtmp reach status.json."
  }
}

run "no_origin_means_updates_only" {
  command = plan

  variables {
    instance_origin = null
  }

  assert {
    condition     = digitalocean_droplet.monitoring[0].user_data != null && local.monitoring_user_data == local.user_data && length(local.status_files) == 0
    error_message = "Without instance_origin the monitoring droplet gets the package-updates user data only."
  }

  assert {
    condition     = length(digitalocean_volume.status_state) == 0 && output.status_page_url == null
    error_message = "Without the status stack there is no state volume and no status_page_url."
  }
}

run "status_cloud_init_can_be_turned_off" {
  command = plan

  variables {
    monitoring_cloud_init = false
    cloud_init_updates    = false
  }

  assert {
    condition     = local.monitoring_user_data == null
    error_message = "monitoring_cloud_init = false with cloud_init_updates = false passes no user data."
  }
}

run "status_name_and_locale" {
  command = plan

  variables {
    status_site_name = "Example Streams"
    status_locale    = "es"
  }

  assert {
    condition     = jsondecode(local.status_config).siteName == "Example Streams" && jsondecode(local.status_config).locale == "es"
    error_message = "status_site_name and status_locale reach status.json."
  }
}

run "bad_status_locale_is_rejected" {
  command = plan

  variables {
    status_locale = "fr"
  }

  expect_failures = [var.status_locale]
}

run "bad_extra_component_is_rejected" {
  command = plan

  variables {
    status_extra_components = [{ id = "Relay", name = "Relay", module = "icmp", target = "relay.example.org" }]
  }

  expect_failures = [var.status_extra_components]
}
