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

run "bad_extra_component_is_rejected" {
  command = plan

  variables {
    status_extra_components = [{ id = "Relay", name = "Relay", module = "icmp", target = "relay.example.org" }]
  }

  expect_failures = [var.status_extra_components]
}
